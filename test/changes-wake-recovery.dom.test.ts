/**
 * A machine waking up must not strand the Changes view.
 *
 * The owner, on a phone, with his desk machine asleep: *"When waking up my
 * machine after clicking to Open Changes I initially saw Loading diff but was
 * switched to Folders. Then after manually switching to Changes the file never
 * ended loading. Only after navigating back to all changes and opening a file
 * I saw its changes."*
 *
 * Three symptoms, one cause. Every field the panel's scope is built from
 * coerces absent to `""` on the way here (`msg.cwd || ""`, `msg.activeCwd ||
 * ""`), so a wake snapshot that arrives before the host has rebound its
 * workspace reaches the panel as a NULL scope — indistinguishable from a closed
 * folder. `setScope` read that as a project switch, which leaves Changes and
 * resets to Folders (symptom 1) and replaces the scope-state object, which
 * fences the answer to the read in flight so `diffLoading` is never cleared by
 * anybody (symptom 2). `refreshDisplayed` then declines to re-ask *because*
 * `diffLoading` is true, so nothing ever repairs it — and only a fresh
 * `openChangeDiff` from the file list did (symptom 3, his workaround).
 *
 * These tests drive the relay message boundary, not the panel's internals: the
 * diff request is deliberately never answered, exactly as a request whose
 * socket has been retired never is.
 */
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click, type Posted, type Harness } from "./webview-harness";

const CWD = "/home/me/aiprototypingtest";
const FILE = "testcontent.md";
const PATCH = [
  "diff --git a/testcontent.md b/testcontent.md",
  "--- a/testcontent.md",
  "+++ b/testcontent.md",
  "@@ -7 +7 @@",
  "-This pass deletes one sentence.",
  "",
].join("\n");

const CAPS = { browseProjectFiles: true, editProjectFiles: true, gitChanges: true };

async function settle() {
  for (let i = 0; i < 4; i++) await Promise.resolve();
  await new Promise<void>((r) => setTimeout(r, 0));
}

function repos(over: Record<string, unknown> = {}) {
  return {
    type: "repos",
    entries: [{ cwd: CWD, label: "aiprototypingtest", available: true, pinned: false, updatedAt: 1 }],
    selectedCwd: CWD,
    activeCwd: CWD,
    workspaceCwd: CWD,
    ...over,
  };
}

const lastOf = (posted: Posted[], type: string) =>
  [...posted].reverse().find((m: any) => m.type === type) as any;
const countOf = (posted: Posted[], type: string) =>
  posted.filter((m: any) => m.type === type).length;

/** Panel open, in Changes, with one file's diff requested and NEVER answered. */
async function openDiffAwaitingAnswer(): Promise<Harness & { panelEl: Element }> {
  const h = bootWebview({ remote: true });
  const { window, doc, posted } = h;
  dispatch(window, { type: "initialState", cwd: CWD, capabilities: CAPS });
  dispatch(window, repos());
  click(window, doc.getElementById("files-browse-btn") as HTMLElement);
  await settle();

  const list = lastOf(posted, "listProjectDir");
  if (list) {
    dispatch(window, {
      type: "projectDirListing", ok: true, cwd: CWD, relPath: "",
      entries: [{ name: FILE, kind: "file" }], requestId: list.requestId,
    });
  }
  const status = lastOf(posted, "gitStatus");
  if (status) {
    dispatch(window, {
      type: "gitStatusResult", ok: true, cwd: CWD, requestId: status.requestId,
      snapshot: { branch: "main", files: [{ path: FILE, status: "modified", added: 0, removed: 1 }] },
    });
  }
  await settle();
  click(window, doc.querySelector(".gfp-changes-btn") as HTMLElement);
  await settle();
  click(window, doc.querySelector(".gfp-change-row") as HTMLElement);
  await settle();
  return { ...h, panelEl: doc.querySelector(".gfp-panel")! };
}

const inChanges = (doc: Document) =>
  !!doc.querySelector(".gfp-panel")?.classList.contains("gfp-changes-mode");
const onDiffSubview = (doc: Document) => !!doc.querySelector(".gfp-changes-diff-head");
const changesText = (doc: Document) =>
  (doc.querySelector(".gfp-changes")?.textContent || "").replace(/\s+/g, " ").trim();

