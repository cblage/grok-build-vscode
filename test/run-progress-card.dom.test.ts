// The Workflow / Goal / Deep-research progress card, driven through the REAL
// media/chat.js in happy-dom.
//
// #163 ("Workflow enhancements", leriksen71LJR): *"Workflows also tend to
// stall and not show the right progress ... Grok tells me the progress is
// never accurate."* He was right, and the cause was arithmetic rather than
// rendering: a workflow's percentage was `agents_used / agent_budget` — money
// spent — printed in the same slot, in the same shape, as the Goal card's
// `completed / total`, which is real completion. One number was a fuel gauge
// and the other a finish line, and nothing on screen said which.
//
// The parse side is pinned in test/run-progress.test.ts. What only a DOM test
// can pin is the SLOT: that a workflow row shows no bare `%` at all, that a
// goal still does, and that a workflow carries something that moves while one
// agent works for twenty minutes — otherwise "still going" and "wedged" look
// identical, which is the other half of the report.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch } from "./webview-harness";

const card = (doc: Document, id: string) =>
  doc.querySelector(`.run-progress-card[data-run-id="${id}"]`) as HTMLElement | null;
const phase = (doc: Document, id: string) =>
  card(doc, id)?.querySelector(".run-progress-phase")?.textContent ?? "";
const detail = (doc: Document, id: string) =>
  card(doc, id)?.querySelector(".run-progress-detail")?.textContent ?? "";
const elapsed = (doc: Document, id: string) =>
  card(doc, id)?.querySelector(".run-progress-elapsed") as HTMLElement | null;

/** What src/run-progress.ts hands the webview for a live workflow. */
function workflowUpdate(over: Record<string, unknown> = {}) {
  return {
    kind: "workflow",
    id: "run-abc",
    title: "deep-research-2",
    phase: "strategy",
    detail: "agent_started: researcher · 1/50 agents",
    agentsUsed: 1,
    agentBudget: 50,
    done: false,
    failed: false,
    cancelled: false,
    displayName: "deep-research-2",
    sessionUpdate: "workflow_updated",
    ...over,
  };
}

describe("a workflow row never prints a bare percentage", () => {
  it("shows the phase alone, and the agent spend as a labelled count", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "runProgress", update: workflowUpdate() });
    // "strategy 2%" was the reported screen. 1 of 50 agents is 2% of the
    // BUDGET, and it was being read as 2% of the work.
    expect(phase(doc, "run-abc")).toBe("· strategy");
    expect(phase(doc, "run-abc")).not.toMatch(/%/);
    expect(detail(doc, "run-abc")).toMatch(/1\/50 agents/);
  });

  it("still prints one for a goal, where the fraction is real completion", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "runProgress",
      update: {
        kind: "goal",
        id: "goal",
        title: "Goal",
        phase: "running",
        detail: "1/4 deliverables",
        progress: 0.25,
        done: false,
        failed: false,
        cancelled: false,
        sessionUpdate: "goal_updated",
      },
    });
    expect(phase(doc, "goal")).toBe("· running 25%");
  });
});

describe("a live run carries an elapsed clock", () => {
  it("arms one on the row, so a run with no moving number still moves", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "runProgress", update: workflowUpdate() });
    const out = elapsed(doc, "run-abc");
    expect(out).not.toBeNull();
    expect(out!.textContent).toMatch(/^· \d+s$/);
  });

  it("keeps counting across updates instead of restarting at zero", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "runProgress", update: workflowUpdate() });
    const row = card(doc, "run-abc")!.querySelector(".run-progress-row") as any;
    const started = row._waitStart;
    // A resumed run has not been running for zero seconds, and neither has a
    // run that simply reported a new phase.
    dispatch(window, { type: "runProgress", update: workflowUpdate({ phase: "executing" }) });
    expect((card(doc, "run-abc")!.querySelector(".run-progress-row") as any)._waitStart).toBe(started);
    expect(phase(doc, "run-abc")).toBe("· executing");
  });

  it("stops the interval when the run finishes, leaving the duration on screen", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "runProgress", update: workflowUpdate() });
    dispatch(window, {
      type: "runProgress",
      update: workflowUpdate({ phase: "completed", done: true, detail: "All checks green" }),
    });
    const row = card(doc, "run-abc")!.querySelector(".run-progress-row") as any;
    expect(row._waitTimer).toBeNull();
    expect(elapsed(doc, "run-abc")!.textContent).toMatch(/^· \d/);
    expect(phase(doc, "run-abc")).toBe("· done");
  });
});

describe("the phase slot shows a word, not a wire identifier", () => {
  // The other half of "is this the only one?" — the event name is handled in
  // src/run-progress.ts, but the phase reaches the row raw, and it is
  // snake_case in exactly the cases that matter most: a run that ran out of
  // budget, or one whose phase field never arrived so the parser fell back to
  // the `workflow_*` discriminator.
  it("spaces out a snake_case terminal phase", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "runProgress",
      update: workflowUpdate({ phase: "budget_exceeded", done: true, failed: true }),
    });
    expect(phase(doc, "run-abc")).toBe("· failed");

    dispatch(window, {
      type: "runProgress",
      update: workflowUpdate({ id: "run-limited", phase: "budget_limited", done: true }),
    });
    expect(phase(doc, "run-limited")).toBe("· budget limited");
  });

  it("does not disturb the pause control, which reads the machine value", () => {
    // `/paus/` is tested against update.phase, not against what is on screen,
    // so humanising the label must not flip Pause to Resume or back.
    const { window, doc } = bootWebview();
    dispatch(window, { type: "runProgress", update: workflowUpdate({ phase: "paused_for_review" }) });
    expect(phase(doc, "run-abc")).toBe("· paused for review");
    const labels = [...card(doc, "run-abc")!.querySelectorAll(".run-progress-btn")]
      .map((b) => b.textContent);
    expect(labels).toEqual(["Resume", "Stop"]);
  });
});

describe("the liveness dots cannot be mistaken for a truncated run name", () => {
  // The owner's first look at a card built from REAL captured frames:
  // "those dots in the middle" — they sat immediately after the title, and
  // `.run-progress-title` is `text-overflow: ellipsis`, so a long name really
  // does end in "…". Two different meanings drawn identically, one pixel
  // apart. They belong after the phase, pulsing on what is in progress.
  const order = (doc: Document) =>
    [...(card(doc, "run-abc")!.querySelector(".run-progress-row") as HTMLElement).children]
      .map((c) => c.className.split(" ")[0]);

  it("puts them after the phase, never between the title and it", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "runProgress", update: workflowUpdate() });
    const seq = order(doc);
    expect(seq.indexOf("blink-dots")).toBeGreaterThan(seq.indexOf("run-progress-phase"));
    expect(seq.indexOf("run-progress-phase")).toBe(seq.indexOf("run-progress-title") + 1);
  });

  it("restores them to the same place when a finished run resumes", () => {
    // The resume path re-inserts the dots with its own anchor, so it is the
    // one place this can silently diverge from the template.
    const { window, doc } = bootWebview();
    dispatch(window, { type: "runProgress", update: workflowUpdate() });
    dispatch(window, { type: "runProgress", update: workflowUpdate({ phase: "completed", done: true }) });
    expect(order(doc)).not.toContain("blink-dots");
    dispatch(window, { type: "runProgress", update: workflowUpdate({ phase: "executing" }) });
    const seq = order(doc);
    expect(seq.indexOf("blink-dots")).toBeGreaterThan(seq.indexOf("run-progress-phase"));
  });
});
