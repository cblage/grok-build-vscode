import { describe, expect, it } from "vitest";
import {
  SandboxProfileError,
  collectSandboxProfileDefinitions,
  compileSeatbeltPolicyDetails,
  denyGlobToSeatbeltRegex,
  parseSandboxProfiles,
  resolveAndCompileSeatbeltPolicy,
  resolveSandboxPath,
  resolveSeatbeltProfile,
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

  it("does not permit sandbox.toml to redefine reserved built-ins", () => {
    const profiles = parseSandboxProfiles(`[profiles.workspace]
read_write = ["/"]

[profiles.mine]
extends = "workspace"
`);
    expect(profiles.has("workspace")).toBe(false);
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
  });
});

describe("profile source precedence and inheritance", () => {
  it("lets a project definition replace the same global profile", () => {
    const profiles = collectSandboxProfileDefinitions({
      globalSandbox: `[profiles.team]\nread_write = ["/global"]`,
      projectSandbox: `[profiles.team]\nread_write = ["/project"]`,
    });
    expect(profiles.get("team")?.readWrite).toEqual(["/project"]);
  });

  it("recursively merges custom parents in parent-to-child order", () => {
    const profile = resolveSeatbeltProfile("child", {
      globalSandbox: `[profiles.base]
extends = "strict"
restrict_network = true
read_only = ["/shared", "/dedup"]
read_write = ["/cache"]
deny = ["**/.env"]
`,
      projectSandbox: `[profiles.middle]
extends = "base"
read_only = ["/dedup", "/project"]
deny = ["**/*.pem"]

[profiles.child]
extends = "middle"
restrict_network = false
read_write = ["/output", "/cache"]
`,
    });
    expect(profile).toEqual({
      name: "child",
      builtin: "strict",
      lineage: ["strict", "base", "middle", "child"],
      restrictNetwork: false,
      readOnly: ["/shared", "/dedup", "/project"],
      readWrite: ["/cache", "/output"],
      deny: ["**/.env", "**/*.pem"],
    });
  });

  it("defaults a custom profile to workspace", () => {
    const profile = resolveSeatbeltProfile("plain", {
      projectSandbox: `[profiles.plain]\nread_write = ["/output"]`,
    });
    expect(profile.builtin).toBe("workspace");
    expect(profile.lineage).toEqual(["workspace", "plain"]);
  });

  it("rejects cycles and missing custom parents", () => {
    expect(() =>
      resolveSeatbeltProfile("a", {
        projectSandbox: `[profiles.a]\nextends = "b"\n[profiles.b]\nextends = "a"`,
      }),
    ).toThrow(/a -> b -> a/);
    expect(() =>
      resolveSeatbeltProfile("a", {
        projectSandbox: `[profiles.a]\nextends = "missing"`,
      }),
    ).toThrow("extends missing profile 'missing'");
  });
});

describe("Seatbelt policy compilation", () => {
  const context = {
    cwd: "/Users/test/work",
    home: "/Users/test",
    grokHome: "~/.grok",
    tempDir: "/var/folders/aa/bb/T",
    runtimeReadPaths: ["/Applications/Editor.app/Contents"],
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
    expect(compiled.policy).toContain('(literal "/Users/test/work/.secrets")');
    expect(compiled.policy).toContain('(subpath "/Users/test/work/.secrets")');
    expect(compiled.deniedGlobs).toEqual([
      "^/Users/test/work/(.*/)?[^/]*\\.pem$",
    ]);
    expect(compiled.policy).toContain(
      '(deny file-read* file-write* (regex #"^/Users/test/work/(.*/)?[^/]*\\.pem$"))',
    );
  });

  it("allows only plan.md writes under GROK_HOME, including with a broad custom grant", () => {
    for (const name of ["workspace", "read-only", "strict"]) {
      const compiled = compileSeatbeltPolicyDetails(resolveSeatbeltProfile(name, {}), context);
      expect(compiled.writePaths).not.toContain("/Users/test/.grok");
      expect(compiled.policy).toContain(
        '(regex #"^/Users/test/\\.grok/sessions/(.*/)?plan\\.md$")',
      );
      expect(compiled.policy).toContain('(subpath "/Users/test/.grok")');
      expect(compiled.policy).toContain("(require-not (regex");
      expect(compiled.policy).toContain(
        '(literal "/Users/test/work/.grok/sandbox.toml")',
      );
      expect(compiled.policy).toContain('(literal "/dev/null")');
      expect(compiled.policy).toContain('(subpath "/dev/fd")');
      expect(compiled.writePaths).not.toContain("/dev/fd");
    }
    const custom = resolveAndCompileSeatbeltPolicy(
      "broad",
      { projectSandbox: `[profiles.broad]\nextends = "off"\nread_write = ["~/.grok"]` },
      context,
    );
    expect(custom.writePaths).toContain("/Users/test/.grok");
    expect(custom.policy).toContain('(deny file-write*');
    expect(custom.policy).toContain('(subpath "/Users/test/.grok")');
    expect(custom.policy).toContain(
      '(require-not (regex #"^/Users/test/\\.grok/sessions/(.*/)?plan\\.md$"))',
    );
  });

  it("adds read containment for strict and treats devbox as a custom profile", () => {
    const strict = compileSeatbeltPolicyDetails(resolveSeatbeltProfile("strict", {}), context);
    expect(strict.policy).toContain("(deny file-read*");
    expect(strict.readPaths).toContain("/Applications/Editor.app/Contents");

    const devbox = resolveAndCompileSeatbeltPolicy(
      "devbox",
      { globalSandbox: `[profiles.devbox]\nextends = "workspace"\nread_only = ["/data"]\n` },
      context,
    );
    expect(devbox.profile.lineage).toEqual(["workspace", "devbox"]);
    expect(devbox.readPaths).toContain("/data");
  });

  it("blocks broker and terminal network access when restrict_network is enabled", () => {
    const compiled = compileSeatbeltPolicyDetails(resolveSeatbeltProfile("read-only", {}), context);
    expect(compiled.profile.restrictNetwork).toBe(true);
    expect(compiled.networkRestrictionApplied).toBe(true);
    expect(compiled.policy).toContain("(deny network*)");
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
