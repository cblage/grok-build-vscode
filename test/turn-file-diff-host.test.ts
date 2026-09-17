import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session, beginTurn } from "../src/session";
import * as git from "../src/git-run";
import { emptyGitStatus } from "../src/git-status";
import { SessionRequestState } from "../src/session-request-state";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const SHA = "b".repeat(40);
const BLOB = "c".repeat(40);
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const session = new Session();
  session.cwd = "/repo";
  sidebar.focused = session;
  sidebar.host = { workspaceRoot: () => "/repo", appendLine: vi.fn() };
  sidebar.turnDiffBaselines = new Map();
  sidebar.pendingTurnDiffCaptures = new WeakSet();
  sidebar.gitRunGate = new git.GitRunGate();
  sidebar.mirrorToProjectsRail = vi.fn();
  sidebar.sendRemoteSession = vi.fn();
  sidebar.post = vi.fn();
  sidebar.sendRemoteRequester = vi.fn();
  sidebar.captureRemoteRequester = () => ({ clientId: "phone" });
  sidebar.remoteClients = { active: () => undefined, cwd: () => "/repo" };
  sidebar.remoteTargetableCwd = (cwd: string) => cwd === "/repo";
  return { sidebar, session };
}
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

describe("host-owned turn baselines", () => {
  it.each(["grok", "codex", "claude"] as const)("captures without waiting for %s, behind the same git gate", async provider => {
    let resolve!: (baseline: git.GitTurnBaseline) => void;
    const capture = vi.spyOn(git, "captureGitTurnBaseline").mockImplementation(() => new Promise(r => { resolve = r; }));
    const { sidebar, session } = fixture();
    session.provider = provider;
    const turn = beginTurn(session);
    expect(sidebar.startTurnDiffBaseline(session, turn)).toBeUndefined();
    expect(capture).toHaveBeenCalledWith("/repo");
    expect(sidebar.gitRunGate.isBusy("/repo")).toBe(true);
    const identity = session.buffer.at(-1) as any;
    expect(identity).toMatchObject({ type: "turnDiffBaseline", cwd: "/repo" });
    expect(identity).not.toHaveProperty("sha");
    expect(identity).not.toHaveProperty("untracked");
    expect(sidebar.turnDiffBaselines.get(identity.turnId).sha).toBeUndefined();
    resolve({ sha: SHA, untracked: new Map([["a.ts", BLOB]]) });
    await settle();
    expect(sidebar.turnDiffBaselines.get(identity.turnId).sha).toBe(SHA);
    expect(sidebar.turnDiffBaselines.get(identity.turnId).untracked).toEqual(new Map([["a.ts", BLOB]]));
    expect(sidebar.gitRunGate.isBusy("/repo")).toBe(false);
  });

  it("skips a busy repository instead of queueing a later baseline", () => {
    const capture = vi.spyOn(git, "captureGitTurnBaseline");
    const { sidebar, session } = fixture();
    sidebar.gitRunGate.tryAcquire("/repo");
    sidebar.startTurnDiffBaseline(session, beginTurn(session));
    expect(capture).not.toHaveBeenCalled();
    expect(sidebar.gitRunGate.isBusy("/repo")).toBe(true);
  });

  it.each(["toolCall", "toolCallUpdate", "permissionRequest", "new-turn", "session-reset", "turn-end"])("discards a late capture after %s", async event => {
    let resolve!: (baseline: git.GitTurnBaseline) => void;
    vi.spyOn(git, "captureGitTurnBaseline").mockImplementation(() => new Promise(r => { resolve = r; }));
    const { sidebar, session } = fixture();
    sidebar.startTurnDiffBaseline(session, beginTurn(session));
    const identity = session.buffer.at(-1) as any;
    if (event === "new-turn") beginTurn(session);
    else if (event === "session-reset") session.gen++;
    else if (event === "turn-end") session.turnToken = undefined;
    else sidebar.emit(session, { type: event });
    resolve({ sha: SHA, untracked: new Map([["a.ts", BLOB]]) });
    await settle();
    expect(sidebar.turnDiffBaselines.get(identity.turnId).sha).toBeUndefined();
    expect(sidebar.turnDiffBaselines.get(identity.turnId).untracked).toBeUndefined();
    expect(sidebar.gitRunGate.isBusy("/repo")).toBe(false);
  });

  it("bounds memory and never resurrects an evicted pending turn", async () => {
    let resolve!: (baseline: git.GitTurnBaseline) => void;
    vi.spyOn(git, "captureGitTurnBaseline").mockImplementation(() => new Promise(r => { resolve = r; }));
    const { sidebar, session } = fixture();
    sidebar.startTurnDiffBaseline(session, beginTurn(session));
    const oldest = (session.buffer.at(-1) as any).turnId;
    for (let i = 0; i < 100; i++) {
      const another = new Session();
      another.cwd = "/repo";
      sidebar.startTurnDiffBaseline(another, beginTurn(another));
    }
    expect(sidebar.turnDiffBaselines.size).toBe(100);
    resolve({ sha: SHA, untracked: new Map([["a.ts", BLOB]]) });
    await settle();
    expect(sidebar.turnDiffBaselines.has(oldest)).toBe(false);
  });

  it("releases the git gate after an asynchronous capture failure", async () => {
    vi.spyOn(git, "captureGitTurnBaseline").mockRejectedValue(new Error("failed"));
    const { sidebar, session } = fixture();
    sidebar.startTurnDiffBaseline(session, beginTurn(session));
    await settle();
    expect(sidebar.gitRunGate.isBusy("/repo")).toBe(false);
    expect([...sidebar.turnDiffBaselines.values()][0].sha).toBeUndefined();
  });
});

