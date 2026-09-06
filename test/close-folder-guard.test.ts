/**
 * Closing a project folder is a revocation: every session it owns is disposed
 * and its agent process killed (a hard kill on Windows). "Close Project Folder"
 * is a File-menu item that gives no hint anything is running, so before this
 * guard a click mid-turn discarded the work with no warning and no undo.
 *
 * Found by independent review as a PRE-EXISTING High; fixed rather than
 * deferred because the standing rule is that High findings get fixed whatever
 * their age.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { Session, sessionHasWorkInFlight, turnIsInFlight } from "../src/session";

const sidebarSrc = () =>
  fs.readFileSync(path.join(__dirname, "..", "src", "sidebar.ts"), "utf8");

describe("sessionHasWorkInFlight", () => {
  it("is false for an idle session — closing that folder costs nothing", () => {
    const session = new Session();
    session.status = "idle";
    expect(sessionHasWorkInFlight(session)).toBe(false);
  });

  it("is true while the agent is working", () => {
    const session = new Session();
    session.status = "working";
    expect(sessionHasWorkInFlight(session)).toBe(true);
  });

  it("is true while the session waits on you", () => {
    // A permission prompt or a question. The answer would have resumed real
    // work, so closing here still throws a turn away.
    const session = new Session();
    session.status = "needs-you";
    expect(sessionHasWorkInFlight(session)).toBe(true);
  });

  it("is true when a turn token is live even if status has not caught up", () => {
    const session = new Session();
    session.status = "idle";
    session.turnToken = {} as never;
    expect(sessionHasWorkInFlight(session)).toBe(true);
  });

  it("is true while the process is still spawning", () => {
    // The window a slow start opens: priming is set before the client object
    // exists, and anything typed meanwhile is queued and dies with the kill.
    // The first version of this predicate missed exactly this and reported the
    // folder as safe to close.
    const session = new Session();
    session.status = "idle";
    session.priming = true;
    expect(sessionHasWorkInFlight(session)).toBe(true);
  });

  it("is true while a spawned client waits for its session id", () => {
    const session = new Session();
    session.status = "idle";
    session.priming = false;
    session.client = { sessionId: undefined } as never;
    expect(sessionHasWorkInFlight(session)).toBe(true);
  });

  it("is false for a session that has never been started", () => {
    // Every folder holds one of these. Deferring wholesale to
    // sessionReadyForPrompt would warn on every close and train people to
    // click through the warning that matters.
    const session = new Session();
    session.status = "idle";
    expect(session.client).toBeUndefined();
    expect(sessionHasWorkInFlight(session)).toBe(false);
  });

  it("is strictly broader than turnIsInFlight", () => {
    // turnIsInFlight only asks whether a token exists. Using it here would miss
    // a session still spawning and one parked on a permission prompt — both of
    // which have work to lose.
    const working = new Session();
    working.status = "working";
    expect(turnIsInFlight(working)).toBe(false);
    expect(sessionHasWorkInFlight(working)).toBe(true);
  });
});

describe("close-folder guard wiring", () => {
  it("asks before it removes, not after", () => {
    const src = sidebarSrc();
    const start = src.indexOf("async removeProjectFolder(");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf("private sessionsBoundToFolder", start));

    const asked = body.indexOf("sessionHasWorkInFlight");
    const removed = body.indexOf("removeWorkspaceFolder(target)");
    expect(asked).toBeGreaterThan(0);
    expect(removed).toBeGreaterThan(0);
    // Order is the whole point: confirming after the folder is already gone
    // would be an apology, not a guard.
    expect(asked).toBeLessThan(removed);
    expect(body).toContain("Close anyway");
  });

  it("warns about exactly the sessions the revoke will dispose", () => {
    // Two independently-computed lists would drift, and the one that drifts
    // silently is the warning — you would be told nothing is running while the
    // revoke disposes a working session.
    const src = sidebarSrc();
    expect(src).toContain("private sessionsBoundToFolder(");
    const revokeStart = src.indexOf("private revokeClosedProjectFolder(");
    const revokeBody = src.slice(revokeStart, revokeStart + 1200);
    expect(revokeBody).toContain("this.sessionsBoundToFolder(closedCwd)");
  });
});

describe("hiding a busy project from a REMOTE", () => {
  // The guard above asks with a native modal. That is right at a desk and
  // impossible on a cloud machine, which is headless: the dialog opens on a
  // screen nobody is at, the host waits for a click that cannot come, and the
  // browser is told nothing. 4.1.2 made this reachable from a remote, so it
  // would have reintroduced the exact silence that release exists to remove.
  const removeBody = () => {
    const src = sidebarSrc();
    const start = src.indexOf("  async removeProjectFolder(");
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, start + 3000);
  };

  it("knows where the request came from", () => {
    // Without the origin there is no way to tell a click at the desk from a
    // tap on a phone, and the modal is only answerable at one of them.
    expect(removeBody()).toContain("origin: MsgOrigin = \"local\"");
    expect(sidebarSrc()).toContain("await this.removeProjectFolder(msg.cwd, origin, clientId)");
  });

  it("refuses instead of opening a dialog nobody can answer", () => {
    const body = removeBody();
    const remoteGuard = body.indexOf("working.length && origin === \"remote\"");
    const modal = body.indexOf("showWarningMessage(");
    expect(remoteGuard).toBeGreaterThan(-1);
    // BEFORE the modal, or the await happens anyway and the host still hangs.
    expect(remoteGuard).toBeLessThan(modal);
  });

  it("tells the remote why, rather than failing silently", () => {
    const body = removeBody();
    expect(body).toContain("this.sendRemoteClient(clientId, { type: \"error\", text })");
    expect(body).toContain("Stop it first");
  });

  it("does not treat the browser's confirmation as consent to end a turn", () => {
    // The browser asks “Hide this project?” and says nothing is deleted. That
    // is not agreement to kill a running agent and discard its work, so the
    // remote path must REFUSE rather than proceed as if the modal was
    // answered “Close anyway”.
    const body = removeBody();
    const remoteBranch = body.slice(
      body.indexOf("working.length && origin === \"remote\""),
      body.indexOf("    if (working.length) {"),
    );
    expect(remoteBranch).toContain("return;");
    expect(remoteBranch).not.toContain("removeWorkspaceFolder");
  });
});
