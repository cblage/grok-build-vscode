/**
 * What signing in actually has to achieve.
 *
 * The card above the composer (2026-09-14) says replies are refused until the
 * account is renewed, which promises that renewing it un-refuses them. Two
 * things stood between the promise and the outcome, and both are about the
 * difference between CONNECTING an account and RENEWING one — an errand the
 * login path had no concept of, because until the card existed nobody signed in
 * from inside a conversation that was failing.
 */
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";

function sidebarWith(sessions: Session[], needsLogin: Record<string, boolean>) {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.providerNeedsLogin = needsLogin;
  sidebar.focused = sessions[0];
  sidebar.pool = new Set(sessions);
  sidebar.remoteClients = { detachedActiveValues: () => [] };
  sidebar.postProviderState = vi.fn();
  sidebar.invalidateSubscriptionUsage = vi.fn();
  sidebar.adapterHistory = vi.fn(() => undefined);
  return sidebar;
}

function spentSession(provider: "grok" | "claude" | "codex") {
  const session = new Session();
  session.provider = provider;
  session.activeSessionId = "s1";
  session.hasHistory = true;
  session.authRecoveryTried = true; // its one restart bought a dead process
  return session;
}

describe("an account that works again", () => {
  // Without this the conversation keeps a client built on the dead token
  // forever: `authRecoveryTried` survives a startSession on purpose, and only a
  // clean turn re-arms it — which a session that cannot complete a turn will
  // never have. The card would have sent someone through a sign-in that
  // changed nothing about the conversation it was offered on.
  it("lets the conversation try the token dance once more", () => {
    const session = spentSession("claude");
    const sidebar = sidebarWith([session], { claude: true });

    sidebar.setProviderNeedsLogin("claude", false);

    expect(session.authRecoveryTried).toBe(false);
  });

  it("says nothing to a conversation on a different agent", () => {
    const claude = spentSession("claude");
    const grok = spentSession("grok");
    const sidebar = sidebarWith([claude, grok], { claude: true });

    sidebar.setProviderNeedsLogin("claude", false);

    expect(claude.authRecoveryTried).toBe(false);
    expect(grok.authRecoveryTried).toBe(true);
  });

  // The flag going UP is the failure, not the fix.
  it("does not re-arm anything when the account is being flagged, not cleared", () => {
    const session = spentSession("claude");
    const sidebar = sidebarWith([session], { claude: false });

    sidebar.setProviderNeedsLogin("claude", true);

    expect(session.authRecoveryTried).toBe(true);
  });

  it("reaches a detached remote conversation, not only the focused one", () => {
    const focused = spentSession("grok");
    const detached = spentSession("claude");
    const sidebar = sidebarWith([focused], { claude: true });
    sidebar.remoteClients = { detachedActiveValues: () => [detached] };

    sidebar.setProviderNeedsLogin("claude", false);

    expect(detached.authRecoveryTried).toBe(false);
  });
});

/**
 * The desk half. `runGrokLogin` parks a conversation with history so the
 * provider's sign-in panel has somewhere to land — right for "connect an agent
 * for my next conversation", wrong for "renew the one refusing this one".
 */
function loginSidebar(needsLogin: Record<string, boolean>) {
  const session = new Session();
  session.provider = "claude";
  session.hasHistory = true;
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.providerNeedsLogin = needsLogin;
  sidebar.focused = session;
  sidebar.pool = new Set([session]);
  sidebar.remoteClients = { detachedActiveValues: () => [], clients: () => [] };
  sidebar.locateProvider = vi.fn(() => "/usr/bin/claude");
  sidebar.workspaceRoot = vi.fn(() => "/repo");
  sidebar.host = { appendLine: vi.fn(), createTerminal: vi.fn(() => ({ show: vi.fn() })) };
  sidebar.watchProviderLogin = vi.fn();
  sidebar.newFocusedSession = vi.fn(async () => {});
  sidebar.post = vi.fn();
  sidebar.startDeviceLogin = vi.fn(async () => {});
  return { sidebar, session };
}

describe("signing in from a conversation that is being refused", () => {
  it("routes remote Muse sign-in to the shared device flow", async () => {
    const { sidebar, session } = loginSidebar({});
    sidebar.locateProvider.mockReturnValue("/usr/bin/muse");
    await sidebar.onMessage({ type: "runGrokLogin", provider: "muse" }, "remote");
    expect(sidebar.startDeviceLogin).toHaveBeenCalledWith("muse", "/usr/bin/muse", undefined);
    expect(sidebar.host.createTerminal).not.toHaveBeenCalled();
  });

  it("opens the workspace-free Muse login subcommand at the desk", async () => {
    const { sidebar, session } = loginSidebar({});
    sidebar.locateProvider.mockReturnValue("/usr/bin/muse");
    await sidebar.onMessage({ type: "runGrokLogin", provider: "muse" }, "local");
    expect(sidebar.host.createTerminal).toHaveBeenCalledWith({
      name: "Muse Code Login", shellPath: "/usr/bin/muse", shellArgs: ["login"],
    });
  });
  it("keeps that conversation instead of parking it for a panel", async () => {
    const { sidebar, session } = loginSidebar({ claude: true });

    await sidebar.onMessage({ type: "runGrokLogin", provider: "claude" }, session, "local");

    expect(sidebar.newFocusedSession).not.toHaveBeenCalled();
    expect(sidebar.host.createTerminal).toHaveBeenCalled(); // the flow still runs
  });

  // Unchanged for the errand it was written for: connecting a second account
  // must not drop its sign-in panel over a transcript.
  it("still starts a fresh session when the account is merely being connected", async () => {
    const { sidebar, session } = loginSidebar({});

    await sidebar.onMessage({ type: "runGrokLogin", provider: "claude" }, session, "local");

    expect(sidebar.newFocusedSession).toHaveBeenCalled();
  });
});
