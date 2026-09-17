// Pause and Stop, from the wire to the card, on frames a real grok CLI sent.
//
// The owner: *"When I click pause or stop, I get a confirmation e.g. 'Paused
// deep-research. /workflow resume deep-research to continue.' But the workflow
// card doesn't really change."* Then, refining it: *"The timer continued, then
// stopped. But the three blinking dots didn't."*
//
// Three causes were possible and they need different fixes, so a live probe
// paused and stopped a real `/deep-research` run and recorded the rail. The
// answer was the third one, and it is a field-precedence bug:
//
//   running      status=active       current_phase=Plan  last_event=phase_entered
//   after Pause  status=user_paused  current_phase=Plan  last_event=workflow_paused
//   after Stop   status=cancelled    current_phase=Plan  last_event=workflow_cancelled
//
// `status` is the LIFECYCLE and `current_phase` is the position within it. A
// pause changes the first and leaves the second alone — and our phase chain
// read `current_phase` first, so the card kept saying "plan" and the button
// kept saying Pause. The discriminator stays `workflow_updated` throughout, so
// there is no second channel that would have caught it.
//
// These 7 frames are that recording, verbatim: test/fixtures/
// workflow-lifecycle-live.jsonl. They go through the REAL parser and the REAL
// media/chat.js, which is what makes this a wire-to-pixel test rather than a
// restatement of the parser's opinion.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRunProgressUpdate } from "../src/run-progress";
import { bootWebview, dispatch } from "./webview-harness";

const FRAMES: Record<string, unknown>[] = readFileSync(
  join(__dirname, "fixtures", "workflow-lifecycle-live.jsonl"),
  "utf8",
)
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

/** Frame indices, named by what the run was doing when each was sent. */
const RUNNING = 3;
const PAUSED = 4;
const CANCELLED = 6;

function play(upTo: number) {
  const { window, doc } = bootWebview();
  for (const frame of FRAMES.slice(0, upTo + 1)) {
    const update = parseRunProgressUpdate(frame);
    expect(update, "every captured frame must parse").not.toBeNull();
    dispatch(window, { type: "runProgress", update });
  }
  const card = doc.querySelector(".run-progress-card") as HTMLElement;
  return {
    card,
    phase: card?.querySelector(".run-progress-phase")?.textContent ?? "",
    detail: card?.querySelector(".run-progress-detail")?.textContent ?? "",
    dots: card?.querySelector(".blink-dots"),
    buttons: [...(card?.querySelectorAll(".run-progress-btn") ?? [])].map((b) => b.textContent),
    clock: (card?.querySelector(".run-progress-row") as any)?._waitTimer ?? null,
  };
}

describe("a real pause reaches the card", () => {
  it("shows the run working before the pause", () => {
    const s = play(RUNNING);
    expect(s.phase).toBe("· plan");
    expect(s.dots).not.toBeNull();
    expect(s.buttons).toEqual(["Pause", "Stop"]);
    expect(s.clock).not.toBeNull();
  });

  it("says paused, offers Resume, and stops the dots", () => {
    const s = play(PAUSED);
    // `user_paused` is the CLI's word. It reaches the row as English (the
    // underscore fix) and it must not still read "plan".
    expect(s.phase).toBe("· user paused");
    expect(s.buttons).toEqual(["Resume", "Stop"]);
    // The owner's sharpest observation: the dots kept blinking on a run that
    // was not running. Three dots pulsing next to the word "paused" says the
    // card does not believe its own label.
    expect(s.dots).toBeNull();
  });

  it("does not repeat the lifecycle in the detail line", () => {
    // The frame carries `last_event: workflow_paused` with detail `user`, and
    // the phase slot now says "user paused" — so "Paused: user" underneath it
    // would say the same thing twice, which is what shipped before this.
    // What the line carries instead is the two things the row cannot: where
    // the run will resume from, and what it has spent.
    const s = play(PAUSED);
    expect(s.detail).toBe("Plan · 1/128 agents");
    expect(s.detail).not.toMatch(/paused|workflow_/i);
  });

  it("marks a stopped run cancelled and takes its controls away", () => {
    const s = play(CANCELLED);
    expect(s.phase).toBe("· cancelled");
    expect(s.card.classList.contains("run-progress-cancelled")).toBe(true);
    expect(s.dots).toBeNull();
    expect(s.buttons).toEqual([]);
    // The clock is cleared, leaving the run's duration on screen rather than
    // counting up forever on a run that ended.
    expect(s.clock).toBeNull();
    expect(s.card.querySelector(".run-progress-elapsed")?.textContent).toMatch(/^· \d/);
  });

  it("keeps the position visible — a paused run is paused SOMEWHERE", () => {
    // Preferring status must not throw the phase away: `current_phase: Plan`
    // is still the only thing that says where the run will resume from, and
    // the frame's own `phases` array corroborates it (`Plan=active`).
    const s = play(PAUSED);
    expect(s.card.textContent).toContain("Plan");
  });
});