/** The frames a wake produces, with the middle one carrying no project. */
function wake(window: any, { forgetCwd = true } = {}) {
  dispatch(window, { type: "hostLink", link: { reachable: false, phase: "offline" } });
  dispatch(window, forgetCwd
    ? { type: "initialState", capabilities: CAPS }
    : { type: "initialState", cwd: CWD, capabilities: CAPS });
  dispatch(window, forgetCwd
    ? repos({ selectedCwd: undefined, activeCwd: undefined, workspaceCwd: undefined })
    : repos());
  dispatch(window, repos());
  dispatch(window, { type: "hostLink", link: { reachable: true, restored: true, connection: "c2" } });
}

describe("waking the machine with the Changes view open", () => {
  it("stays in Changes when the wake snapshot has not named a project yet", async () => {
    const h = await openDiffAwaitingAnswer();
    expect(inChanges(h.doc), "precondition: in Changes").toBe(true);
    wake(h.window);
    await settle();
    // Not Folders. "The host did not say which project is current" is not
    // "there is no project", and only one of those is a reason to leave.
    expect(inChanges(h.doc)).toBe(true);
    expect((h.doc.querySelector(".gfp-tree") as HTMLElement).hidden).toBe(true);
    expect(onDiffSubview(h.doc)).toBe(true);
  });

  it("re-reads the open diff the wake orphaned, with nothing asked of the user", async () => {
    const h = await openDiffAwaitingAnswer();
    const before = countOf(h.posted, "gitFileDiff");
    wake(h.window);
    await settle();
    // The read that was in flight died with its socket. Something has to ask
    // again, and before this nothing did: the view kept "Reading the diff…"
    // and the re-ask was suppressed by the very flag that text came from.
    const after = countOf(h.posted, "gitFileDiff");
    expect(after).toBeGreaterThan(before);
    const req = lastOf(h.posted, "gitFileDiff");
    expect(req).toMatchObject({ cwd: CWD, path: FILE });
    dispatch(h.window, {
      type: "gitFileDiffResult", ok: true, cwd: CWD, path: FILE,
      patch: PATCH, truncated: false, requestId: req.requestId,
    });
    await settle();
    expect(changesText(h.doc)).toContain("This pass deletes one sentence.");
    expect(changesText(h.doc)).not.toContain("Reading the diff");
  });

  it("re-reads the open diff whenever Changes is re-entered", async () => {
    // The general rule, and the one his workaround stood in for: he went back
    // to all changes and opened the file again, which is the only thing that
    // issued a live request. Entering Changes already re-reads the STATUS on
    // exactly this argument — "a snapshot older than this visit is a snapshot
    // of somebody else's moment" — and it was never applied to the diff.
    const h = await openDiffAwaitingAnswer();
    const toggle = h.doc.querySelector(".gfp-changes-btn") as HTMLElement;
    click(h.window, toggle); // out to Folders
    await settle();
    expect(inChanges(h.doc)).toBe(false);
    const before = countOf(h.posted, "gitFileDiff");
    click(h.window, toggle); // back into Changes
    await settle();
    expect(countOf(h.posted, "gitFileDiff")).toBe(before + 1);
    const req = lastOf(h.posted, "gitFileDiff");
    dispatch(h.window, {
      type: "gitFileDiffResult", ok: true, cwd: CWD, path: FILE,
      patch: PATCH, truncated: false, requestId: req.requestId,
    });
    await settle();
    expect(changesText(h.doc)).toContain("This pass deletes one sentence.");
  });

  it("still treats a real project switch as a switch", async () => {
    // The guard above must not swallow the case it was carved out of. A
    // DIFFERENT project still lands on its own tree: staying in Changes would
    // show one project's branch under another's title.
    const h = await openDiffAwaitingAnswer();
    const OTHER = "/home/me/other";
    dispatch(h.window, {
      type: "repos",
      entries: [
        { cwd: CWD, label: "aiprototypingtest", available: true, pinned: false, updatedAt: 2 },
        { cwd: OTHER, label: "other", available: true, pinned: false, updatedAt: 1 },
      ],
      selectedCwd: OTHER, activeCwd: OTHER, workspaceCwd: OTHER,
    });
    await settle();
    expect(inChanges(h.doc)).toBe(false);
    expect((h.doc.querySelector(".gfp-tree") as HTMLElement).hidden).toBe(false);
  });
});
