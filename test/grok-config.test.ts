import { describe, it, expect } from "vitest";
import {
  collectAvailableSandboxProfiles,
  configDisablesBypassPermissions,
  configForcesAlwaysApprove,
  isProjectOnlySandboxProfile,
  isAlwaysApprovePermission,
  isUnregisteredConfigurationError,
  listSandboxProfilesFromToml,
  mergeWorkspaceEnv,
  normalizeSandboxProfile,
  readGlobalConfigurationValue,
  readSandboxProfile,
  readUiPermissionMode,
  resolveSandboxProfile,
} from "../src/grok-config";

// A realistic grok config.toml, mirroring the on-disk shape.
const CONFIG = (permission: string) => `[cli]
installer = "internal"
auto_update = false
channel = "stable"

[features]
feedback = true
support_permission = true

[ui]
max_thoughts_width = 120
fork_secondary_model = "grok-build"
yolo = false
compact_mode = false
permission_mode = "${permission}"

[marketplace]
official_marketplace_auto_installed = true

[[marketplace.sources]]
name = "xAI Official"
git = "https://github.com/xai-org/plugin-marketplace.git"

[models]
default = "grok-build"
`;

describe("isAlwaysApprovePermission", () => {
  it("matches the hyphenated value grok writes", () => {
    expect(isAlwaysApprovePermission("always-approve")).toBe(true);
  });

  it("accepts the underscore variant and stray case/whitespace", () => {
    expect(isAlwaysApprovePermission("always_approve")).toBe(true);
    expect(isAlwaysApprovePermission("  Always-Approve  ")).toBe(true);
  });

  it("rejects other modes and empties", () => {
    expect(isAlwaysApprovePermission("ask")).toBe(false);
    expect(isAlwaysApprovePermission("")).toBe(false);
    expect(isAlwaysApprovePermission(undefined)).toBe(false);
  });
});

describe("readUiPermissionMode", () => {
  it("reads permission_mode from the [ui] table", () => {
    expect(readUiPermissionMode(CONFIG("always-approve"))).toBe("always-approve");
    expect(readUiPermissionMode(CONFIG("ask"))).toBe("ask");
  });

  it("returns undefined when the key is absent", () => {
    expect(readUiPermissionMode("[ui]\nyolo = false\n")).toBeUndefined();
    expect(readUiPermissionMode("")).toBeUndefined();
  });

  it("ignores a permission_mode outside the [ui] table", () => {
    const toml = `[other]\npermission_mode = "always-approve"\n\n[ui]\nyolo = false\n`;
    expect(readUiPermissionMode(toml)).toBeUndefined();
  });

  it("does not misread the array table [[marketplace.sources]] as [ui]", () => {
    // The array-table line must not flip the in-ui flag on.
    const toml = `[[marketplace.sources]]\npermission_mode = "always-approve"\n`;
    expect(readUiPermissionMode(toml)).toBeUndefined();
  });

  it("strips inline comments and single quotes", () => {
    expect(readUiPermissionMode(`[ui]\npermission_mode = 'ask' # default\n`)).toBe("ask");
  });

  it("tolerates CRLF line endings", () => {
    expect(readUiPermissionMode(`[ui]\r\npermission_mode = "always-approve"\r\n`)).toBe(
      "always-approve",
    );
  });
});

describe("configForcesAlwaysApprove", () => {
  it("true when global config sets always-approve", () => {
    expect(configForcesAlwaysApprove({ global: CONFIG("always-approve") })).toBe(true);
  });

  it("false when global config is the default ask", () => {
    expect(configForcesAlwaysApprove({ global: CONFIG("ask") })).toBe(false);
  });

  it("false when neither config is present", () => {
    expect(configForcesAlwaysApprove({})).toBe(false);
    expect(configForcesAlwaysApprove({ project: undefined, global: undefined })).toBe(false);
  });

  it("project config overrides global (project ask beats global always-approve)", () => {
    expect(
      configForcesAlwaysApprove({ project: CONFIG("ask"), global: CONFIG("always-approve") }),
    ).toBe(false);
  });

  it("project config overrides global (project always-approve beats global ask)", () => {
    expect(
      configForcesAlwaysApprove({ project: CONFIG("always-approve"), global: CONFIG("ask") }),
    ).toBe(true);
  });

  it("falls back to global when project has no permission_mode", () => {
    const projectWithoutKey = `[ui]\nyolo = false\n`;
    expect(
      configForcesAlwaysApprove({ project: projectWithoutKey, global: CONFIG("always-approve") }),
    ).toBe(true);
  });
});

