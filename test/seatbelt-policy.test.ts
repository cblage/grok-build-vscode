import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  SandboxProfileError,
  collectSandboxProfileDefinitions,
  compileSeatbeltPolicyDetails,
  denyGlobToSeatbeltRegex,
  isSeatbeltBuiltinProfile,
  parseSandboxProfiles,
  resolveAndCompileSeatbeltPolicy,
  resolveSandboxPath,
  resolveSeatbeltProfile,
  sandboxStartupFailureDisposition,
} from "../src/seatbelt-policy";

describe("parseSandboxProfiles", () => {
  it("parses multiline arrays, comments, booleans, and hashes inside strings", () => {
    const profiles = parseSandboxProfiles(`[profiles.review]
extends = "strict"
restrict_network = false
read_only = ["~/Library", '/data#archive'] # trailing comment
read_write = [
  ".",
  "/tmp/scratch",
]
deny = ["**/*.pem", "**/.env"]
`);
    expect(profiles.get("review")).toEqual({
      name: "review",
      extends: "strict",
      restrictNetwork: false,
      readOnly: ["~/Library", "/data#archive"],
      readWrite: [".", "/tmp/scratch"],
      deny: ["**/*.pem", "**/.env"],
    });
  });

  it("does not permit sandbox.toml to redefine any reserved built-in", () => {
    const profiles = parseSandboxProfiles(`[profiles.off]
read_write = ["/"]

[profiles.workspace]
read_write = ["/"]

[profiles.devbox]
read_write = ["/data"]

[profiles.read-only]
read_write = ["."]

[profiles.strict]
read_write = ["/"]

[profiles.mine]
extends = "workspace"
`);
    expect(profiles.has("off")).toBe(false);
    expect(profiles.has("workspace")).toBe(false);
    expect(profiles.has("devbox")).toBe(false);
    expect(profiles.has("read-only")).toBe(false);
    expect(profiles.has("strict")).toBe(false);
    expect(profiles.has("mine")).toBe(true);
  });

  it("fails closed on malformed known fields and unknown fields", () => {
    expect(() => parseSandboxProfiles(`[profiles.x]\nrestrict_network = "yes"`)).toThrow(
      SandboxProfileError,
    );
    expect(() => parseSandboxProfiles(`[profiles.x]\nread_writ = ["."]`)).toThrow(
      /Unknown field/,
    );
    expect(() =>
      parseSandboxProfiles(`[profiles.x]\ndeny = ["**/.env"]\ndeny = []`),
    ).toThrow(/Duplicate field 'deny'/);
    expect(() =>
      parseSandboxProfiles(`[profiles.x]\nread_write = [".",,, "/tmp"]`),
    ).toThrow(/Unexpected comma/);
    expect(() =>
      parseSandboxProfiles(`[profiles.x]\nrestrict_network = TRUE`),
    ).toThrow(/must be a boolean/);
  });
});

