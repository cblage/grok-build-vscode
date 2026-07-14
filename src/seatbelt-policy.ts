import os from "node:os";
import { posix as path } from "node:path";

export const SEATBELT_BUILTIN_PROFILES = [
  "off",
  "workspace",
  "read-only",
  "strict",
] as const;

export type SeatbeltBuiltinProfile = (typeof SEATBELT_BUILTIN_PROFILES)[number];

export interface SandboxProfileDefinition {
  name: string;
  extends?: string;
  restrictNetwork?: boolean;
  readOnly: string[];
  readWrite: string[];
  deny: string[];
}

export interface SandboxProfileSources {
  globalSandbox?: string;
  projectSandbox?: string;
}

export interface ResolvedSandboxProfile {
  name: string;
  builtin: SeatbeltBuiltinProfile;
  lineage: string[];
  restrictNetwork: boolean;
  readOnly: string[];
  readWrite: string[];
  deny: string[];
}

export interface SeatbeltPolicyContext {
  cwd: string;
  home?: string;
  grokHome?: string;
  tempDir?: string;
  runtimeReadPaths?: string[];
  systemReadPaths?: string[];
}

export interface CompiledSeatbeltPolicy {
  policy: string;
  profile: ResolvedSandboxProfile;
  readPaths: string[];
  writePaths: string[];
  deniedPaths: string[];
  deniedGlobs: string[];
  networkRestrictionApplied: boolean;
}

export class SandboxProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxProfileError";
  }
}

const BUILTIN_SET = new Set<string>(SEATBELT_BUILTIN_PROFILES);

const BUILTIN_NETWORK: Record<SeatbeltBuiltinProfile, boolean> = {
  off: false,
  workspace: false,
  "read-only": true,
  strict: true,
};

const DEFAULT_SYSTEM_READ_PATHS = [
  "/System",
  "/Library",
  "/usr",
  "/bin",
  "/sbin",
  "/opt",
  "/dev",
  "/private/etc",
  "/private/var/db",
  "/private/var/run",
];

function stripTomlComment(line: string): string {
  let quote: "\"" | "'" | undefined;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote === "\"") {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
    } else if (quote === "'") {
      if (char === quote) quote = undefined;
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function bracketDepth(value: string): number {
  let depth = 0;
  let quote: "\"" | "'" | undefined;
  let escaped = false;
  for (const char of value) {
    if (quote === "\"") {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (quote === "'") {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
    }
  }
  return depth;
}

function parseTomlString(value: string, context: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      throw new SandboxProfileError(`Invalid string for ${context}`);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  throw new SandboxProfileError(`${context} must be a quoted string`);
}

function parseTomlStringArray(value: string, context: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new SandboxProfileError(`${context} must be an array of strings`);
  }
  const body = trimmed.slice(1, -1);
  const values: string[] = [];
  let i = 0;
  const skipWhitespace = () => {
    while (i < body.length && /\s/.test(body[i])) i += 1;
  };
  skipWhitespace();
  while (i < body.length) {
    const quote = body[i];
    if (quote !== "\"" && quote !== "'") {
      throw new SandboxProfileError(`${context} must contain only quoted strings`);
    }
    const start = i;
    i += 1;
    let escaped = false;
    while (i < body.length) {
      const char = body[i];
      if (quote === "\"" && !escaped && char === "\\") {
        escaped = true;
        i += 1;
        continue;
      }
      if (!escaped && char === quote) break;
      escaped = false;
      i += 1;
    }
    if (i >= body.length) {
      throw new SandboxProfileError(`Unterminated string in ${context}`);
    }
    i += 1;
    values.push(parseTomlString(body.slice(start, i), context));
    skipWhitespace();
    if (i >= body.length) break;
    if (body[i] !== ",") {
      throw new SandboxProfileError(`Expected a comma in ${context}`);
    }
    i += 1;
    skipWhitespace();
    // TOML permits one trailing comma, but never a leading or doubled comma.
    if (i < body.length && body[i] === ",") {
      throw new SandboxProfileError(`Unexpected comma in ${context}`);
    }
  }
  return values;
}

function parseProfileName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new SandboxProfileError("Sandbox profile name cannot be empty");
  if (trimmed.startsWith("\"") || trimmed.startsWith("'")) {
    return parseTomlString(trimmed, "sandbox profile name").trim();
  }
  return trimmed;
}

