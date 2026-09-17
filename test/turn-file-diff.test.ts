import { afterEach, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import { gitDiffArgs, gitTurnDiffArgs, GIT_TURN_BASELINE_ARGS, parseGitBaseline } from "../src/git-status";
import { captureGitTurnBaseline, GIT_BASELINE_TIMEOUT_MS, GIT_DIFF_MAX_BYTES, readGitFileDiff, type GitIo } from "../src/git-run";
import { parseUnifiedDiff, patchRowsToDiffHunks } from "../media/file-panel.js";
import { parseWebviewMsg } from "../src/desktop/webview-msg-validate";
import { INBOUND_DISPOSITION, OUTBOUND_DISPOSITION, OUTBOUND_PROJECT_AUTH, REMOTE_REQUIRES_BOUND_SESSION,
  allowFromRemote, allowRemoteRepoTarget, mayDeliverRemoteHostMsg } from "../src/remote-policy";

vi.mock("node:fs/promises", () => ({ stat: vi.fn() }));

const HEAD = "a".repeat(40);
const STASH = "b".repeat(40);
const BLOB = "c".repeat(40);
afterEach(() => vi.restoreAllMocks());

function fakeGit(replies: Array<{ stdout?: string; error?: unknown }>) {
  const calls: Array<{ args: string[]; opts: any; input: string }> = [];
  const io: GitIo = { execFile: ((_: string, args: string[], opts: any, cb: Function) => {
    const call = { args, opts, input: "" };
    calls.push(call);
    const stdin = new PassThrough();
    stdin.on("data", chunk => { call.input += chunk.toString(); });
    const reply = replies.shift() || {};
    queueMicrotask(() => cb(reply.error || null, reply.stdout || "", ""));
    return { stdin };
  }) as any };
  return { io, calls };
}

describe("turn baselines", () => {
  it("constructs a host-ref diff without changing the HEAD default or path operand", () => {
    expect(gitDiffArgs("dir/a b.ts")).toEqual(["diff", "HEAD", "--", "dir/a b.ts"]);
    expect(gitDiffArgs("-file.ts", STASH)).toEqual(["diff", STASH, "--", "-file.ts"]);
    expect(gitTurnDiffArgs("a[1].ts", STASH)).toEqual(["--literal-pathspecs", "diff", STASH, "--", "a[1].ts"]);
    expect(GIT_TURN_BASELINE_ARGS).toEqual(["stash", "create"]);
  });

  it.each([HEAD, "c".repeat(64)])("accepts complete Git object ids", (sha) => {
    expect(parseGitBaseline(sha + "\n")).toBe(sha);
  });
  it.each(["", "HEAD", "--output=oops", "abc123", HEAD + "\n" + STASH, "fatal: bad", "f".repeat(41)])("rejects %s", (out) => {
    expect(parseGitBaseline(out)).toBeUndefined();
  });

  it("captures stash without updating a ref and uses a bounded hidden process", async () => {
    const { io, calls } = fakeGit([{ stdout: HEAD }, { stdout: STASH + "\n" }]);
    expect(await captureGitTurnBaseline("/repo", { io })).toEqual({ sha: STASH });
    expect(calls.map(c => c.args)).toEqual([
      ["-C", "/repo", "rev-parse", "--verify", "HEAD"], ["-C", "/repo", "stash", "create"],
      ["-C", "/repo", "ls-files", "--others", "--exclude-standard", "-z", "--full-name"],
    ]);
    for (const { opts } of calls) expect(opts).toMatchObject({
      timeout: GIT_BASELINE_TIMEOUT_MS, windowsHide: true, env: { GIT_OPTIONAL_LOCKS: "0" },
    });
  });
  it("uses the captured HEAD only for a successful empty stash", async () => {
    const { io } = fakeGit([{ stdout: HEAD }, {}]);
    expect(await captureGitTurnBaseline("/repo", { io })).toEqual({ sha: HEAD });
  });
  it.each([
    new Error("index.lock exists"), Object.assign(new Error("timed out"), { killed: true }),
    Object.assign(new Error("spawn failed"), { code: "ENOENT" }),
  ])("never falls back to HEAD on a stash failure", async error => {
    const { io } = fakeGit([{ stdout: HEAD }, { stdout: STASH, error }]);
    expect(await captureGitTurnBaseline("/repo", { io })).toBeUndefined();
  });
  it("does not attempt stash in an unborn or non-git directory", async () => {
    const { io, calls } = fakeGit([{ error: new Error("no HEAD") }]);
    expect(await captureGitTurnBaseline("/repo", { io })).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
  it("does not turn malformed stash output into HEAD", async () => {
    const { io } = fakeGit([{ stdout: HEAD }, { stdout: "oops" }]);
    expect(await captureGitTurnBaseline("/repo", { io })).toBeUndefined();
  });
  it("stats candidates and hashes survivors in one C-quoted stdin batch, preserving order", async () => {
    const stat = vi.spyOn(fs, "stat").mockResolvedValue({ isFile: () => true, size: 12 } as any);
    const paths = ["a[1].ts", "dir/a b.ts", 'quote"slash\\tab\tline\n.ts', "-option.ts", "é.ts"];
    const { io, calls } = fakeGit([{ stdout: HEAD }, {}, { stdout: paths.join("\0") + "\0" },
      { stdout: [BLOB, STASH, BLOB, STASH, BLOB].join("\n") + "\n" }]);
    const baseline = await captureGitTurnBaseline("/repo", { io });
    expect(stat).toHaveBeenCalledTimes(paths.length);
    expect(baseline?.untracked).toEqual(new Map(paths.map((path, i) => [path, i % 2 ? STASH : BLOB])));
    expect(calls[3].args).toEqual(["-C", "/repo", "hash-object", "-w", "--stdin-paths"]);
    expect(calls[3].input).toBe('"a[1].ts"\n"dir/a b.ts"\n"quote\\042slash\\134tab\\011line\\012.ts"\n"-option.ts"\n"é.ts"\n');
    expect(calls[3].opts).toMatchObject({ timeout: GIT_BASELINE_TIMEOUT_MS, env: { GIT_OPTIONAL_LOCKS: "0" } });
  });
  it("drops missing and non-file candidates before hashing", async () => {
    vi.spyOn(fs, "stat").mockRejectedValueOnce(new Error("gone"))
      .mockResolvedValueOnce({ isFile: () => false, size: 0 } as any);
    const { io, calls } = fakeGit([{ stdout: HEAD }, {}, { stdout: "missing\0directory/\0" }]);
    expect(await captureGitTurnBaseline("/repo", { io })).toEqual({ sha: HEAD });
    expect(calls).toHaveLength(3);
  });
  it("keeps the tracked baseline when listing fails", async () => {
    const { io } = fakeGit([{ stdout: HEAD }, {}, { error: new Error("ls-files failed") }]);
    expect(await captureGitTurnBaseline("/repo", { io })).toEqual({ sha: HEAD });
  });
  it.each([
    { stdout: BLOB }, { stdout: BLOB + "\noops\n" }, { stdout: [BLOB, BLOB, BLOB].join("\n") },
    { stdout: BLOB + "\n" + BLOB, error: new Error("hash failed") },
  ])("never records a partial or malformed hash batch: %j", async reply => {
    vi.spyOn(fs, "stat").mockResolvedValue({ isFile: () => true, size: 12 } as any);
    const { io } = fakeGit([{ stdout: HEAD }, {}, { stdout: "a.ts\0b.ts\0" }, reply]);
    expect(await captureGitTurnBaseline("/repo", { io })).toEqual({ sha: HEAD });
  });
  it("writes the current blob and diffs objects even when the current status is untracked", async () => {
    const { io, calls } = fakeGit([{ stdout: BLOB }, { stdout: "patch" }]);
    expect(await readGitFileDiff("/repo", "-a[1].ts", { io, baseline: HEAD, baselineBlob: STASH, untracked: true }))
      .toMatchObject({ ok: true, patch: "patch" });
    expect(calls.map(c => c.args)).toEqual([
      ["-C", "/repo", "hash-object", "-w", "--", "-a[1].ts"],
      ["-C", "/repo", "diff", STASH, BLOB],
    ]);
    expect(calls[1].opts.maxBuffer).toBe(GIT_DIFF_MAX_BYTES + 1024);
  });
  it.each([{ error: new Error("file gone") }, { stdout: "malformed" }])("does not diff when hashing fails: %j", async reply => {
    const { io, calls } = fakeGit([reply]);
    expect(await readGitFileDiff("/repo", "a.ts", { io, baselineBlob: STASH }))
      .toMatchObject({ ok: false, reason: expect.any(String) });
    expect(calls).toHaveLength(1);
  });
  it("returns an unchanged blob as a successful empty patch", async () => {
    const { io } = fakeGit([{ stdout: BLOB }, {}]);
    expect(await readGitFileDiff("/repo", "a.ts", { io, baselineBlob: BLOB }))
      .toMatchObject({ ok: true, patch: "", truncated: false });
  });
  it("passes only the chosen base to the existing capped diff reader", async () => {
    const { io, calls } = fakeGit([{ stdout: "patch" }]);
    expect(await readGitFileDiff("/repo", "a.ts", { io, baseline: STASH })).toMatchObject({ ok: true, patch: "patch" });
    expect(calls[0].args).toEqual(["-C", "/repo", "--literal-pathspecs", "diff", STASH, "--", "a.ts"]);
  });
  it("retains the patch cap and reports truncation", async () => {
    const { io, calls } = fakeGit([{ stdout: "+".repeat(GIT_DIFF_MAX_BYTES + 10) }]);
    const result = await readGitFileDiff("/repo", "a.ts", { io, baseline: STASH });
    expect(calls[0].opts.maxBuffer).toBe(GIT_DIFF_MAX_BYTES + 1024);
    expect(result.ok && result.truncated).toBe(true);
    expect(result.ok && result.patch.length).toBe(GIT_DIFF_MAX_BYTES);
  });
});

describe("parsed patch rows become the existing inline hunk shape", () => {
  it("renders SHA headers exactly like path headers", () => {
    const hunk = "@@ -9 +9,2 @@\n before\n+added\n";
    const blobPatch = `diff --git a/${STASH} b/${BLOB}\nindex ${STASH}..${BLOB} 100644\n--- a/${STASH}\n+++ b/${BLOB}\n${hunk}`;
    expect(patchRowsToDiffHunks(parseUnifiedDiff(blobPatch)))
      .toEqual(patchRowsToDiffHunks(parseUnifiedDiff("diff --git a/b.md b/b.md\n--- a/b.md\n+++ b/b.md\n" + hunk)));
  });
  it("preserves disjoint hunks, line numbers and text while excluding metadata", () => {
    const patch = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -10,2 +10,2 @@ fn\n-old\n+<new>\n context\n@@ -50 +60 @@\n-away\n+back\n\\ No newline at end of file\n";
    expect(patchRowsToDiffHunks(parseUnifiedDiff(patch))).toEqual([
      { site: { oldLine: 10, newLine: 10 }, result: { lines: [
        { type: "del", text: "old" }, { type: "add", text: "<new>" }, { type: "ctx", text: "context" },
      ] } },
      { site: { oldLine: 50, newLine: 60 }, result: { lines: [
        { type: "del", text: "away" }, { type: "add", text: "back" },
      ] } },
    ]);
  });
  it.each(["", "Binary files a/a and b/a differ\n", "old mode 100644\nnew mode 100755\n"])("does not invent text hunks", patch => {
    expect(patchRowsToDiffHunks(parseUnifiedDiff(patch))).toEqual([]);
  });
  it.each([
    ["@@ -0,0 +1,2 @@\n+one\n+two\n", { newLine: 1 }, "add"],
    ["@@ -35,2 +34,0 @@\n-one\n-two\n", { oldLine: 35 }, "del"],
  ])("supports pure additions and deletions", (patch, site, type) => {
    expect(patchRowsToDiffHunks(parseUnifiedDiff(patch))).toEqual([
      { site, result: { lines: [{ type, text: "one" }, { type, text: "two" }] } },
    ]);
  });
});

describe("turn diff remote policy", () => {
  const openRequest = { type: "turnFileOpenDiff" as const, turnId: "turn", cwd: "/repo", path: "a.ts" };
  it("keeps whole-file turn diff editors host-local in both policy registries", () => {
    expect(INBOUND_DISPOSITION.turnFileOpenDiff).toBe("host-local");
    expect(REMOTE_REQUIRES_BOUND_SESSION.turnFileOpenDiff).toBe(false);
  });
  it("keeps whole-file turn diff editors host-local at every remote tier", () => {
    for (const tier of ["view", "propose", "full"] as const) {
      expect(allowFromRemote("turnFileOpenDiff", tier)).toBe(false);
      expect(allowFromRemote("turnFileOpenDiff", tier, { isCloud: true })).toBe(false);
    }
  });
  it("validates the local editor request without accepting missing or non-string fields", () => {
    expect(parseWebviewMsg(openRequest)).toEqual(openRequest);
    for (const key of ["turnId", "cwd", "path"]) {
      for (const value of [undefined, null, 12, {}, []]) {
        expect(parseWebviewMsg({ ...openRequest, [key]: value })).toBeNull();
      }
    }
  });
  const request = { type: "turnFileDiff" as const, turnId: "turn", requestId: "request", cwd: "/repo", path: "a.ts" };
  const same = (a: string, b: string) => a === b;
  it("validates the new desktop request type and requires identity and correlation", () => {
    expect(parseWebviewMsg(request)).toEqual(request);
    for (const key of ["turnId", "cwd", "path", "requestId"]) {
      expect(parseWebviewMsg({ ...request, [key]: undefined })).toBeNull();
      expect(parseWebviewMsg({ ...request, [key]: 12 })).toBeNull();
    }
  });
  it("allows read-only review at view tier without a bound session, but only in a known repo", () => {
    expect(INBOUND_DISPOSITION.turnFileDiff).toBe("view");
    expect(REMOTE_REQUIRES_BOUND_SESSION.turnFileDiff).toBe(false);
    expect(allowFromRemote("turnFileDiff", "view")).toBe(true);
    expect(allowRemoteRepoTarget(request, cwd => cwd === "/repo")).toBe(true);
    expect(allowRemoteRepoTarget(request, () => false)).toBe(false);
  });
  it("scopes identity to the session and rechecks the result cwd against the live catalog", () => {
    expect(OUTBOUND_DISPOSITION.turnDiffBaseline).toBe("mirror");
    expect(OUTBOUND_DISPOSITION.turnFileDiffResult).toBe("mirror");
    expect(OUTBOUND_PROJECT_AUTH.turnDiffBaseline).toBe("scope");
    expect(OUTBOUND_PROJECT_AUTH.turnFileDiffResult).toBe("message-cwd");
    const baseline = { type: "turnDiffBaseline" as const, turnId: "turn", cwd: "/repo" };
    expect(mayDeliverRemoteHostMsg(baseline, ["/repo"], "/repo", same)).toBe(true);
    expect(mayDeliverRemoteHostMsg(baseline, ["/repo"], "/other", same)).toBe(false);
    const result = { ...request, type: "turnFileDiffResult" as const, ok: true as const, patch: "", truncated: false };
    expect(mayDeliverRemoteHostMsg(result, ["/repo"], "/other", same)).toBe(true);
    expect(mayDeliverRemoteHostMsg(result, [], "/repo", same)).toBe(false);
  });
});