describe("profile source precedence and inheritance", () => {
  it("recognizes built-ins and gives only custom failures fatal startup semantics", () => {
    for (const name of ["off", "workspace", "devbox", "read-only", "strict"]) {
      expect(isSeatbeltBuiltinProfile(name)).toBe(true);
      expect(sandboxStartupFailureDisposition(name)).toBe("warn-and-continue");
    }
    expect(isSeatbeltBuiltinProfile("project")).toBe(false);
    expect(sandboxStartupFailureDisposition("project")).toBe("fatal");
  });

  it("resolves a built-in without parsing unrelated malformed custom profiles", () => {
    const malformed = `[profiles.broken]\nread_write = [\"unterminated\"`;
    for (const name of ["off", "workspace", "devbox", "read-only", "strict"]) {
      expect(resolveSeatbeltProfile(name, { projectSandbox: malformed }).name).toBe(name);
    }
    expect(() => resolveSeatbeltProfile("broken", { projectSandbox: malformed })).toThrow(
      SandboxProfileError,
    );
  });

  it("lets a project definition replace the same global profile", () => {
    const profiles = collectSandboxProfileDefinitions({
      globalSandbox: `[profiles.team]\nread_write = ["/global"]`,
      projectSandbox: `[profiles.team]\nread_write = ["/project"]`,
    });
    expect(profiles.get("team")?.readWrite).toEqual(["/project"]);
  });

  it("inherits directly from each supported built-in", () => {
    const profile = resolveSeatbeltProfile("child", {
      projectSandbox: `[profiles.child]
extends = "strict"
restrict_network = false
read_only = ["/shared", "/dedup", "/dedup"]
read_write = ["/output", "/cache", "/cache"]
deny = ["**/.env", "**/.env"]
`,
    });
    expect(profile).toEqual({
      name: "child",
      builtin: "strict",
      lineage: ["strict", "child"],
      restrictNetwork: false,
      readOnly: ["/shared", "/dedup"],
      readWrite: ["/output", "/cache"],
      deny: ["**/.env"],
    });
  });

  it("defaults a custom profile to workspace", () => {
    const profile = resolveSeatbeltProfile("plain", {
      projectSandbox: `[profiles.plain]\nread_write = ["/output"]`,
    });
    expect(profile.builtin).toBe("workspace");
    expect(profile.lineage).toEqual(["workspace", "plain"]);
  });

  it("rejects custom parents, off, and missing parents exactly like Grok", () => {
    for (const parent of ["base", "off", "missing"]) {
      expect(() =>
        resolveSeatbeltProfile("child", {
          projectSandbox: `[profiles.base]\nextends = "workspace"\n\n[profiles.child]\nextends = "${parent}"`,
        }),
      ).toThrow("may extend only workspace, devbox, read-only, or strict");
    }
  });
});

