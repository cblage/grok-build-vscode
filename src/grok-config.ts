import { parseSandboxProfiles } from "./seatbelt-policy";

/**
 * Minimal reader for grok's `config.toml` — just enough for the keys the
 * extension needs. No TOML dependency: section-aware line scans for
 * `permission_mode` under `[ui]` and `profile` under `[sandbox]`.
 *
 * grok writes `permission_mode = "always-approve"` when the user picks
 * "Always Approve" via Shift+Tab or runs `/always-approve` in the TUI, which
 * silently makes *every* grok session (CLI + this extension) auto-approve tool
 * actions server-side. The extension can't see that over ACP (the CLI still
 * reports the ordinary `default`/agent mode), so it reads the file directly to
 * keep the mode button honest.
 *
 * Sandbox: `grok agent stdio` does **not** apply `[sandbox] profile` from
 * config on its own (sessions land as `sandbox_profile: "off"`). The host must
 * pass a top-level `--sandbox <profile>` (or set `GROK_SANDBOX`) when spawning.
 */

/** True when a `permission_mode` value means "auto-approve everything". grok
 *  writes the hyphenated spelling; the underscore variant is accepted too. */
export function isAlwaysApprovePermission(value: string | undefined): boolean {
  if (!value) return false;
  return value.trim().toLowerCase().replace(/_/g, "-") === "always-approve";
}

/**
 * Read a single string key from a named top-level table in a config.toml
 * string. Comments (`#…`) and surrounding quotes are stripped. Only the named
 * table is consulted so the same key under another table can't be misread.
 */