/** Parse the `[profiles.<name>]` tables from one `sandbox.toml` body. */
export function parseSandboxProfiles(
  toml: string,
  source = "sandbox.toml",
): Map<string, SandboxProfileDefinition> {
  const profiles = new Map<string, SandboxProfileDefinition>();
  const lines = toml.split(/\r?\n/);
  let current: SandboxProfileDefinition | undefined;
  let currentKeys = new Set<string>();
  let skipReserved = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = stripTomlComment(lines[lineIndex]).trim();
    if (!line) continue;
    const table = line.match(/^\[\s*profiles\.([^\]]+)\s*\]$/);
    if (table) {
      const name = parseProfileName(table[1]);
      skipReserved = BUILTIN_SET.has(name);
      if (skipReserved) {
        current = undefined;
        currentKeys = new Set<string>();
        continue;
      }
      if (profiles.has(name)) {
        throw new SandboxProfileError(`Duplicate sandbox profile '${name}' in ${source}`);
      }
      current = { name, readOnly: [], readWrite: [], deny: [] };
      profiles.set(name, current);
      currentKeys = new Set<string>();
      continue;
    }
    if (line.startsWith("[")) {
      current = undefined;
      currentKeys = new Set<string>();
      skipReserved = false;
      continue;
    }
    if (skipReserved || !current) continue;

    const assignment = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*)$/);
    if (!assignment) {
      throw new SandboxProfileError(
        `Malformed sandbox profile '${current.name}' at ${source}:${lineIndex + 1}`,
      );
    }
    const key = assignment[1];
    if (currentKeys.has(key)) {
      throw new SandboxProfileError(
        `Duplicate field '${key}' in sandbox profile '${current.name}'`,
      );
    }
    currentKeys.add(key);
    let value = assignment[2];
    if (value.trim().startsWith("[")) {
      let depth = bracketDepth(value);
      while (depth > 0 && lineIndex + 1 < lines.length) {
        lineIndex += 1;
        const continuation = stripTomlComment(lines[lineIndex]);
        value += `\n${continuation}`;
        depth = bracketDepth(value);
      }
      if (depth !== 0) {
        throw new SandboxProfileError(
          `Unterminated array for ${current.name}.${key} in ${source}`,
        );
      }
    }

    const field = `${current.name}.${key}`;
    switch (key) {
      case "extends":
        current.extends = parseTomlString(value, field);
        break;
      case "restrict_network": {
        const normalized = value.trim().toLowerCase();
        if (normalized !== "true" && normalized !== "false") {
          throw new SandboxProfileError(`${field} must be a boolean`);
        }
        current.restrictNetwork = normalized === "true";
        break;
      }
      case "read_only":
        current.readOnly = parseTomlStringArray(value, field);
        break;
      case "read_write":
        current.readWrite = parseTomlStringArray(value, field);
        break;
      case "deny":
        current.deny = parseTomlStringArray(value, field);
        break;
      default:
        throw new SandboxProfileError(`Unknown field '${key}' in sandbox profile '${current.name}'`);
    }
  }
  return profiles;
}

