import { describe, it, expect, vi } from "vitest";
import { configWriteTarget } from "../src/mode-prefs";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";

describe("configWriteTarget (#162)", () => {
  it("writes where the value already lives, so the next read finds it", () => {
    expect(configWriteTarget(undefined)).toBe("global");
    expect(configWriteTarget({})).toBe("global");
    expect(configWriteTarget({ workspaceValue: "low" })).toBe("workspace");
    expect(configWriteTarget({ workspaceFolderValue: "low" })).toBe("workspaceFolder");
    // Folder outranks workspace, the same way `get` resolves them.
    expect(configWriteTarget({ workspaceValue: "low", workspaceFolderValue: "high" })).toBe("workspaceFolder");
    // An override that exists and is EMPTY still outranks global — "" is a real
    // value for these keys (it means "the CLI default, pass no flag").
    expect(configWriteTarget({ workspaceValue: "" })).toBe("workspace");
  });
});

/**
 * Models VS Code's actual configuration semantics, which the picker fake in
 * mode-prefs.test.ts does not: `update` writes ONE scope, while `get` returns
 * the EFFECTIVE value. That fake is `{ get: () => "high", update: vi.fn() }` —
 * a `get` that ignores every write — which is why no test could see a
 * write/read scope mismatch, and why #162 shipped.
 */
function scopedConfig(workspaceValue?: string) {
  const store: Record<string, string | undefined> = { global: "", workspace: workspaceValue };
  return {
    store,
    get: (_key: string, fallback = "") =>
      store.workspace !== undefined ? store.workspace : (store.global || fallback),
    inspect: (key: string) => ({
      key,
      globalValue: store.global,
      workspaceValue: store.workspace,
    }),
    update: vi.fn(async (_key: string, value: string, target: string) => {
      store[target === "global" ? "global" : "workspace"] = value;
    }),
  };
}

function harness(workspaceValue?: string) {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const session = new Session();
  session.provider = "grok";
  session.cwd = "/project";
  session.hasHistory = false; // the empty conversation in the report
  session.client = undefined;
  const cfg = scopedConfig(workspaceValue);
  const spawnedAt: string[] = [];
  sidebar.focused = session;
  sidebar.host = { getConfiguration: () => cfg };
  sidebar.state = { get: (_k: string, fb: unknown) => fb, update: vi.fn(async () => {}) };
  sidebar.workspaceRoot = () => "/project";
  sidebar.context = { extensionVersion: "test" };
  sidebar.emit = vi.fn();
  // Exactly what the spawn reads (sidebar.ts, `startSession`).
  sidebar.startSession = vi.fn(async () => {
    spawnedAt.push(sidebar.defaultEffortForProvider(session.provider));
  });
  sidebar.discardRestartedEmptySession = vi.fn();
  sidebar.discardAdapterEmptySession = vi.fn();
  return { sidebar, cfg, spawnedAt };
}

describe("the picked effort is the one grok respawns at (#162)", () => {
  it("with nothing configured per workspace, the pick lands globally", async () => {
    const { sidebar, cfg, spawnedAt } = harness(undefined);
    await sidebar.onMessage({ type: "setEffort", level: "high" }, "local");
    expect(cfg.update).toHaveBeenCalledWith("defaultEffort", "high", "global");
    expect(spawnedAt).toEqual(["high"]);
  });

  it("moves the WORKSPACE value when one exists, instead of a global nothing reads", async () => {
    const { sidebar, cfg, spawnedAt } = harness("low");
    await sidebar.onMessage({ type: "setEffort", level: "high" }, "local");
    await sidebar.onMessage({ type: "setEffort", level: "medium" }, "local");
    expect(cfg.update).toHaveBeenCalledWith("defaultEffort", "high", "workspace");
    // Before the fix both spawns were ["low", "low"] — the report's "goes back
    // to 'low'", every time, whatever you picked.
    expect(spawnedAt).toEqual(["high", "medium"]);
    expect(cfg.store.global).toBe(""); // untouched: the override is what decides
  });

  it("still reaches the CLI default through a workspace override", async () => {
    const { sidebar, spawnedAt } = harness("high");
    await sidebar.onMessage({ type: "setEffort", level: "" }, "local");
    expect(spawnedAt).toEqual([""]);
  });
});