export function readTomlTableString(
  toml: string,
  tableName: string,
  key: string,
): string | undefined {
  let inTable = false;
  const keyRe = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(.+)$`);
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const table = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?$/);
    if (table) {
      inTable = table[1].trim() === tableName;
      continue;
    }
    if (!inTable) continue;
    const kv = line.match(keyRe);
    if (kv) return kv[1].trim().replace(/^["']|["']$/g, "").trim();
  }
  return undefined;
}

/**
 * Read `permission_mode` from the `[ui]` table of a config.toml string, or
 * `undefined` when the table/key is absent.
 */
export function readUiPermissionMode(toml: string): string | undefined {
  return readTomlTableString(toml, "ui", "permission_mode");
}

/**
 * Read `profile` from the `[sandbox]` table of a config.toml string, or
 * `undefined` when the table/key is absent.
 */
export function readSandboxProfile(toml: string): string | undefined {
  return readTomlTableString(toml, "sandbox", "profile");
}

/**
 * Normalize a sandbox profile name. Empty and the exact built-in name `off`
 * mean "no sandbox flag" (CLI default). All other non-empty strings are
 * case-sensitive custom/built-in names, matching Grok itself.
 */
export function normalizeSandboxProfile(value: string | undefined | null): string | undefined {
  if (value == null) return undefined;
  const v = value.trim();
  if (!v) return undefined;
  if (v === "off") return undefined;
  return v;
}

/** Read only a User/global VS Code value; repository and folder overrides are
 * deliberately ignored for sandbox selection. */
export function readGlobalConfigurationValue<T>(
  inspected: { globalValue?: T } | undefined,
  fallback: T,
): T {
  return inspected?.globalValue ?? fallback;
}

/**
 * Resolve the consumer profile-selection fallback after any project-local
 * workspace-state choice:
 *
 * 1. VS Code `grok.sandboxProfile` (when non-empty)
 * 2. Extension-state fallback for hosts that reject the registered setting
 * 3. `GROK_SANDBOX` environment variable
 * 4. Global `$GROK_HOME/config.toml` → `[sandbox] profile`
 * 5. undefined → do not pass `--sandbox` (CLI default is off for `agent stdio`)
 *
 * Project `.grok/config.toml` deliberately is not consulted. Project custom
 * definitions live in `.grok/sandbox.toml`; the caller handles a project-local
 * workspace-state selection before invoking this fallback.
 *
 * Exact `off` at any higher layer stops the search and means no sandbox
 * (explicit disable). A missing or empty higher layer falls through.
 */
export function resolveSandboxProfile(input: {
  setting?: string;
  fallbackSetting?: string;
  env?: string;
  global?: string;
}): string | undefined {
  // Setting: present and non-empty wins (including explicit "off").
  if (input.setting != null && input.setting.trim() !== "") {
    return normalizeSandboxProfile(input.setting);
  }
  if (input.fallbackSetting != null && input.fallbackSetting.trim() !== "") {
    return normalizeSandboxProfile(input.fallbackSetting);
  }
  // Env: same — set means decide here (off/empty → no flag).
  if (input.env != null && input.env.trim() !== "") {
    return normalizeSandboxProfile(input.env);
  }
  const globalProfile = input.global != null ? readSandboxProfile(input.global) : undefined;
  if (globalProfile != null) return normalizeSandboxProfile(globalProfile);
  return undefined;
}

/**
 * Resolve the sandbox for a new session while containing the legacy extension
 * fallback. Older builds could save a project-only name there globally when a
 * VS Code-derived host rejected the contributed setting. Accept that fallback
 * only when it is built in or currently defined by the project/user sandbox
 * files; otherwise skip it and continue through environment/global config.
 *
 * Workspace choices and real User settings are explicit and remain unfiltered
 * so unknown names fail closed in the policy compiler. Cold resumes do not use
 * this resolver at all; their frozen summary profile remains authoritative.
 */
export function resolveNewSessionSandboxProfile(input: {
  workspaceChoice?: string;
  setting?: string;
  fallbackSetting?: string;
  env?: string;
  globalConfig?: string;
  projectSandbox?: string;
  globalSandbox?: string;
}): string | undefined {
  if (input.workspaceChoice != null && input.workspaceChoice.trim() !== "") {
    return normalizeSandboxProfile(input.workspaceChoice);
  }
  if (input.setting != null && input.setting.trim() !== "") {
    return normalizeSandboxProfile(input.setting);
  }
  if (input.fallbackSetting != null && input.fallbackSetting.trim() !== "") {
    const fallback = normalizeSandboxProfile(input.fallbackSetting);
    if (!fallback) return undefined;
    if ((BUILTIN_SANDBOX_PROFILES as readonly string[]).includes(fallback)) {
      return fallback;
    }
    try {
      const project = new Set(listSandboxProfilesFromToml(input.projectSandbox ?? ""));
      const global = new Set(listSandboxProfilesFromToml(input.globalSandbox ?? ""));
      if (project.has(fallback) || global.has(fallback)) return fallback;
      // This is the one known-bad state: a project-only name persisted globally
      // by an older host. Ignore it outside projects that define it.
    } catch {
      // Preserve fail-closed behavior: the policy compiler will report the
      // malformed sandbox.toml rather than silently choosing a weaker profile.
      return fallback;
    }
  }
  return resolveSandboxProfile({
    env: input.env,
    global: input.globalConfig,
  });
}

/** Workspace `.env` files are repository-controlled input. They may provide
 * API credentials, but they must not redirect or disable the process-lifetime
 * sandbox control plane. */
export const PROTECTED_WORKSPACE_ENV_KEYS = new Set([
  "GROK_HOME",
  "GROK_SANDBOX",
  "HOME",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
]);

export function mergeWorkspaceEnv(
  base: NodeJS.ProcessEnv,
  workspace: Record<string, string>,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(workspace)) {
    if (PROTECTED_WORKSPACE_ENV_KEYS.has(key.toUpperCase())) continue;
    merged[key] = value;
  }
  return merged;
}

/** Whether VS Code rejected a configuration update because its live schema has
 *  not registered the contributed key yet. Some VS Code-derived hosts can hit
 *  this during extension upgrades even though the packaged manifest is valid. */
export function isUnregisteredConfigurationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.toLowerCase().includes("not a registered configuration");
}

/**
 * The effective always-approve verdict from a project + global config pair.
 * Project `.grok/config.toml` overrides global `~/.grok/config.toml` (grok
 * merges project over global); a key absent from project falls back to global.
 * Either string may be `undefined` (file missing / unreadable).
 */
export function configForcesAlwaysApprove(input: {
  project?: string;
  global?: string;
}): boolean {
  const projectMode = input.project != null ? readUiPermissionMode(input.project) : undefined;
  const effective =
    projectMode ?? (input.global != null ? readUiPermissionMode(input.global) : undefined);
  return isAlwaysApprovePermission(effective);
}

/**
 * Whether `[ui] disable_bypass_permissions_mode` is true in the effective
 * project→global config merge. When set, the extension must not offer Auto
 * accept (YOLO / bypassPermissions) as a selectable mode.
 */
export function configDisablesBypassPermissions(input: {
  project?: string;
  global?: string;
}): boolean {
  const project =
    input.project != null
      ? readTomlTableString(input.project, "ui", "disable_bypass_permissions_mode")
      : undefined;
  const global =
    input.global != null
      ? readTomlTableString(input.global, "ui", "disable_bypass_permissions_mode")
      : undefined;
  const raw = project ?? global;
  if (raw == null) return false;
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/** Built-in sandbox profile names (always selectable in the UI). */
export const BUILTIN_SANDBOX_PROFILES = ["workspace", "devbox", "read-only", "strict"] as const;

/** Where a selectable sandbox profile is defined. */
export type SandboxProfileScope = "workspace" | "user" | "builtin";

/** A sandbox profile together with the source the picker should communicate. */
export interface SandboxProfileOption {
  name: string;
  scope: SandboxProfileScope;
}

/**
 * Parse `[profiles.<name>]` table headers from a `sandbox.toml` body.
 * Returns unique profile names in discovery order.
 */
export function listSandboxProfilesFromToml(toml: string): string[] {
  return [...parseSandboxProfiles(toml).keys()];
}

/** A project-only profile should be stored in extension workspace state so
 * opening another repository cannot inherit a name that does not exist there. */
export function isProjectOnlySandboxProfile(input: {
  name: string;
  projectSandbox?: string;
  globalSandbox?: string;
}): boolean {
  if (!input.name || input.name === "off") return false;
  if ((BUILTIN_SANDBOX_PROFILES as readonly string[]).includes(input.name)) return false;
  try {
    const project = new Set(listSandboxProfilesFromToml(input.projectSandbox ?? ""));
    const global = new Set(listSandboxProfilesFromToml(input.globalSandbox ?? ""));
    return project.has(input.name) && !global.has(input.name);
  } catch {
    // Compilation produces the actionable fail-closed error for malformed
    // definitions. Do not redirect persistence based on a broken file.
    return false;
  }
}

/**
 * Available sandbox profiles and their definition source. Custom workspace
 * profiles are discovered before user profiles so a same-name project
 * definition keeps the same project-over-user precedence as the policy
 * resolver. Built-ins follow custom profiles and cannot be redefined by TOML.
 * Does **not** include `"off"` — the UI always offers that separately.
 */
export function collectAvailableSandboxProfileOptions(input: {
  projectSandbox?: string;
  globalSandbox?: string;
}): SandboxProfileOption[] {
  const out: SandboxProfileOption[] = [];
  const seen = new Set<string>();
  const add = (name: string, scope: SandboxProfileScope) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ name, scope });
  };
  for (const [toml, scope] of [
    [input.projectSandbox, "workspace"],
    [input.globalSandbox, "user"],
  ] as const) {
    if (!toml) continue;
    try {
      for (const n of listSandboxProfilesFromToml(toml)) add(n, scope);
    } catch {
      // Keep built-ins selectable; startup surfaces the precise parser error if
      // the user selects a profile from the malformed source.
    }
  }
  for (const n of BUILTIN_SANDBOX_PROFILES) add(n, "builtin");
  return out;
}

/** Backward-compatible name-only view used by non-UI callers and tests. */
export function collectAvailableSandboxProfiles(input: {
  projectSandbox?: string;
  globalSandbox?: string;
}): string[] {
  return collectAvailableSandboxProfileOptions(input).map(({ name }) => name);
}
