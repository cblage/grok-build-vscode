import { describe, it, expect, vi } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

function start(window: any, turnId?: string, cwd = "/repo") {
  dispatch(window, { type: "userMessage", text: "edit files", chips: [] });
  dispatch(window, { type: "agentStart" });
  if (turnId) dispatch(window, { type: "turnDiffBaseline", turnId, cwd });
}
function edit(window: any, id: string, path = "a.ts", oldText = "old", newText = "new") {
  dispatch(window, { type: "toolCall", call: { toolCallId: id, kind: "edit", title: "Edit " + path,
    content: [{ type: "diff", path, oldText, newText }] } });
}
const rows = (doc: Document) => [...doc.querySelectorAll(".turn-diff-file")];
const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -10 +10 @@\n-first old\n+first new\n@@ -50 +50 @@\n-second old\n+second new\n";
function respond(window: any, request: any, over: any = {}) {
  dispatch(window, { ...request, type: "turnFileDiffResult", ok: true, patch, truncated: false, ...over });
}

describe("one merged per-file turn diff inline in the card", () => {
  it.each([{}, { remote: true }, { vscode: true }])("renders both sites together without revealing a tool row (%j)", opts => {
    const { window, doc, posted } = bootWebview(opts);
    start(window, "turn-one");
    edit(window, "a1");
    edit(window, "b1", "b.ts");
    edit(window, "a2", "a.ts", "another old", "another new");
    dispatch(window, { type: "agentEnd" });
    const row = rows(doc)[0];
    click(window, row);
    const request = posted.find(m => m.type === "turnFileDiff")!;
    expect(request).toMatchObject({ cwd: "/repo", turnId: "turn-one", path: "a.ts" });
    expect(request).not.toHaveProperty("baseline");
    respond(window, request);
    const region = row.nextElementSibling!;
    expect(region.className).toBe("turn-file-diff");
    expect(region.closest(".turn-diff-summary")).not.toBeNull();
    expect([...region.querySelectorAll(".tdl-code")].map(e => e.textContent)).toEqual([
      "first old", "first new", "second old", "second new",
    ]);
    expect([...region.querySelectorAll(".tdl-num")].map(e => e.textContent)).toEqual(["10", "10", "50", "50"]);
    expect(row.querySelector(".diff-stat-add")!.textContent).toBe("+2");
    expect(row.querySelector(".diff-stat-del")!.textContent).toBe("−2");
    expect(doc.querySelector(".tool-item.expanded, .tool-item-flat.expanded")).toBeNull();
    expect(posted.some(m => m.type === "openDiff")).toBe(false);
    click(window, row);
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(doc.querySelector(".turn-file-diff")).toBeNull();
  });

  it("keeps each old card's identity even when a later turn edits the same path", () => {
    const { window, doc, posted } = bootWebview();
    start(window, "old-turn");
    edit(window, "old-edit");
    dispatch(window, { type: "agentEnd" });
    const oldRow = rows(doc)[0];
    start(window, "new-turn");
    edit(window, "new-edit");
    click(window, oldRow);
    expect(posted.at(-1)).toMatchObject({ type: "turnFileDiff", turnId: "old-turn" });
    respond(window, posted.at(-1));
    expect(oldRow.nextElementSibling!.textContent).toContain("first new");
    expect(rows(doc)[1].nextElementSibling).toBeNull();
  });

  it("uses the stamped repository to resolve an absolute tool path", () => {
    const { window, doc, posted } = bootWebview();
    start(window, "turn", "C:/repo");
    edit(window, "absolute", "C:\\repo\\dir\\a.ts");
    click(window, rows(doc)[0]);
    expect(posted.at(-1)).toMatchObject({ type: "turnFileDiff", cwd: "C:/repo", path: "dir/a.ts" });
    respond(window, posted.at(-1));
  });

  it.each(["old host", "non-git", "loaded session"])("keeps the tool-row fallback with no identity: %s", () => {
    const { window, doc, posted } = bootWebview();
    start(window);
    edit(window, "fallback");
    click(window, rows(doc)[0]);
    expect(posted.some(m => m.type === "turnFileDiff")).toBe(false);
    expect(doc.querySelector(".tool-item.expanded, .tool-item-flat.expanded")).not.toBeNull();
  });

  it.each(["capture pending", "evicted", "failed", "path no longer changed"])("falls back when the host cannot supply a diff: %s", reason => {
    const { window, doc, posted } = bootWebview();
    start(window, "turn");
    edit(window, "fallback");
    click(window, rows(doc)[0]);
    respond(window, posted.at(-1), { ok: false, reason });
    expect(doc.querySelector(".turn-file-diff")).toBeNull();
    expect(doc.querySelector(".tool-item.expanded, .tool-item-flat.expanded")).not.toBeNull();
  });

  it("does not inherit the previous turn identity after an ordinary boundary or clear", () => {
    const { window, doc, posted } = bootWebview();
    start(window, "old");
    edit(window, "old");
    dispatch(window, { type: "clearMessages" });
    start(window);
    edit(window, "restored");
    click(window, rows(doc)[0]);
    expect(posted.some(m => m.type === "turnFileDiff")).toBe(false);
  });

  it("ignores mismatched and late replies after a row was repainted", () => {
    const { window, doc, posted } = bootWebview();
    start(window, "turn");
    edit(window, "a1");
    click(window, rows(doc)[0]);
    const request = posted.at(-1)!;
    for (const over of [{ turnId: "other" }, { cwd: "/other" }, { path: "b.ts" }, { requestId: "other" }]) {
      respond(window, request, over);
      expect(doc.querySelector(".turn-file-diff")!.textContent).toBe("Loading diff…");
    }
    edit(window, "a2");
    respond(window, request);
    expect(doc.querySelector(".turn-file-diff")).toBeNull();
    expect(doc.querySelector(".tool-item.expanded, .tool-item-flat.expanded")).toBeNull();
  });

  it("ignores replies after collapse and reads fresh contents when reopened", () => {
    const { window, doc, posted } = bootWebview();
    start(window, "turn");
    edit(window, "a1");
    const row = rows(doc)[0];
    click(window, row);
    const first = posted.at(-1)!;
    click(window, row);
    click(window, row);
    const second = posted.at(-1)!;
    respond(window, first);
    expect(row.nextElementSibling!.textContent).toBe("Loading diff…");
    respond(window, second);
    expect(row.nextElementSibling!.textContent).toContain("first new");
  });

  it("shows deleted files through the same renderer", () => {
    const { window, doc, posted } = bootWebview();
    start(window, "turn");
    dispatch(window, { type: "toolCall", call: { toolCallId: "delete", kind: "delete", title: "Delete a.ts", locations: [{ path: "a.ts" }] } });
    click(window, rows(doc)[0]);
    respond(window, posted.at(-1), { patch: "@@ -1,2 +0,0 @@\n-one\n-two\n" });
    expect(doc.querySelectorAll(".turn-file-diff .tdl-del")).toHaveLength(2);
  });

  it.each([
    ["", false, "No changes since this turn started."],
    ["Binary files a/a.ts and b/a.ts differ", false, "No text diff available"],
    [patch, true, "Diff truncated"],
  ])("makes empty, binary and truncated patches explicit", (text, truncated, expected) => {
    const { window, doc, posted } = bootWebview();
    start(window, "turn");
    edit(window, "a1");
    click(window, rows(doc)[0]);
    respond(window, posted.at(-1), { patch: text, truncated });
    expect(doc.querySelector(".turn-file-diff")!.textContent).toContain(expected);
  });

  it("uses the shared preview cap and escapes code as text", () => {
    const { window, doc, posted } = bootWebview();
    start(window, "turn");
    edit(window, "a1");
    click(window, rows(doc)[0]);
    respond(window, posted.at(-1), { patch: "@@ -0,0 +1,90 @@\n+<img src=x>\n" + "+line\n".repeat(89) });
    const region = doc.querySelector(".turn-file-diff")!;
    expect(region.querySelector("img")).toBeNull();
    expect(region.querySelector(".tdl-code")!.textContent).toBe("<img src=x>");
    expect(region.querySelectorAll(".tdl[hidden]").length).toBeGreaterThan(0);
    click(window, region.querySelector(".tool-diff-toggle")!);
    expect(region.querySelectorAll(".tdl[hidden]")).toHaveLength(0);
  });

  it("falls back if a request times out", () => {
    vi.useFakeTimers();
    try {
      const { window, doc } = bootWebview({ beforeScripts: window => {
        window.setTimeout = setTimeout as any;
        window.clearTimeout = clearTimeout as any;
      } });
      start(window, "turn");
      edit(window, "a1");
      click(window, rows(doc)[0]);
      vi.advanceTimersByTime(60001);
      expect(doc.querySelector(".turn-file-diff")).toBeNull();
      expect(doc.querySelector(".tool-item.expanded, .tool-item-flat.expanded")).not.toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it.each([false, true])("shares the 400-line budget and offers the whole diff only on a desk (remote=%s)", remote => {
    const { window, doc, posted } = bootWebview({ remote });
    start(window, "turn");
    edit(window, "a1");
    click(window, rows(doc)[0]);
    const text = "@@ -0,0 +1,250 @@\n" + "+first\n".repeat(250)
      + "@@ -400,0 +650,250 @@\n" + "+second\n".repeat(250);
    respond(window, posted.at(-1), { patch: text });
    const region = doc.querySelector(".turn-file-diff")!;
    expect(region.querySelectorAll(".tdl")).toHaveLength(400);
    expect(region.textContent).toContain("second");
    expect(region.textContent).toContain("100 more line(s) — preview limit reached");
    // The cap is why the desk needs an escape hatch. A phone has no editor,
    // so it must never offer a host-local action that the relay will drop.
    if (remote) {
      expect(region.querySelector(".preview-link")).toBeNull();
      expect(region.textContent).not.toContain("open diff");
    } else {
      expect(region.textContent).toContain("open diff →");
      click(window, region.querySelector(".preview-link")!);
      expect(posted.at(-1)).toEqual({ type: "turnFileOpenDiff", turnId: "turn", cwd: "/repo", path: "a.ts" });
      expect(region.isConnected).toBe(true);
    }
  });

  it.each([false, true])("opens even a short diff through the host with its original turn and cwd (previewInApp=%s)", previewInApp => {
    const { window, doc, posted } = bootWebview({ vscode: !previewInApp });
    dispatch(window, { type: "initialState", capabilities: { previewInApp } });
    start(window, "old-turn", "C:/repo");
    edit(window, "old-edit", "C:/repo/dir/a.ts");
    dispatch(window, { type: "agentEnd" });
    const oldRow = rows(doc)[0];
    start(window, "new-turn", "C:/other");
    edit(window, "new-edit");
    click(window, oldRow);
    respond(window, posted.at(-1));
    click(window, oldRow.nextElementSibling!.querySelector(".preview-link")!);
    expect(posted.at(-1)).toEqual({ type: "turnFileOpenDiff", turnId: "old-turn", cwd: "C:/repo", path: "dir/a.ts" });
  });

  it.each([
    { over: { patch: "" }, note: "No changes since this turn started." },
    { over: { patch: "diff --git a/a.ts b/a.ts\nBinary files a/a.ts and b/a.ts differ\n" },
      note: "No text diff available for this file." },
  ])("offers no editor tab where there is no text diff to open: $note", ({ over, note }) => {
    // The button promises the whole diff. With nothing parsed there is no whole
    // diff: the first row would open two identical sides, and the second two
    // screens of mojibake, since our sides are grok-diff: text documents rather
    // than files and VS Code's native image diff never applies to them.
    const { window, doc, posted } = bootWebview();
    start(window, "turn");
    edit(window, "a1");
    click(window, rows(doc)[0]);
    respond(window, posted.at(-1), over);
    const region = rows(doc)[0].nextElementSibling!;
    expect(region.textContent).toContain(note);
    expect(region.querySelector(".preview-link")).toBeNull();
    expect(posted.some(m => m.type === "turnFileOpenDiff")).toBe(false);
  });
});

describe("a row with nothing to fall back to says why", () => {
  // A deleted file has no edit tool call, so `lastCallByPath` never names it
  // and there is no tool row to reveal. Before the baseline existed the row was
  // not a button at all; now it is, and a host failure must not leave a button
  // that does nothing when pressed.
  const deleteRow = (window: any, doc: Document) => {
    start(window, "turn");
    dispatch(window, { type: "toolCall", call: { toolCallId: "delete", kind: "delete", title: "Delete a.ts", locations: [{ path: "a.ts" }] } });
    return [...doc.querySelectorAll(".turn-diff-file")][0];
  };

  it("keeps the region and shows the host's reason", () => {
    const { window, doc, posted } = bootWebview();
    const row = deleteRow(window, doc);
    click(window, row);
    respond(window, posted.at(-1), { ok: false, reason: "This turn's diff is no longer available." });
    const region = doc.querySelector(".turn-file-diff")!;
    expect(region).not.toBeNull();
    expect(region.textContent).toContain("no longer available");
    expect(row.getAttribute("aria-expanded")).toBe("true");
  });

  it("says something even when the failure carries no reason", () => {
    const { window, doc, posted } = bootWebview();
    const row = deleteRow(window, doc);
    click(window, row);
    respond(window, posted.at(-1), { ok: false, reason: undefined });
    expect(doc.querySelector(".turn-file-diff")!.textContent).toContain("Could not read");
  });

  it("still lets the row collapse afterwards", () => {
    const { window, doc, posted } = bootWebview();
    const row = deleteRow(window, doc);
    click(window, row);
    respond(window, posted.at(-1), { ok: false, reason: "nope" });
    click(window, row);
    expect(doc.querySelector(".turn-file-diff")).toBeNull();
    expect(row.getAttribute("aria-expanded")).toBe("false");
  });
});
