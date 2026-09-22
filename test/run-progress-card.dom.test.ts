import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { parseRunProgressUpdate } from "../src/run-progress";
import { bootWebview, dispatch, click, type Harness } from "./webview-harness";

const windows: Harness["window"][] = [];
afterEach(() => { for (const window of windows.splice(0)) window.happyDOM.abort(); });
function boot(options = {}) {
  let now = 100_000;
  const h = bootWebview({ ...options, beforeScripts: (window: Harness["window"]) => {
    (window as any).Date = class extends window.Date { static now() { return now; } };
  } });
  windows.push(h.window);
  return { ...h, advance: (ms: number) => { now += ms; } };
}
const base = {
  sessionUpdate: "workflow_updated", run_id: "r1", name: "deep-research", status: "active",
  current_phase: "Research", elapsed_ms: 728_000, agents_used: 4, agent_budget: 128,
  phases: [{ title: "Plan", state: "done" }, { title: "Research", state: "active" }, { title: "Verify", state: "pending" }, { title: "Report", state: "pending" }],
  agents: [{ agent_id: "a", label: "Researcher A", phase: "Research", state: "running", tokens_used: 0 }],
};
function send(h: Harness, over: Record<string, unknown> = {}) {
  dispatch(h.window, { type: "runProgress", update: parseRunProgressUpdate({ ...base, ...over }) });
}
const card = (h: Harness) => h.doc.querySelector(".workflow-card")!;
const pin = (h: Harness) => h.doc.querySelector(".workflow-pin")!;
const summary = (h: Harness) => pin(h).querySelector(".run-progress-row")!.textContent;
const receipt = (h: Harness) => pin(h).querySelector(".workflow-receipt")!.textContent;
const agent = (h: Harness) => pin(h).querySelector(".workflow-agent")!;
const activity = (h: Harness) => agent(h).querySelector(".workflow-agent-activity")!.textContent;
const expand = (h: Harness) => click(h.window, pin(h).querySelector(".workflow-pin-toggle")!);
const hidden = (el: Element | null) => !!el?.hasAttribute("hidden");