describe("host-local whole-file turn diff tabs", () => {
  function openFixture() {
    const { sidebar, session } = fixture();
    sidebar.host.openDiff = vi.fn().mockResolvedValue(undefined);
    sidebar.host.closeDiffTabs = vi.fn();
    sidebar.diffSeq = 0;
    sidebar.diffProvider = { set: vi.fn(), delete: vi.fn() };
    sidebar.openDiffsByRequest = new SessionRequestState();
    const remember = vi.spyOn(sidebar.openDiffsByRequest, "set");
    sidebar.turnDiffBaselines.set("turn", { root: "/repo", sha: SHA });
    const status = vi.spyOn(git, "readGitStatus").mockResolvedValue({ ok: true, snapshot: {
      ...emptyGitStatus(), files: [{ path: "a.ts", status: "M", added: 900, deleted: 900 }],
    } });
    const oldText = "before\n".repeat(900);
    const newText = "after\n".repeat(900);
    const before = vi.spyOn(git, "readGitTurnFileBefore").mockResolvedValue({ ok: true, text: oldText });
    const disk = vi.spyOn(sidebar, "readTurnAfterSide").mockReturnValue(newText);
    const request = { type: "turnFileOpenDiff", turnId: "turn", cwd: "/repo", path: "a.ts" };
    return { sidebar, session, remember, before, disk, status, request, oldText, newText };
  }

  it("opens complete sides once in a permanent tab owned by the user, not a permission", async () => {
    const { sidebar, session, remember, before, disk, request, oldText, newText } = openFixture();
    await sidebar.onMessage({ ...request, requestId: 7, baseline: "evil", oldText: "capped patch" }, "local");
    expect(before).toHaveBeenCalledWith("/repo", "a.ts", { sha: SHA, untracked: undefined });
    expect(disk).toHaveBeenCalledTimes(1);
    expect(disk).toHaveBeenCalledWith(path.join("/repo", "a.ts"));
    const [left, right, title, options] = sidebar.host.openDiff.mock.calls[0];
    expect(left.scheme).toBe("grok-diff");
    expect(right.scheme).toBe("grok-diff");
    expect(sidebar.diffProvider.set.mock.calls).toEqual([[left, oldText], [right, newText]]);
    // Names the file, not the turn: a real turnId is a randomUUID, and this
    // fixture's four-character one is what hid that from the first version.
    expect(title).toBe("Turn diff: a.ts");
    expect(options).toMatchObject({ preview: false });
    expect(remember).not.toHaveBeenCalled();
    expect(sidebar.sendRemoteRequester).not.toHaveBeenCalled();
    expect(sidebar.post).not.toHaveBeenCalled();

    // Exercise the actual answer path, including closing a different tab.
    await sidebar.openDiffEditor(session, "permission.ts", "old", "new", 7);
    const [permissionLeft, permissionRight] = sidebar.host.openDiff.mock.calls[1];
    session.pendingPermissions.set(7, { title: "Edit permission.ts", options: [{ optionId: "yes", kind: "allow_once", name: "Allow" }], toolKind: "edit" });
    session.client = { respondPermission: vi.fn().mockReturnValue(true) } as any;
    sidebar.persistPermissionAnswer = vi.fn();
    sidebar.noteAnswered = vi.fn();
    await sidebar.onMessage({ type: "permissionAnswer", requestId: 7, optionId: "yes" }, "local");
    expect(session.client.respondPermission).toHaveBeenCalledWith(7, "yes");
    expect(sidebar.host.closeDiffTabs).toHaveBeenCalledTimes(1);
    expect(sidebar.host.closeDiffTabs).toHaveBeenCalledWith(permissionLeft, permissionRight);
    expect(sidebar.diffProvider.delete).toHaveBeenCalledTimes(1);
    expect(sidebar.diffProvider.delete).toHaveBeenCalledWith(permissionLeft, permissionRight);
    expect(String(permissionLeft)).not.toBe(String(left));
    expect(String(permissionRight)).not.toBe(String(right));
  });

  it("uses a mapped baseline without the live status fence even after staging or deletion", async () => {
    const { sidebar, before, status, request } = openFixture();
    const untracked = new Map([["a.ts", BLOB]]);
    sidebar.turnDiffBaselines.get("turn").untracked = untracked;
    await sidebar.onMessage({ ...request, baselineBlob: "evil" }, "local");
    expect(status).not.toHaveBeenCalled();
    expect(before).toHaveBeenCalledWith("/repo", "a.ts", { sha: SHA, untracked });
    expect(sidebar.host.openDiff).toHaveBeenCalledTimes(1);
  });

  it.each([{ turnId: "expired" }, { turnId: SHA }, { cwd: "/other" }, { path: "unknown.ts" }, { path: "../secret" }])(
    "refuses a request outside the turn/root/changed-path fences with a sentence: %j", async over => {
      const { sidebar, before, disk, request } = openFixture();
      await sidebar.onMessage({ ...request, ...over }, "local");
      expect(before).not.toHaveBeenCalled();
      expect(disk).not.toHaveBeenCalled();
      expect(sidebar.host.openDiff).not.toHaveBeenCalled();
      expect(sidebar.post).toHaveBeenCalledWith({ type: "error", text: expect.stringMatching(/\S.+/) });
    });

  it.each([{ root: "/repo" }, { root: "/other", sha: SHA }])("refuses unfinished or differently rooted baselines: %j", async baseline => {
    const { sidebar, before, status, request } = openFixture();
    sidebar.turnDiffBaselines.set("turn", baseline);
    await sidebar.onMessage(request, "local");
    expect(status).not.toHaveBeenCalled();
    expect(before).not.toHaveBeenCalled();
    expect(sidebar.host.openDiff).not.toHaveBeenCalled();
    expect(sidebar.post).toHaveBeenCalledWith({ type: "error", text: "This turn's diff is no longer available." });
  });

  it("opens the deletion a turn performed, on the row the inline cap hurts most", async () => {
    // A Deleted row is exactly where a 400-line inline preview is useless and
    // the whole before side is already in hand, so refusing here made the new
    // control dead on a whole category of rows.
    const { sidebar, disk, request, oldText } = openFixture();
    disk.mockReturnValue("");
    await sidebar.onMessage(request, "local");
    const [left, right, title] = sidebar.host.openDiff.mock.calls[0];
    expect(sidebar.diffProvider.set.mock.calls).toEqual([[left, oldText], [right, ""]]);
    expect(title).toBe("Turn diff: a.ts");
    expect(sidebar.post).not.toHaveBeenCalled();
  });

  it("reads a vanished path as an empty side, and still delegates one that exists", () => {
    // The seam that makes the case above distinguishable: readFileForDiff
    // answers "gone", "too big to hold twice" and "desktop containment refused
    // it" with the same undefined, and only the first may become an empty side.
    const { sidebar, disk } = openFixture();
    disk.mockRestore();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-after-"));
    const present = path.join(dir, "a.ts");
    fs.writeFileSync(present, "on disk\n");
    const read = vi.spyOn(sidebar, "readFileForDiff").mockReturnValue("on disk\n");
    try {
      expect(sidebar.readTurnAfterSide(path.join(dir, "gone.ts"))).toBe("");
      expect(read).not.toHaveBeenCalled();
      expect(sidebar.readTurnAfterSide(present)).toBe("on disk\n");
      expect(read).toHaveBeenCalledWith(present);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["status", "baseline", "disk"])("reports a %s read failure without opening misleading sides", async failure => {
    const { sidebar, status, before, disk, request } = openFixture();
    if (failure === "status") status.mockResolvedValue({ ok: false, reason: "Status failed.", kind: "failed" });
    if (failure === "baseline") before.mockResolvedValue({ ok: false, reason: "Baseline failed." });
    if (failure === "disk") disk.mockReturnValue(undefined);
    await sidebar.onMessage(request, "local");
    expect(sidebar.host.openDiff).not.toHaveBeenCalled();
    expect(sidebar.post).toHaveBeenCalledWith({ type: "error", text: expect.stringMatching(/\S.+[.!]$/) });
  });
});

describe("turn diff request fences", () => {
  function requestFixture() {
    const { sidebar, session } = fixture();
    sidebar.turnDiffBaselines.set("turn", { root: "/repo", sha: SHA });
    const status = vi.spyOn(git, "readGitStatus").mockResolvedValue({ ok: true, snapshot: {
      ...emptyGitStatus(), files: [{ path: "a.ts", status: "M", added: 2, deleted: 2 }],
    } });
    const diff = vi.spyOn(git, "readGitFileDiff").mockResolvedValue({ ok: true, patch: "patch", truncated: false, untracked: false });
    const request = { type: "turnFileDiff", requestId: "request", turnId: "turn", cwd: "/repo", path: "a.ts" };
    return { sidebar, session, status, diff, request };
  }
  it.each(["local", "remote"])("serves %s using the host SHA even if a client smuggles a ref field", async origin => {
    const { sidebar, diff, request } = requestFixture();
    await sidebar.onMessage({ ...request, baseline: "--output=evil", ref: "HEAD" }, origin, origin === "remote" ? "phone" : undefined);
    expect(diff).toHaveBeenCalledWith("/repo", "a.ts", { baseline: SHA, untracked: false });
    const reply = origin === "local" ? sidebar.post.mock.calls[0][0] : sidebar.sendRemoteRequester.mock.calls[0][1];
    expect(reply).toMatchObject({ ...request, type: "turnFileDiffResult", ok: true, patch: "patch" });
    expect(reply).not.toHaveProperty("baseline");
    if (origin === "remote") expect(sidebar.post).not.toHaveBeenCalled();
  });
  it.each([
    { cwd: "/other" }, { turnId: SHA }, { turnId: "expired" }, { path: "../secret" }, { path: "unchanged.ts" },
  ])("refuses a request outside its root, turn or current changed-path fence: %j", async over => {
    const { sidebar, diff, request } = requestFixture();
    await sidebar.onMessage({ ...request, ...over }, "local");
    expect(diff).not.toHaveBeenCalled();
    expect(sidebar.post.mock.calls[0][0].ok).toBe(false);
  });
  it("does not allow a turn from another repository", async () => {
    const { sidebar, diff, request } = requestFixture();
    sidebar.turnDiffBaselines.set("turn", { root: "/other", sha: SHA });
    await sidebar.onMessage(request, "local");
    expect(diff).not.toHaveBeenCalled();
  });
  it("answers an unfinished capture immediately without running git", async () => {
    const { sidebar, diff, status, request } = requestFixture();
    sidebar.turnDiffBaselines.set("turn", { root: "/repo" });
    await sidebar.onMessage(request, "local");
    expect(status).not.toHaveBeenCalled();
    expect(diff).not.toHaveBeenCalled();
    expect(sidebar.post.mock.calls[0][0].ok).toBe(false);
  });
  it("keeps the whole-file no-index path for currently untracked files", async () => {
    const { sidebar, diff, status, request } = requestFixture();
    status.mockResolvedValue({ ok: true, snapshot: { ...emptyGitStatus(), files: [{ path: "a.ts", status: "?", added: null, deleted: null }] } });
    await sidebar.onMessage(request, "local");
    expect(diff).toHaveBeenCalledWith("/repo", "a.ts", { baseline: SHA, untracked: true });
  });
  it.each(["local", "remote"])("uses the stored blob before consulting status on %s, without exposing it", async origin => {
    const { sidebar, diff, status, request } = requestFixture();
    sidebar.turnDiffBaselines.get("turn").untracked = new Map([["a.ts", BLOB]]);
    await sidebar.onMessage({ ...request, baselineBlob: "--output=evil", untracked: new Map() }, origin, origin === "remote" ? "phone" : undefined);
    expect(status).not.toHaveBeenCalled();
    expect(diff).toHaveBeenCalledWith("/repo", "a.ts", { baselineBlob: BLOB });
    const reply = origin === "local" ? sidebar.post.mock.calls[0][0] : sidebar.sendRemoteRequester.mock.calls[0][1];
    expect(reply).toEqual({ ...request, type: "turnFileDiffResult", ok: true, patch: "patch", truncated: false });
  });
  it("reports a missing mapped file using the existing failure shape", async () => {
    const { sidebar, diff, status, request } = requestFixture();
    sidebar.turnDiffBaselines.get("turn").untracked = new Map([["a.ts", BLOB]]);
    diff.mockResolvedValue({ ok: false, reason: "could not open 'a.ts' for reading" });
    await sidebar.onMessage(request, "local");
    expect(status).not.toHaveBeenCalled();
    expect(sidebar.post).toHaveBeenCalledWith({ ...request, type: "turnFileDiffResult", ok: false, reason: "could not open 'a.ts' for reading" });
  });
});
