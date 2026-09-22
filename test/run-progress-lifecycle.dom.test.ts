// Real CLI capture through the real parser and renderer. In particular, revision
// 4 arrives twice and tokens_used stays zero across the entire lifecycle.
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { parseRunProgressUpdate } from "../src/run-progress";
import { bootWebview, dispatch, type Harness } from "./webview-harness";

const frames = readFileSync(new URL("fixtures/workflow-lifecycle-live.jsonl", import.meta.url), "utf8")
  .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const windows: Harness["window"][] = [];
afterEach(() => { for (const window of windows.splice(0)) window.happyDOM.abort(); });
function replay() {
  let now = 100_000;
  const h = bootWebview({ beforeScripts: (window) => {
    (window as any).Date = class extends window.Date { static now() { return now; } };
  } });
  windows.push(h.window);
  return { ...h,
    advance: (ms: number) => { now += ms; },
    frame: (i: number) => dispatch(h.window, { type: "runProgress", update: parseRunProgressUpdate(frames[i]) }),
  };
}
const text = (h: Harness, selector: string) => h.doc.querySelector(selector)?.textContent ?? "";

describe("the captured workflow lifecycle", () => {
  it("preserves observed fields, including the zero-token cancelled agent", () => {
    const updates = frames.map(parseRunProgressUpdate);
    expect(updates.every(Boolean)).toBe(true);
    expect(updates[0]!.agents).toBeUndefined();
    expect(updates[0]!.currentPhase).toBeUndefined();
    expect(updates[1]!.phases).toHaveLength(4);
    expect(updates[2]!.agents![0]).toMatchObject({ label: "research-planner", phase: "Plan", state: "running", tokensUsed: 0 });
    expect(updates[2]).toEqual(updates[3]);
    expect(updates[5]!.agents![0].state).toBe("cancelled");
    expect(updates.slice(4).map((u) => u!.elapsedMs)).toEqual([182, 182, 182]);
    expect(updates.every((u) => u!.displayName === "deep-research")).toBe(true);
  });
  it("never claims motion from duplicate frames, run pause or zero tokens", () => {
    const h = replay();
    for (let i = 0; i <= 4; i++) {
      h.advance(4000); h.frame(i);
      expect(h.doc.querySelector(".workflow-motion")).toBeNull();
      expect(text(h, ".workflow-agent-activity")).not.toMatch(/tokens moved|state changed/);
      expect(h.doc.querySelector(".workflow-card .blink-dots")).toBeNull();
    }
    expect(text(h, ".workflow-pin .run-progress-phase")).toBe("· Plan · user paused");
    expect([...h.doc.querySelectorAll(".workflow-pin .run-progress-btn")].map((b) => b.textContent)).toEqual(["Resume", "Stop"]);
  });
  it("observes a cancelled state transition without portraying it as ongoing work", () => {
    const h = replay(); h.frame(4); h.frame(5);
    expect(text(h, ".workflow-agent-state")).toBe("Plan · cancelled · 0 tokens");
    expect(text(h, ".workflow-agent-activity")).toBe("state changed 0s ago \u00b7 no token activity observed");
    h.advance(12000); h.frame(5);
    expect(text(h, ".workflow-agent-activity")).toBe("state changed 12s ago \u00b7 no token activity observed");
    expect(h.doc.querySelector(".workflow-motion")).toBeNull();
    expect(text(h, ".workflow-receipt")).toBe("updated 0s ago");
  });
  it("ends the pin on stop while retaining the reported duration and roster in the transcript", () => {
    const h = replay(); frames.forEach((_, i) => h.frame(i));
    expect(h.doc.querySelector(".workflow-pin")).toBeNull();
    expect(text(h, ".workflow-card .run-progress-phase")).toBe("· Plan · cancelled");
    expect(text(h, ".workflow-card .run-progress-elapsed")).toBe("0:00");
    expect(text(h, ".workflow-agent-state")).toBe("Plan · cancelled · 0 tokens");
    expect(h.doc.querySelector(".workflow-card")!.classList.contains("run-progress-cancelled")).toBe(true);
    expect(h.doc.querySelectorAll(".workflow-card .run-progress-btn")).toHaveLength(0);
  });
  it("keeps state-change evidence without denying an unchanged positive token total", () => {
    const h = replay();
    for (const i of [4, 5, 6]) {
      const update = parseRunProgressUpdate(frames[i])!;
      dispatch(h.window, { type: "runProgress", update: {
        ...update, agents: update.agents!.map((agent) => ({ ...agent, tokensUsed: 288307 })),
      } });
    }
    expect(text(h, ".workflow-card .workflow-agent-state")).toBe("Plan · cancelled · 288K tokens");
    expect(text(h, ".workflow-card .workflow-agent-activity")).toBe("state changed 0s ago");
  });
});