/** Merge global then project definitions. Project profiles replace same-name globals. */
export function collectSandboxProfileDefinitions(
  sources: SandboxProfileSources,
): Map<string, SandboxProfileDefinition> {
  const merged = new Map<string, SandboxProfileDefinition>();
  for (const [name, profile] of parseSandboxProfiles(
    sources.globalSandbox ?? "",
    "~/.grok/sandbox.toml",
  )) {
    merged.set(name, profile);
  }
  for (const [name, profile] of parseSandboxProfiles(
    sources.projectSandbox ?? "",
    ".grok/sandbox.toml",
  )) {
    merged.set(name, profile);
  }
  return merged;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function builtinProfile(name: SeatbeltBuiltinProfile): ResolvedSandboxProfile {
  return {
    name,
    builtin: name,
    lineage: [name],
    restrictNetwork: BUILTIN_NETWORK[name],
    readOnly: [],
    readWrite: [],
    deny: [],
  };
}

/** Resolve a built-in or recursively inherited custom profile. */
export function resolveSeatbeltProfile(
  name: string,
  sources: SandboxProfileSources | Map<string, SandboxProfileDefinition>,
): ResolvedSandboxProfile {
  const profileName = name.trim();
  if (!profileName) throw new SandboxProfileError("Sandbox profile name cannot be empty");
  const definitions =
    sources instanceof Map ? sources : collectSandboxProfileDefinitions(sources);
  const resolved = new Map<string, ResolvedSandboxProfile>();

  const visit = (currentName: string, stack: string[]): ResolvedSandboxProfile => {
    if (BUILTIN_SET.has(currentName)) {
      return builtinProfile(currentName as SeatbeltBuiltinProfile);
    }
    const cached = resolved.get(currentName);
    if (cached) return cached;
    const cycleAt = stack.indexOf(currentName);
    if (cycleAt >= 0) {
      const cycle = [...stack.slice(cycleAt), currentName].join(" -> ");
      throw new SandboxProfileError(`Sandbox profile inheritance cycle: ${cycle}`);
    }
    const definition = definitions.get(currentName);
    if (!definition) {
      const child = stack.at(-1);
      throw new SandboxProfileError(
        child
          ? `Sandbox profile '${child}' extends missing profile '${currentName}'`
          : `Unknown sandbox profile '${currentName}'`,
      );
    }
    const baseName = definition.extends?.trim() || "workspace";
    const parent = visit(baseName, [...stack, currentName]);
    const value: ResolvedSandboxProfile = {
      name: currentName,
      builtin: parent.builtin,
      lineage: [...parent.lineage, currentName],
      restrictNetwork: definition.restrictNetwork ?? parent.restrictNetwork,
      readOnly: unique([...parent.readOnly, ...definition.readOnly]),
      readWrite: unique([...parent.readWrite, ...definition.readWrite]),
      deny: unique([...parent.deny, ...definition.deny]),
    };
    resolved.set(currentName, value);
    return value;
  };

  return visit(profileName, []);
}

function canonicalizeMacPath(value: string): string {
  const normalized = path.normalize(value);
  if (normalized === "/tmp" || normalized.startsWith("/tmp/")) {
    return `/private${normalized}`;
  }
  if (normalized === "/var" || normalized.startsWith("/var/")) {
    return `/private${normalized}`;
  }
  if (normalized === "/etc" || normalized.startsWith("/etc/")) {
    return `/private${normalized}`;
  }
  return normalized;
}

/** Expand a profile path against the macOS workspace and home directories. */
export function resolveSandboxPath(raw: string, cwd: string, home: string): string {
  const value = raw.trim();
  if (!value) throw new SandboxProfileError("Sandbox paths cannot be empty");
  let expanded: string;
  if (value === "~") {
    expanded = home;
  } else if (value.startsWith("~/")) {
    expanded = path.join(home, value.slice(2));
  } else if (value.startsWith("/")) {
    expanded = value;
  } else {
    expanded = path.resolve(cwd, value);
  }
  return canonicalizeMacPath(expanded);
}

function quoteSeatbelt(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quoteSeatbeltRegex(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function regexEscape(char: string): string {
  return /[.()+|^$\\{}]/.test(char) ? `\\${char}` : char;
}

function validateCharacterClass(body: string, glob: string): string {
  if (!body || body[0] === "]" || body.includes("[") || body.includes("\\")) {
    throw new SandboxProfileError(`Unsupported character class in deny glob '${glob}'`);
  }
  if (body.includes("[:") || body.includes(":]")) {
    throw new SandboxProfileError(`POSIX character classes are unsupported in deny glob '${glob}'`);
  }
  const negated = body[0] === "!" || body[0] === "^";
  const content = negated ? body.slice(1) : body;
  if (!content) throw new SandboxProfileError(`Empty character class in deny glob '${glob}'`);
  for (let i = 1; i + 1 < content.length; i += 1) {
    if (content[i] === "-" && content.charCodeAt(i - 1) > content.charCodeAt(i + 1)) {
      throw new SandboxProfileError(`Invalid character range in deny glob '${glob}'`);
    }
  }
  return `[${negated ? "^" : ""}${content}]`;
}

/** Convert the supported Grok deny-glob subset to an anchored Seatbelt regex. */
export function denyGlobToSeatbeltRegex(glob: string, cwd: string, home: string): string {
  const absolute = resolveSandboxPath(glob, cwd, home);
  if (absolute.includes("\\") || absolute.includes("{") || absolute.includes("}")) {
    throw new SandboxProfileError(`Unsupported metacharacter in deny glob '${glob}'`);
  }
  let out = "^";
  for (let i = 0; i < absolute.length; i += 1) {
    const char = absolute[i];
    if (char === "*") {
      if (absolute[i + 1] === "*") {
        const previous = i === 0 ? undefined : absolute[i - 1];
        const after = absolute[i + 2];
        if ((previous && previous !== "/") || (after && after !== "/")) {
          throw new SandboxProfileError(`'**' must be a whole path segment in deny glob '${glob}'`);
        }
        if (after === "/") {
          out += "(.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "[") {
      const end = absolute.indexOf("]", i + 1);
      if (end < 0) throw new SandboxProfileError(`Unterminated character class in deny glob '${glob}'`);
      out += validateCharacterClass(absolute.slice(i + 1, end), glob);
      i = end;
    } else if (char === "]") {
      throw new SandboxProfileError(`Unexpected ']' in deny glob '${glob}'`);
    } else {
      out += regexEscape(char);
    }
  }
  return `${out}$`;
}

function hasGlob(value: string): boolean {
  return /[*?[]/.test(value);
}

function containmentRule(
  operation: "file-read*" | "file-write*",
  allowed: string[],
  allowedRegexes: string[] = [],
  allowedLiterals: string[] = [],
): string {
  if (allowed.includes("/")) return "";
  if (
    allowed.length === 0 &&
    allowedRegexes.length === 0 &&
    allowedLiterals.length === 0
  ) return `(deny ${operation})`;
  const filters = [
    ...allowed.map((value) => `      (subpath ${quoteSeatbelt(value)})`),
    ...allowedRegexes.map((value) => `      (regex #${quoteSeatbeltRegex(value)})`),
    ...allowedLiterals.map((value) => `      (literal ${quoteSeatbelt(value)})`),
  ].join("\n");
  return `(deny ${operation}\n  (require-not\n    (require-any\n${filters}\n    )\n  )\n)`;
}

function exactDenyRule(value: string): string {
  return `(deny file-read* file-write*
  (require-any
    (literal ${quoteSeatbelt(value)})
    (subpath ${quoteSeatbelt(value)})
  )
)`;
}

function exactWriteDenyRule(value: string): string {
  return `(deny file-write*
  (require-any
    (literal ${quoteSeatbelt(value)})
    (subpath ${quoteSeatbelt(value)})
  )
)`;
}

function globDenyRule(regex: string): string {
  return `(deny file-read* file-write* (regex #${quoteSeatbeltRegex(regex)}))`;
}

function grokHomeWriteGuard(grokHome: string, planRegex: string): string {
  return `(deny file-write*
  (require-all
    (subpath ${quoteSeatbelt(grokHome)})
    (require-not (regex #${quoteSeatbeltRegex(planRegex)}))
  )
)`;
}

function baseAccess(profile: SeatbeltBuiltinProfile, input: {
  cwd: string;
  grokHome: string;
  tempPaths: string[];
  systemReadPaths: string[];
}): {
  readEverywhere: boolean;
  writeEverywhere: boolean;
  readPaths: string[];
  writePaths: string[];
  writeDeniedPaths: string[];
} {
  switch (profile) {
    case "off":
      return {
        readEverywhere: true,
        writeEverywhere: true,
        readPaths: [],
        writePaths: [],
        writeDeniedPaths: [],
      };
    case "workspace":
      return {
        readEverywhere: true,
        writeEverywhere: false,
        readPaths: [],
        writePaths: [input.cwd, ...input.tempPaths],
        writeDeniedPaths: [],
      };
    case "read-only":
      return {
        readEverywhere: true,
        writeEverywhere: false,
        readPaths: [],
        writePaths: [],
        writeDeniedPaths: [],
      };
    case "strict":
      return {
        readEverywhere: false,
        writeEverywhere: false,
        readPaths: [input.cwd, input.grokHome, ...input.tempPaths, ...input.systemReadPaths],
        writePaths: [input.cwd, ...input.tempPaths],
        writeDeniedPaths: [],
      };
  }
}

/** Compile a resolved profile into an allow-default, filesystem-deny Seatbelt policy. */
export function compileSeatbeltPolicyDetails(
  profile: ResolvedSandboxProfile,
  context: SeatbeltPolicyContext,
): CompiledSeatbeltPolicy {
  const cwd = resolveSandboxPath(context.cwd, "/", context.home ?? os.homedir());
  const home = resolveSandboxPath(context.home ?? os.homedir(), "/", context.home ?? os.homedir());
  const grokHome = resolveSandboxPath(context.grokHome ?? "~/.grok", cwd, home);
  const tempPaths = unique(
    ["/tmp", "/var/tmp", context.tempDir ?? os.tmpdir()].map((value) =>
      resolveSandboxPath(value, cwd, home),
    ),
  );
  const systemReadPaths = unique(
    [...(context.systemReadPaths ?? DEFAULT_SYSTEM_READ_PATHS), ...(context.runtimeReadPaths ?? [])].map(
      (value) => resolveSandboxPath(value, cwd, home),
    ),
  );
  const base = baseAccess(profile.builtin, { cwd, grokHome, tempPaths, systemReadPaths });
  const planWriteRegex = denyGlobToSeatbeltRegex(
    path.join(grokHome, "sessions", "**", "plan.md"),
    cwd,
    home,
  );
  const customReadOnly = profile.readOnly.map((value) => resolveSandboxPath(value, cwd, home));
  const customReadWrite = profile.readWrite.map((value) => resolveSandboxPath(value, cwd, home));
  const writePaths = unique([...base.writePaths, ...customReadWrite]);
  const readPaths = unique([
    ...base.readPaths,
    ...customReadOnly,
    ...writePaths,
    ...systemReadPaths,
  ]);
  const deniedPaths: string[] = [];
  const deniedGlobs: string[] = [];
  const rules = ["(version 1)", "(allow default)"];

  // The Grok model process remains separate and online. The broker only owns
  // delegated filesystem and terminal operations, so denying its network
  // operations blocks shell/script network access without cutting off the LLM.
  if (profile.restrictNetwork) rules.push("(deny network*)");

  if (!base.readEverywhere) {
    const rule = containmentRule("file-read*", readPaths);
    if (rule) rules.push(rule);
  }
  if (!base.writeEverywhere) {
    const rule = containmentRule(
      "file-write*",
      // `/dev/fd/N` exposes only descriptors already inherited or opened by
      // the sandboxed process. The broker gives commands pipes for stdio, so
      // this restores shell output process substitution without opening any
      // persistent device or filesystem path.
      [...writePaths, "/dev/fd"],
      profile.name === "off" ? [] : [planWriteRegex],
      profile.name === "off" ? [] : ["/dev/null"],
    );
    if (rule) rules.push(rule);
  }
  for (const value of base.writeDeniedPaths) {
    const resolved = resolveSandboxPath(value, cwd, home);
    rules.push(exactWriteDenyRule(resolved));
  }
  // The delegated broker only needs Grok's plan.md write. Protect every other
  // GROK_HOME path—even from a custom read_write grant—so it cannot weaken the
  // next start/cold resume by editing config, profiles, or session summaries.
  if (profile.name !== "off") {
    rules.push(grokHomeWriteGuard(grokHome, planWriteRegex));
    rules.push(exactWriteDenyRule(path.join(cwd, ".grok", "sandbox.toml")));
  }
  // Keep credential stores protected regardless of additional read_write
  // grants. A broad custom parent cannot turn credentials into a write sink.
  for (const value of [
    "~/.ssh",
    "~/.gnupg",
    "~/.aws",
    "~/.config/gcloud",
    "~/.azure",
    path.join(grokHome, "auth"),
    path.join(grokHome, "auth.json"),
    path.join(grokHome, "auth.json.lock"),
  ]) {
    rules.push(exactWriteDenyRule(resolveSandboxPath(value, cwd, home)));
  }
  for (const entry of profile.deny) {
    if (hasGlob(entry)) {
      const regex = denyGlobToSeatbeltRegex(entry, cwd, home);
      deniedGlobs.push(regex);
      rules.push(globDenyRule(regex));
    } else {
      const resolved = resolveSandboxPath(entry, cwd, home);
      deniedPaths.push(resolved);
      rules.push(exactDenyRule(resolved));
    }
  }

  return {
    policy: `${rules.join("\n\n")}\n`,
    profile,
    readPaths,
    writePaths,
    deniedPaths,
    deniedGlobs,
    networkRestrictionApplied: profile.restrictNetwork,
  };
}

export function compileSeatbeltPolicy(
  profile: ResolvedSandboxProfile,
  context: SeatbeltPolicyContext,
): string {
  return compileSeatbeltPolicyDetails(profile, context).policy;
}

export function resolveAndCompileSeatbeltPolicy(
  name: string,
  sources: SandboxProfileSources,
  context: SeatbeltPolicyContext,
): CompiledSeatbeltPolicy {
  return compileSeatbeltPolicyDetails(resolveSeatbeltProfile(name, sources), context);
}