describe("Seatbelt policy compilation", () => {
  const context = {
    cwd: "/Users/test/work",
    home: "/Users/test",
    grokHome: "~/.grok",
    tempDir: "/var/folders/aa/bb/T",
    runtimeReadPaths: ["/Applications/Editor.app/Contents"],
    topLevelWritePaths: [
      "/home",
      "/usr",
      "/Applications",
      "/data",
      "/proc",
      "/sys",
      "/dev",
    ],
  };

  it("expands relative/home paths and canonicalizes macOS temp aliases", () => {
    expect(resolveSandboxPath(".", context.cwd, context.home)).toBe("/Users/test/work");
    expect(resolveSandboxPath("~/cache", context.cwd, context.home)).toBe("/Users/test/cache");
    expect(resolveSandboxPath("/tmp/a", context.cwd, context.home)).toBe("/private/tmp/a");
    expect(resolveSandboxPath("/var/tmp/a", context.cwd, context.home)).toBe(
      "/private/var/tmp/a",
    );
    expect(resolveSandboxPath("/var/folders/a/T", context.cwd, context.home)).toBe(
      "/private/var/folders/a/T",
    );
    expect(resolveSandboxPath("/etc/hosts", context.cwd, context.home)).toBe(
      "/private/etc/hosts",
    );
  });

  it("compiles workspace/custom write containment and airtight deny rules", () => {
    const compiled = resolveAndCompileSeatbeltPolicy(
      "lumina",
      {
        projectSandbox: `[profiles.lumina]
extends = "workspace"
read_only = ["~/.ssh"]
read_write = [".", "~/.local", "/tmp/scratch"]
deny = ["**/*.pem", ".secrets"]
`,
      },
      context,
    );
    expect(compiled.writePaths).toContain("/Users/test/work");
    expect(compiled.writePaths).toContain("/Users/test/.local");
    expect(compiled.writePaths).toContain("/private/tmp/scratch");
    expect(compiled.policy).toContain("(deny file-write*");
    expect(compiled.policy).toContain('(subpath "/Users/test/work")');
    expect(compiled.policy).toContain('(literal "/Users/test/.ssh")');
    expect(compiled.policy).toContain('(subpath "/Users/test/.ssh")');
    expect(compiled.policy).toContain('(literal "/Users/test/work/.secrets")');
    expect(compiled.policy).toContain('(subpath "/Users/test/work/.secrets")');
    expect(compiled.deniedGlobs).toEqual([
      "^/Users/test/work/(.*/)?[^/]*\\.pem$",
    ]);
    expect(compiled.policy).toContain(
      '(deny file-read* file-write* (regex #"^/Users/test/work/(.*/)?[^/]*\\.pem$"))',
    );
  });

  it("matches Grok's documented built-in filesystem and network matrix on macOS", () => {
    const matrix = {
      off: { readContained: false, writePaths: [], networkRequested: false },
      workspace: {
        readContained: false,
        writePaths: [
          "/Users/test/work",
          "/Users/test/.grok",
          "/private/tmp",
          "/private/var/tmp",
          "/private/var/folders",
          "/private/var/folders/aa/bb/T",
        ],
        networkRequested: false,
      },
      devbox: {
        readContained: false,
        writePaths: ["/Users/test/work", "/home", "/usr", "/Applications"],
        networkRequested: false,
      },
      "read-only": {
        readContained: false,
        writePaths: [
          "/Users/test/.grok",
          "/private/tmp",
          "/private/var/tmp",
          "/private/var/folders",
          "/private/var/folders/aa/bb/T",
        ],
        networkRequested: true,
      },
      strict: {
        readContained: true,
        writePaths: [
          "/Users/test/work",
          "/Users/test/.grok",
          "/private/tmp",
          "/private/var/tmp",
          "/private/var/folders",
          "/private/var/folders/aa/bb/T",
        ],
        networkRequested: true,
      },
    } as const;

    for (const [name, expected] of Object.entries(matrix)) {
      const compiled = compileSeatbeltPolicyDetails(resolveSeatbeltProfile(name, {}), context);
      const hasReadContainment = compiled.policy.includes(
        "(deny file-read*\n  (require-not",
      );
      expect(hasReadContainment, `${name} read containment`).toBe(expected.readContained);
      expect(compiled.writePaths, `${name} writable paths`).toEqual(expected.writePaths);
      expect(compiled.profile.restrictNetwork, `${name} network intent`).toBe(
        expected.networkRequested,
      );
      expect(compiled.networkRestrictionApplied, `${name} macOS network enforcement`).toBe(false);
      expect(compiled.policy, `${name} macOS network policy`).not.toContain("(deny network*)");
    }

    const off = compileSeatbeltPolicyDetails(resolveSeatbeltProfile("off", {}), context);
    expect(off.policy).not.toContain("(deny file-read*");
    expect(off.policy).not.toContain("(deny file-write*");

    const devbox = compileSeatbeltPolicyDetails(resolveSeatbeltProfile("devbox", {}), context);
    for (const denied of ["/data", "/proc", "/sys", "/dev"]) {
      expect(devbox.writePaths, `devbox excludes ${denied}`).not.toContain(denied);
    }
    for (const device of ["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/ptmx"]) {
      expect(devbox.policy, `devbox allows ${device}`).toContain(`(literal \"${device}\")`);
    }
    expect(devbox.policy).not.toContain('(subpath "/dev/fd")');
    expect(devbox.policy).not.toContain('(subpath "/Users/test/.ssh")');

    const strict = compileSeatbeltPolicyDetails(resolveSeatbeltProfile("strict", {}), context);
    for (const readable of [
      "/usr",
      "/bin",
      "/sbin",
      "/private/etc",
      "/dev",
      "/private/tmp",
      "/private/var",
      "/System",
      "/Library",
      "/private",
      "/Users/test/Library",
    ]) {
      expect(strict.readPaths, `strict reads ${readable}`).toContain(readable);
    }
    expect(strict.readPaths).not.toContain("/opt");
  });

  it("enumerates root only for devbox and fails instead of silently narrowing it", () => {
    const { topLevelWritePaths: _ignored, ...withoutDevboxSeam } = context;
    const rootRead = vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      throw new Error("root unavailable");
    });
    try {
      expect(() =>
        compileSeatbeltPolicyDetails(
          resolveSeatbeltProfile("workspace", {}),
          withoutDevboxSeam,
        ),
      ).not.toThrow();
      expect(() =>
        compileSeatbeltPolicyDetails(
          resolveSeatbeltProfile("devbox", {}),
          withoutDevboxSeam,
        ),
      ).toThrow("Unable to enumerate top-level directories for the devbox profile");
    } finally {
      rootRead.mockRestore();
    }
  });

  it("grants full GROK_HOME writes for documented built-ins and descendants", () => {
    for (const name of ["workspace", "read-only", "strict"]) {
      const compiled = compileSeatbeltPolicyDetails(resolveSeatbeltProfile(name, {}), context);
      expect(compiled.writePaths).toContain("/Users/test/.grok");
      expect(compiled.policy).not.toContain(
        '^/Users/test/\\.grok/sessions/(.*/)?plan\\.md$',
      );
      expect(compiled.policy).not.toContain(
        '(literal "/Users/test/work/.grok/sandbox.toml")',
      );
    }
    const custom = resolveAndCompileSeatbeltPolicy(
      "child",
      { projectSandbox: `[profiles.child]\nextends = "workspace"` },
      context,
    );
    expect(custom.writePaths).toContain("/Users/test/.grok");
    expect(custom.policy).not.toContain("plan\\.md");
  });

  it("adds read containment for strict and reserves devbox over custom definitions", () => {
    const strict = compileSeatbeltPolicyDetails(resolveSeatbeltProfile("strict", {}), context);
    expect(strict.policy).toContain("(deny file-read*");
    expect(strict.readPaths).toContain("/Applications/Editor.app/Contents");

    const devbox = resolveAndCompileSeatbeltPolicy(
      "devbox",
      {
        globalSandbox: `[profiles.devbox]\nextends = "strict"\nrestrict_network = true\ndeny = ["/Users/test"]\n`,
      },
      context,
    );
    expect(devbox.profile).toMatchObject({
      name: "devbox",
      builtin: "devbox",
      lineage: ["devbox"],
      restrictNetwork: false,
      deny: [],
    });
    expect(devbox.policy).not.toContain('(subpath "/Users/test")');
  });

  it("does not enforce custom restrict_network on macOS, matching Grok's no-op", () => {
    const compiled = resolveAndCompileSeatbeltPolicy(
      "offline-review",
      {
        projectSandbox: `[profiles.offline-review]\nextends = "workspace"\nrestrict_network = true\n`,
      },
      context,
    );
    expect(compiled.profile.restrictNetwork).toBe(true);
    expect(compiled.networkRestrictionApplied).toBe(false);
    expect(compiled.policy).not.toContain("(deny network*)");
  });

  it("supports the documented deny glob subset", () => {
    expect(denyGlobToSeatbeltRegex("**/.env", context.cwd, context.home)).toBe(
      "^/Users/test/work/(.*/)?\\.env$",
    );
    expect(denyGlobToSeatbeltRegex("src/file-?.[ch]", context.cwd, context.home)).toBe(
      "^/Users/test/work/src/file-[^/]\\.[ch]$",
    );
    expect(denyGlobToSeatbeltRegex("src/[!a-z].txt", context.cwd, context.home)).toBe(
      "^/Users/test/work/src/[^a-z]\\.txt$",
    );
  });

  it("rejects malformed or unsupported deny globs before launch", () => {
    for (const glob of ["foo/**bar", "*.{pem,key}", "foo/[abc", "foo/[z-a]"]) {
      expect(() => denyGlobToSeatbeltRegex(glob, context.cwd, context.home)).toThrow(
        SandboxProfileError,
      );
    }
  });
});
