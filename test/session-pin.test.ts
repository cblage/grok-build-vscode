import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";

function harness(provider: Session["provider"] = "grok") {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const stored: Record<string, any> = {};
  const session = new Session();
  session.provider = provider;
  session.cwd = "/repo";
  session.activeSessionId = "live-session";
  sidebar.focused = session;
  sidebar.pool = new Set([session]);
  sidebar.sessionCache = new Map();
  sidebar.sessionMetaWrites = Promise.resolve();
  sidebar.state = {
    get: (key: string, fallback: unknown) => stored[key] ?? fallback,
    update: vi.fn(async (key: string, value: unknown) => { stored[key] = value; }),
  };
  sidebar.host = { canSwitchWorkspaceFolder: true, appendLine: vi.fn() };
  sidebar.context = { extensionVersion: "test" };
  sidebar.workspaceRoot = () => "/repo";
  sidebar.allAdapterCatalogs = () => [];
  sidebar.isAuthorizedCwd = (cwd: string) => cwd === "/repo";
  sidebar.authorizedSessionCwds = () => ["/repo"];
  sidebar.liveSessionEntry = (s: Session, id: string, cwd: string) => ({ id, cwd, provider: s.provider, displayName: "Live" });
  sidebar.dotForId = () => "idle";
  sidebar.postSessionsList = vi.fn();
  sidebar.postPinnedSessions = vi.fn();
  sidebar.reportRequester = vi.fn();
  return { sidebar, stored, session };
}

describe("session pin persistence", () => {
  it.each(["grok", "codex", "claude"] as const)("includes a live %s pin before a transcript reaches disk", async (provider) => {
    const { sidebar } = harness(provider);
    await sidebar.toggleSessionPin("live-session", "/repo", true);
    expect(sidebar.buildPinnedSessions().entries).toEqual([
      expect.objectContaining({ id: "live-session", provider, pinnedAt: expect.any(Number) }),
    ]);
    await sidebar.toggleSessionPin("live-session", "/repo", false);
    expect(sidebar.buildPinnedSessions().entries).toEqual([]);
  });

  it("serializes rapid pin writes without losing either conversation", async () => {
    const { sidebar, stored } = harness();
    await Promise.all([sidebar.toggleSessionPin("a", "/repo", true), sidebar.toggleSessionPin("b", "/repo", true)]);
    expect(Object.keys(stored["grok.sessionMeta"]).sort()).toEqual(["a", "b"]);
  });

  it("acknowledges a failed save so the renderer can roll back", async () => {
    const { sidebar, stored } = harness();
    sidebar.state.update.mockRejectedValueOnce(new Error("disk full"));
    await sidebar.onMessage({ type: "toggleSessionPin", id: "live-session", cwd: "/repo", pinned: true, requestId: "first" }, "local");
    expect(sidebar.reportRequester).toHaveBeenCalledWith(undefined, "error", "Could not save pin: disk full");
    expect(sidebar.postPinnedSessions).toHaveBeenCalledWith(undefined, "first");
    expect(stored["grok.sessionMeta"]).toBeUndefined();
    await sidebar.toggleSessionPin("live-session", "/repo", true);
    expect(stored["grok.sessionMeta"]["live-session"].pinnedAt).toEqual(expect.any(Number));
  });
});