const SANDBOX_CONFIG = (profile: string) => `[ui]
permission_mode = "ask"

[sandbox]
profile = "${profile}"
auto_allow_bash = true
`;

describe("readSandboxProfile", () => {
  it("reads profile from the [sandbox] table", () => {
    expect(readSandboxProfile(SANDBOX_CONFIG("lumina"))).toBe("lumina");
    expect(readSandboxProfile(SANDBOX_CONFIG("workspace"))).toBe("workspace");
  });

  it("returns undefined when the key/table is absent", () => {
    expect(readSandboxProfile("[ui]\npermission_mode = \"ask\"\n")).toBeUndefined();
    expect(readSandboxProfile("")).toBeUndefined();
  });

  it("ignores a profile key outside [sandbox]", () => {
    const toml = `[ui]\nprofile = "workspace"\n\n[other]\nprofile = "strict"\n`;
    expect(readSandboxProfile(toml)).toBeUndefined();
  });
});

describe("normalizeSandboxProfile", () => {
  it("treats off/none/false/empty as no sandbox", () => {
    expect(normalizeSandboxProfile("off")).toBeUndefined();
    expect(normalizeSandboxProfile("OFF")).toBeUndefined();
    expect(normalizeSandboxProfile("none")).toBeUndefined();
    expect(normalizeSandboxProfile("false")).toBeUndefined();
    expect(normalizeSandboxProfile("")).toBeUndefined();
    expect(normalizeSandboxProfile(undefined)).toBeUndefined();
  });

  it("preserves real profile names", () => {
    expect(normalizeSandboxProfile("workspace")).toBe("workspace");
    expect(normalizeSandboxProfile("  lumina  ")).toBe("lumina");
  });
});

describe("readGlobalConfigurationValue", () => {
  it("ignores repository and folder overrides", () => {
    expect(readGlobalConfigurationValue({
      globalValue: "strict",
      workspaceValue: "off",
      workspaceFolderValue: "off",
    } as { globalValue?: string }, "")).toBe("strict");
  });
});

describe("resolveSandboxProfile", () => {
  it("uses the global config selection", () => {
    expect(
      resolveSandboxProfile({
        global: SANDBOX_CONFIG("strict"),
      }),
    ).toBe("strict");
  });

  it("prefers GROK_SANDBOX env over config", () => {
    expect(
      resolveSandboxProfile({
        env: "workspace",
        global: SANDBOX_CONFIG("lumina"),
      }),
    ).toBe("workspace");
  });

  it("uses the extension-state fallback when the host setting is unavailable", () => {
    expect(
      resolveSandboxProfile({
        setting: "",
        fallbackSetting: "strict",
        env: "workspace",
      }),
    ).toBe("strict");
  });

  it("prefers a registered host setting over the extension-state fallback", () => {
    expect(
      resolveSandboxProfile({
        setting: "read-only",
        fallbackSetting: "strict",
      }),
    ).toBe("read-only");
  });

  it("prefers VS Code setting over env and config", () => {
    expect(
      resolveSandboxProfile({
        setting: "strict",
        env: "workspace",
        global: SANDBOX_CONFIG("lumina"),
      }),
    ).toBe("strict");
  });

  it("explicit off in setting disables sandbox even if config sets a profile", () => {
    expect(
      resolveSandboxProfile({
        setting: "off",
        global: SANDBOX_CONFIG("lumina"),
      }),
    ).toBeUndefined();
  });

  it("returns undefined when nothing is configured", () => {
    expect(resolveSandboxProfile({})).toBeUndefined();
  });
});