describe("approved workflow states", () => {
  it.each([{}, { vscode: true }, { remote: true }])("starts collapsed with reported dots on surface %j", (options) => {
    const h = boot(options);
    expect(h.doc.querySelector(".workflow-pin")).toBeNull();
    send(h);
    // Inside the composer, ahead of everything in it. The scroll-to-bottom pill
    // and the previous-prompt circle are absolutely positioned against the
    // composer's padding box, so a pin that is merely a SIBLING of the composer
    // sits underneath both of them.
    expect(pin(h).parentElement).toBe(h.doc.querySelector(".composer"));
    expect(pin(h).previousElementSibling).toBeNull();
    // The controls are the card's last row, not passengers in the heading:
    // sharing that row clipped "Stop" off the right edge of a phone.
    expect(pin(h).querySelector(".workflow-heading .run-progress-actions")).toBeNull();
    expect(pin(h).querySelector(".workflow-pin-run > :last-child")!.className).toBe("run-progress-actions");
    expect(pin(h).querySelector(".workflow-pin-toggle")!.getAttribute("aria-expanded")).toBe("false");
    expect(summary(h)).toContain("deep-research");
    expect(summary(h)).toContain("Research");
    expect(pin(h).querySelector(".run-progress-elapsed")!.textContent).toBe("12:08");
    expect(receipt(h)).toBe("updated 0s ago");
    const dots = [...pin(h).querySelectorAll(".workflow-dot")];
    expect(dots).toHaveLength(4);
    expect(dots.map((d) => d.getAttribute("data-state"))).toEqual(["done", "active", "pending", "pending"]);
    expect(dots[1].getAttribute("aria-current")).toBe("step");
    expect(dots.filter((d) => d.hasAttribute("aria-current"))).toHaveLength(1);
    expect(hidden(pin(h).querySelector(".workflow-expanded"))).toBe(true);
    expect(pin(h).querySelector(".workflow-motion, .blink-dots")).toBeNull();
    expect(card(h).textContent).toBe("deep-research \u00b7 running");
    expect(card(h).querySelector("button, summary, details, [role=button], [aria-expanded]")).toBeNull();
  });
  it.each([{}, { vscode: true }, { remote: true }])("shows the header stage only while collapsed on surface %j", (options) => {
    const h = boot(options);
    const style = h.doc.createElement("style");
    style.textContent = readFileSync(new URL("../media/chat.css", import.meta.url), "utf8");
    h.doc.head.append(style);
    send(h);
    const phase = () => pin(h).querySelector(".workflow-heading .run-progress-phase")!;
    const phaseStyle = () => h.window.getComputedStyle(phase() as any);
    expect(phase().textContent).toBe("· Research");
    expect(phaseStyle().position).not.toBe("absolute");
    expect(phaseStyle().clipPath).not.toBe("inset(50%)");
    expand(h);
    expect(phaseStyle().position).toBe("absolute");
    expect(phaseStyle().clipPath).toBe("inset(50%)");
    expect(phaseStyle().width).toBe("1px");
    expect(phaseStyle().height).toBe("1px");
    // Visually hidden, still available to assistive technology.
    expect(phase().textContent).toBe("· Research");
    expect(phase().hasAttribute("aria-hidden")).toBe(false);
    expect(phaseStyle().display).not.toBe("none");
    expect(hidden(pin(h).querySelector(".workflow-phases"))).toBe(false);
    send(h, { current_phase: "Verify", elapsed_ms: 106_000 });
    expect(phase().textContent).toBe("· Verify");
    expect(phaseStyle().clipPath).toBe("inset(50%)");
    expect(pin(h).querySelector(".run-progress-elapsed")!.textContent).toBe("1:46");
    expand(h);
    expect(phase().textContent).toBe("· Verify");
    expect(phaseStyle().position).not.toBe("absolute");
    expect(phaseStyle().clipPath).not.toBe("inset(50%)");
  });
  it("shows one line per agent and toggles each detail independently", () => {
    const h = boot();
    const agents = [base.agents[0], { ...base.agents[0], agent_id: "b", label: "Verifier", phase: "Verify", state: "pending", tokens_used: 19638 }];
    send(h, { agents }); expand(h);
    expect(hidden(pin(h).querySelector(".workflow-expanded"))).toBe(false);
    expect(hidden(pin(h).querySelector(".workflow-dots"))).toBe(true);
    expect([...pin(h).querySelectorAll(".workflow-phase")].map((p) => p.textContent)).toEqual(base.phases.map((p) => p.title));
    const rows = [...pin(h).querySelectorAll(".workflow-agent")];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector("button")!.textContent).toContain("Research \u00b7 running \u00b7 0 tokens");
    expect(rows[1].querySelector("button")!.textContent).toContain("19.64K tokens");
    expect(hidden(rows[0].querySelector(".workflow-agent-detail"))).toBe(true);
    click(h.window, rows[0].querySelector("button")!);
    expect(hidden(rows[0].querySelector(".workflow-agent-detail"))).toBe(false);
    expect(hidden(rows[1].querySelector(".workflow-agent-detail"))).toBe(true);
    expect(activity(h)).toBe("no token activity observed");
    const button = rows[0].querySelector<HTMLButtonElement>("button")!;
    button.focus(); send(h, { agents: [...agents].reverse() });
    expect(h.doc.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    click(h.window, button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });
  it("offers a fixed report only after completion", () => {
    const h = boot(); send(h);
    expect(card(h).querySelector("summary")).toBeNull();
    send(h, { status: "completed", result_summary: "Three sources agreed." });
    expect(h.doc.querySelector(".workflow-pin")).toBeNull();
    const report = card(h).querySelector<HTMLDetailsElement>("details")!;
    expect(report.open).toBe(false);
    click(h.window, report.querySelector("summary")!);
    expect(report.open).toBe(true);
    expect(report.textContent).toContain("Three sources agreed.");
    expect(report.textContent).toContain("12:08");
    expect(report.querySelector(".run-progress-btn")).toBeNull();
  });
  it("keeps expansion per run in memory and defaults new runs to collapsed", () => {
    const h = boot(); send(h); expand(h);
    send(h);
    expect(pin(h).querySelector(".workflow-pin-toggle")!.getAttribute("aria-expanded")).toBe("true");
    send(h, { run_id: "r2", name: "second" });
    const toggles = pin(h).querySelectorAll(".workflow-pin-toggle");
    expect([...toggles].map((t) => t.getAttribute("aria-expanded"))).toEqual(["true", "false"]);
    send(h, { status: "completed" });
    send(h, { run_id: "r2", name: "second", status: "completed" });
    send(h, { run_id: "r3", name: "third" });
    expect(pin(h).querySelector(".workflow-pin-toggle")!.getAttribute("aria-expanded")).toBe("false");
    expect(h.posted.filter((m) => /config|setting|preference/i.test(m.type))).toEqual([]);
    dispatch(h.window, { type: "clearMessages" });
    expect(h.doc.querySelector(".workflow-pin")).toBeNull();
    send(h);
    expect(pin(h).querySelector(".workflow-pin-toggle")!.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("workflow evidence", () => {
  it("does not deny token activity when the first snapshot already has a positive total", () => {
    const h = boot();
    send(h, { agents: [{ ...base.agents[0], tokens_used: 23552 }] }); expand(h);
    click(h.window, agent(h).querySelector("button")!);
    expect(agent(h).querySelector(".workflow-agent-state")!.textContent).toContain("23.55K tokens");
    expect(activity(h)).toBe("");
  });
  it("renders a done agent state without the reported prefix", () => {
    const h = boot();
    send(h, { agents: [{ ...base.agents[0], phase: "Plan", state: "done" }] });
    expect(agent(h).querySelector(".workflow-agent-state")!.textContent).toBe("Plan · done · 0 tokens");
  });
  it.each([
    [1000, "1K"], [23552, "23.55K"], [99999, "100K"], [100000, "100K"],
    [288307, "288K"], [999500, "1M"], [1200000, "1.2M"],
  ])("formats %i agent tokens like the context window (%s)", (tokens, formatted) => {
    const h = boot();
    send(h, { agents: [{ ...base.agents[0], tokens_used: tokens }] });
    expect(agent(h).querySelector(".workflow-agent-state")!.textContent).toBe(`Research · running · ${formatted} tokens`);
  });
  it("ages token events independently of receipts and duplicate revisions", () => {
    const h = boot(); send(h, { revision: 1 });
    const moved = { revision: 2, agents: [{ ...base.agents[0], tokens_used: 12 }] };
    h.advance(1000); send(h, moved);
    expect(activity(h)).toBe("tokens moved 0s ago");
    h.advance(12000); send(h, moved);
    expect(activity(h)).toBe("tokens moved 12s ago");
    expect(receipt(h)).toBe("updated 0s ago");
    expect(summary(h)).not.toContain("tokens moved");
    expect(summary(h)).toContain("12:08");
  });
  it("ticks only receipt age while elapsed and zero-token evidence stay unchanged", async () => {
    const h = boot(); send(h); h.advance(20000);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(receipt(h)).toBe("updated 20s ago");
    expect(summary(h)).toContain("12:08");
    expect(activity(h)).toBe("no token activity observed");
  });
  it("does not mistake phase changes, token resets or older revisions for work", () => {
    const h = boot(); send(h, { revision: 3 });
    send(h, { revision: 2, current_phase: "Plan", agents: [{ ...base.agents[0], state: "failed" }] });
    expect(summary(h)).toContain("Research");
    expect(activity(h)).toBe("no token activity observed");
    send(h, { current_phase: "Verify", agents: [{ ...base.agents[0], phase: "Verify" }] });
    send(h, { agents: [{ ...base.agents[0], tokens_used: -1 }] });
    expect(activity(h)).toBe("no token activity observed");
  });
  it("does not assign evidence across ambiguous labels or changed identities", () => {
    const h = boot();
    const anonymous = { label: "Researcher", state: "running", tokens_used: 0 };
    send(h, { agents: [anonymous, anonymous] });
    send(h, { agents: [{ ...anonymous, tokens_used: 15 }, anonymous] });
    expect(activity(h)).toBe("");
    send(h, { agents: [{ agent_id: "new", ...anonymous, tokens_used: 20 }] });
    expect(activity(h)).toBe("");
  });
  it.each(["failed", "permission_blocked", "waiting_for_permission", "awaiting_approval"])("keeps %s on its agent row", (state) => {
    const h = boot(); send(h, { agents: [{ ...base.agents[0], state }] });
    expect(agent(h).getAttribute("data-state")).toBe(state);
    expect(agent(h).textContent).toContain(state.replaceAll("_", " "));
    expect(pin(h).querySelector(".workflow-pin-toggle")!.getAttribute("aria-expanded")).toBe("false");
  });
  // A phone joining a conversation replays the transcript, so a run that is
  // very much alive arrives with no locally observed frame. This asserted the
  // pin was ABSENT there, which is what the owner hit on a cloud machine: a
  // bare "deep-research - running" line and nothing above the composer, for as
  // long as it took the next frame to arrive -- about a dozen frames span a
  // whole deep-research run. Freshness is the receipt's job; it is not a
  // reason to withhold the run.
  it("pins a replayed live run without claiming a receipt or observed activity", () => {
    const h = boot(); dispatch(h.window, { type: "historyReplay", active: true });
    send(h); send(h, { agents: [{ ...base.agents[0], tokens_used: 30 }] });
    dispatch(h.window, { type: "historyReplay", active: false });
    expect(h.doc.querySelector(".workflow-pin")).not.toBeNull();
    // No age, because none is known -- and not a finished run's wording either.
    expect(receipt(h)).toBe("no update since this view opened");
    expect(activity(h)).toBe("");
    // The handle is what a control needs; the host owns the run either way.
    const buttons = [...pin(h).querySelectorAll<HTMLButtonElement>(".run-progress-btn")];
    expect(buttons.map(b => b.textContent)).toEqual(["Pause", "Stop"]);
    expect(buttons.every(b => b.disabled)).toBe(false);
    expect(card(h).textContent).toBe("deep-research · running");
    expect(card(h).querySelector("summary")).toBeNull();
    // Beside tool rows that all carry one, a bare string read as half-drawn.
    expect(card(h).querySelector(".workflow-marker svg.tool-icon")).not.toBeNull();
  });
});

describe("reported capabilities", () => {
  it("uses reported order, ids and current phase through renames", () => {
    const h = boot(); send(h);
    const phases = [{ title: "Intake", state: "done" }, ...base.phases];
    send(h, { phases });
    expect(pin(h).querySelectorAll(".workflow-dot")).toHaveLength(5);
    expect(pin(h).querySelectorAll(".workflow-dot")[2].getAttribute("aria-current")).toBe("step");
    send(h, { current_phase_id: "p2", phases: [{ id: "p2", title: "Renamed", state: "active" }] });
    expect(summary(h)).toContain("Renamed");
    expect(pin(h).querySelector('.workflow-dot[aria-current="step"]')!.getAttribute("data-phase-id")).toBe("p2");
    send(h, { current_phase: "p2", phases: [{ id: "p2", title: "Research" }] });
    expect(summary(h)).toContain("Research");
    expect(pin(h).querySelector('.workflow-dot[aria-current="step"]')).not.toBeNull();
  });
  it("does not guess a current step for ambiguous names or unmatched ids", () => {
    const h = boot();
    send(h, { phases: [{ title: "Research" }, { title: "Research" }] });
    expect(pin(h).querySelector('[aria-current="step"]')).toBeNull();
    send(h, { current_phase_id: "unknown" });
    expect(pin(h).querySelector('[aria-current="step"]')).toBeNull();
    send(h, { current_phase_id: "p2", phases: [{ id: "p2", title: "Research" }, { id: "p2", title: "Research" }] });
    expect(pin(h).querySelector('[aria-current="step"]')).toBeNull();
  });
  it("gates missing fields and never uses an id as a name or handle", () => {
    const h = boot();
    dispatch(h.window, { type: "runProgress", update: { kind: "workflow", id: "opaque", title: "opaque", phase: "running", done: false, progress: 0.3 } });
    expect(pin(h).querySelectorAll(".workflow-dot, .workflow-agent")).toHaveLength(0);
    for (const selector of [".workflow-phases", ".workflow-roster", ".run-progress-elapsed", ".workflow-spend"]) expect(hidden(pin(h).querySelector(selector))).toBe(true);
    expect(card(h).textContent).toBe("Workflow \u00b7 running");
    expect(pin(h).textContent).not.toMatch(/opaque|%/);
    send(h, { phases: undefined, current_phase: undefined, elapsed_ms: undefined, agents: undefined, agents_used: undefined, agent_budget: undefined });
    expect(pin(h).querySelector('[data-run-id="r1"] .run-progress-phase')!.textContent).toBe("");
  });
  it("formats agent and deliverable budgets with separators", () => {
    const h = boot(); send(h, { agents_used: 1234, agent_budget: 20000, agents: [{ ...base.agents[0], tokens_used: 19638 }] }); expand(h);
    expect(pin(h).textContent).toContain("1,234 of 20,000 agents used");
    expect(agent(h).textContent).toContain("19.64K tokens");
    dispatch(h.window, { type: "runProgress", update: parseRunProgressUpdate({ sessionUpdate: "goal_updated", completed_deliverables: 1234, total_deliverables: 20000 }) });
    expect(h.doc.querySelector('.run-progress-card:not(.workflow-card):not(.workflow-pin-run)')!.textContent).toContain("1,234/20,000 deliverables");
  });
  it("formats an older host's structured budget in its detail text", () => {
    const h = boot();
    dispatch(h.window, { type: "runProgress", update: { kind: "workflow", id: "old", title: "Existing workflow", phase: "running", done: false, agentsUsed: 1234, agentBudget: 20000, detail: "1234 of 20000 agents used" } });
    expand(h);
    expect(pin(h).querySelector(".run-progress-detail")!.textContent).toBe("1,234 of 20,000 agents used");
    expect(hidden(pin(h).querySelector(".workflow-spend"))).toBe(true);
  });
  it("keeps long phase names complete and ordered in the expanded strip", () => {
    const h = boot();
    const phases = Array.from({ length: 12 }, (_, i) => ({ title: `Extended research phase ${i} with a long title`, state: i === 7 ? "active" : "pending" }));
    send(h, { phases, current_phase: phases[7].title }); expand(h);
    expect([...pin(h).querySelectorAll(".workflow-phase")].map((p) => p.textContent)).toEqual(phases.map((p) => p.title));
    expect(pin(h).querySelectorAll(".workflow-phase")[7].getAttribute("aria-current")).toBe("step");
  });
  it("hides affordances when the latest snapshot omits their fields", () => {
    const h = boot(); send(h); expand(h);
    send(h, { phases: undefined, agents: undefined, current_phase: undefined, elapsed_ms: undefined, agents_used: undefined, agent_budget: undefined });
    expect(pin(h).querySelectorAll(".workflow-dot, .workflow-agent")).toHaveLength(0);
    expect(hidden(pin(h).querySelector(".workflow-spend"))).toBe(true);
    expect(hidden(pin(h).querySelector(".run-progress-elapsed"))).toBe(true);
  });
  it("puts a run with a blocked agent first without opening it", () => {
    const h = boot(); send(h);
    send(h, { run_id: "blocked", name: "verify", agents: [{ ...base.agents[0], state: "permission_blocked" }] });
    expect(pin(h).querySelector(".workflow-pin-run")!.getAttribute("data-run-id")).toBe("blocked");
    expect(pin(h).querySelector(".workflow-pin-toggle")!.getAttribute("aria-expanded")).toBe("false");
  });

  // Ordering alone is invisible with one run, which is the ordinary case — so
  // the collapsed card has to SAY it. A blocked agent keeps arriving inside
  // frames, so the receipt beside this line reads "updated 0s ago" either way.
  it("names blocked and failed agents while collapsed, and stays quiet when healthy", () => {
    const h = boot(); send(h);
    const blockedLine = () => pin(h).querySelector(".workflow-blocked")!;
    expect(hidden(blockedLine())).toBe(true);

    send(h, { agents: [
      { ...base.agents[0], state: "permission_blocked" },
      { agent_id: "b", label: "Researcher B", phase: "Research", state: "failed", tokens_used: 10 },
      { agent_id: "c", label: "Researcher C", phase: "Research", state: "running", tokens_used: 5 },
    ] });
    expect(hidden(pin(h).querySelector(".workflow-expanded"))).toBe(true);
    expect(hidden(blockedLine())).toBe(false);
    expect(blockedLine().textContent).toBe("1 agent permission blocked · 1 agent failed");
    expect(receipt(h)).toBe("updated 0s ago");

    send(h, { agents: [{ ...base.agents[0], state: "running" }] });
    expect(hidden(blockedLine())).toBe(true);
  });
});

describe("reachable controls and tool fallback", () => {
  it("keeps Pause and Stop in both states and Resume follows the reported state", () => {
    const h = boot(); send(h);
    const controls = () => [...pin(h).querySelectorAll<HTMLButtonElement>(".run-progress-btn")];
    for (let i = 0; i < 2; i++) {
      expect(controls().map((b) => b.textContent)).toEqual(["Pause", "Stop"]);
      controls().forEach((b) => b.click()); expand(h);
    }
    expect(h.posted.filter((m) => m.type === "workflowControl")).toEqual([
      { type: "workflowControl", action: "pause", displayName: "deep-research" }, { type: "workflowControl", action: "stop", displayName: "deep-research" },
      { type: "workflowControl", action: "pause", displayName: "deep-research" }, { type: "workflowControl", action: "stop", displayName: "deep-research" },
    ]);
    send(h, { status: "user_paused" });
    expect(controls()[0].textContent).toBe("Resume");
    expect(summary(h)).toContain("user paused");
    h.advance(60000); send(h, { status: "user_paused" });
    expect(summary(h)).toContain("12:08");
    send(h, { elapsed_ms: 729000 });
    expect(summary(h)).toContain("12:09");
  });
  it.each([undefined, "bad handle", " deep-research "])("disables controls for handle %s", (name) => {
    const h = boot(); send(h, { name });
    const buttons = [...pin(h).querySelectorAll<HTMLButtonElement>(".run-progress-btn")];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((b) => b.disabled)).toBe(true);
    expect(pin(h).textContent).toContain("Controls unavailable:");
    buttons.forEach((b) => b.click());
    expect(h.posted.filter((m) => m.type === "workflowControl")).toEqual([]);
  });
  it("preserves focused controls across duplicate frames", () => {
    const h = boot(); send(h);
    const button = pin(h).querySelector<HTMLButtonElement>(".run-progress-btn")!;
    button.focus(); send(h);
    expect(pin(h).querySelector(".run-progress-btn")).toBe(button);
    expect(h.doc.activeElement).toBe(button);
  });
  it.each([true, false])("deduplicates matching workflow tool rows in either arrival order: frame first %s", (frameFirst) => {
    const h = boot();
    if (frameFirst) send(h);
    dispatch(h.window, { type: "toolCall", call: { toolCallId: "w", title: "Workflow: deep-research", kind: "other", status: "in_progress" } });
    const tool = h.doc.querySelector(".workflow-tool-marker")!;
    expect(hidden(tool)).toBe(frameFirst);
    if (!frameFirst) send(h);
    expect(hidden(tool)).toBe(true);
    dispatch(h.window, { type: "toolCall", call: { toolCallId: "x", title: "Workflow: unrelated", kind: "other" } });
    expect([...h.doc.querySelectorAll(".workflow-tool-marker")].filter((t) => !hidden(t))).toHaveLength(1);
    dispatch(h.window, { type: "toolCallUpdate", call: { toolCallId: "w", status: "failed" } });
    expect(hidden(tool)).toBe(false);
  });
  it("keeps the pin in flow and bounded, with static dots and one-line agent summaries", () => {
    const css = readFileSync(new URL("../media/chat.css", import.meta.url), "utf8");
    expect(css.match(/\.workflow-pin \{([^}]+)\}/)![1]).not.toMatch(/position:\s*(fixed|absolute)/);
    expect(css).toMatch(/\.workflow-pin-runs\s*\{[^}]*overflow: auto/);
    expect(css).toMatch(/\.workflow-phases\s*\{[^}]*flex-wrap: wrap/);
    expect(css).toMatch(/\.workflow-agent-toggle\s*\{[^}]*white-space: nowrap/);
    expect(css.match(/\.workflow-dot[^}]+}/g)!.join("")).not.toMatch(/animation|transition/);
  });
});