describe("mergeWorkspaceEnv", () => {
  it("accepts credentials but rejects repository-controlled sandbox roots and overrides", () => {
    expect(mergeWorkspaceEnv(
      {
        HOME: "/Users/alice",
        USERPROFILE: "/Users/alice",
        GROK_HOME: "/Users/alice/.grok",
        GROK_SANDBOX: "strict",
        TMPDIR: "/private/var/folders/trusted/T",
        TMP: "/private/tmp",
        TEMP: "/private/tmp",
      },
      {
        XAI_API_KEY: "workspace-key",
        HOME: "/tmp/fake-home",
        USERPROFILE: "/tmp/fake-profile",
        GROK_HOME: "/tmp/fake-grok",
        GROK_SANDBOX: "off",
        TMPDIR: "/tmp/repository-choice",
        TMP: "/tmp/repository-choice",
        TEMP: "/tmp/repository-choice",
      },
    )).toEqual({
      HOME: "/Users/alice",
      USERPROFILE: "/Users/alice",
      GROK_HOME: "/Users/alice/.grok",
      GROK_SANDBOX: "strict",
      TMPDIR: "/private/var/folders/trusted/T",
      TMP: "/private/tmp",
      TEMP: "/private/tmp",
      XAI_API_KEY: "workspace-key",
    });
  });
});

describe("isUnregisteredConfigurationError", () => {
  it("matches the VS Code settings-schema rejection", () => {
    expect(
      isUnregisteredConfigurationError(
        new Error(
          "Unable to write to User Settings because grok.sandboxProfile is not a registered configuration.",
        ),
      ),
    ).toBe(true);
  });

  it("does not swallow unrelated settings failures", () => {
    expect(isUnregisteredConfigurationError(new Error("Settings file is read-only"))).toBe(false);
  });
});

describe("configDisablesBypassPermissions", () => {
  it("reads disable_bypass_permissions_mode from [ui]", () => {
    expect(
      configDisablesBypassPermissions({
        project: `[ui]\ndisable_bypass_permissions_mode = true\n`,
      }),
    ).toBe(true);
    expect(
      configDisablesBypassPermissions({
        project: `[ui]\ndisable_bypass_permissions_mode = false\n`,
      }),
    ).toBe(false);
  });

  it("project overrides global", () => {
    expect(
      configDisablesBypassPermissions({
        project: `[ui]\ndisable_bypass_permissions_mode = false\n`,
        global: `[ui]\ndisable_bypass_permissions_mode = true\n`,
      }),
    ).toBe(false);
  });
});

describe("listSandboxProfilesFromToml / collectAvailableSandboxProfiles", () => {
  it("parses custom [profiles.name] tables", () => {
    const toml = `[profiles.lumina]\nextends = "workspace"\n\n[profiles.lumina-strict]\nextends = "strict"\n`;
    expect(listSandboxProfilesFromToml(toml)).toEqual(["lumina", "lumina-strict"]);
  });

  it("uses the compiler parser for quoted profile names", () => {
    expect(listSandboxProfilesFromToml(
      `[profiles."my profile"]\nextends = "workspace"\n`,
    )).toEqual(["my profile"]);
  });

  it("ignores built-in profile redefinitions", () => {
    expect(listSandboxProfilesFromToml(`[profiles.workspace]\nread_write = ["."]\n`)).toEqual([]);
  });

  it("merges customs then built-ins", () => {
    const profiles = collectAvailableSandboxProfiles({
      projectSandbox: `[profiles.lumina]\nextends = "workspace"\n\n[profiles.devbox]\nextends = "workspace"\n`,
    });
    expect(profiles[0]).toBe("lumina");
    expect(profiles[1]).toBe("devbox");
    expect(profiles).toContain("workspace");
    expect(profiles).toContain("strict");
    expect(profiles).toContain("read-only");
  });

  it("identifies project-only profile names for workspace-scoped persistence", () => {
    expect(isProjectOnlySandboxProfile({
      name: "lumina",
      projectSandbox: `[profiles.lumina]\nextends = "workspace"`,
      globalSandbox: `[profiles.shared]\nextends = "strict"`,
    })).toBe(true);
    expect(isProjectOnlySandboxProfile({
      name: "shared",
      projectSandbox: `[profiles.shared]\nextends = "workspace"`,
      globalSandbox: `[profiles.shared]\nextends = "strict"`,
    })).toBe(false);
    expect(isProjectOnlySandboxProfile({ name: "workspace" })).toBe(false);
  });
});
