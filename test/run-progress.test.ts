import { describe, it, expect } from "vitest";
import {
  isRunProgressUpdate,
  parseRunProgressUpdate,
  workflowControlCommand,
  runProgressKindLabel,
  formatRunProgressPct,
} from "../src/run-progress";

describe("isRunProgressUpdate", () => {
  it("accepts workflow_updated / goal_updated and lifecycle siblings", () => {
    expect(isRunProgressUpdate({ sessionUpdate: "workflow_updated" })).toBe(true);
    expect(isRunProgressUpdate({ sessionUpdate: "goal_updated" })).toBe(true);
    expect(isRunProgressUpdate({ sessionUpdate: "workflow_paused" })).toBe(true);
    expect(isRunProgressUpdate({ sessionUpdate: "goal_completed" })).toBe(true);
  });

  it("rejects unrelated rail kinds", () => {
    expect(isRunProgressUpdate({ sessionUpdate: "auto_compact_completed" })).toBe(false);
    expect(isRunProgressUpdate({ sessionUpdate: "subagent_spawned" })).toBe(false);
    expect(isRunProgressUpdate(null)).toBe(false);
    expect(isRunProgressUpdate({})).toBe(false);
  });
});

describe("parseRunProgressUpdate — workflow", () => {
  it("parses a running workflow_updated", () => {
    const u = parseRunProgressUpdate({
      sessionUpdate: "workflow_updated",
      run_id: "run-abc",
      display_name: "deep-research-2",
      objective: "Compare Postgres 17 vs MySQL 9",
      current_phase: "running",
      last_event: "agent_started",
      last_event_detail: "researcher",
      agents_used: 4,
      agent_budget: 128,
    });
    expect(u).toMatchObject({
      kind: "workflow",
      id: "run-abc",
      title: "deep-research-2",
      subtitle: "Compare Postgres 17 vs MySQL 9",
      phase: "running",
      done: false,
      failed: false,
      displayName: "deep-research-2",
    });
    // `agent_started` is deliberately NOT in EVENT_LABEL — and is not even in
    // the CLI binary's string table, so this fixture has always modelled an
    // event that never arrives. Kept exactly for that: it exercises the
    // fallback, and shows an unpredicted name reaching the card as English.
    expect(u?.detail).toMatch(/Agent started: researcher/);
    expect(u?.detail).not.toMatch(/agent_started/);
    // Spend is reported as spend. `progress` is the completion slot the card
    // prints as a bare `%`, and a workflow has no completion number to put in
    // it — putting agents_used/agent_budget there is what #163 reported.
    expect(u?.progress).toBeUndefined();
    expect(u?.agentsUsed).toBe(4);
    expect(u?.agentBudget).toBe(128);
    expect(u?.detail).toMatch(/4\/128 agents/);
  });

  it("omits the agent count when the run reports no budget", () => {
    const u = parseRunProgressUpdate({
      sessionUpdate: "workflow_updated",
      run_id: "run-nobudget",
      display_name: "review-changes",
      current_phase: "running",
      last_event: "agent_started",
      agents_used: 2,
    });
    expect(u?.progress).toBeUndefined();
    expect(u?.agentBudget).toBeUndefined();
    expect(u?.detail).toBe("Agent started");
  });

  describe("status is the lifecycle, current_phase is the position within it", () => {
    // Measured live: pausing and stopping a run change `status` and leave
    // `current_phase` alone, and the discriminator stays `workflow_updated`
    // for all three states. Reading the position first is what made Pause
    // look like it had done nothing.
    const at = (over: Record<string, unknown>) =>
      parseRunProgressUpdate({
        sessionUpdate: "workflow_updated",
        run_id: "run-real",
        name: "deep-research",
        agents_used: 1,
        agent_budget: 128,
        current_phase: "Plan",
        ...over,
      });

    it("prefers the position while the run is merely active", () => {
      // "Plan" tells the reader more than "active" does, so `active` must NOT
      // count as a lifecycle word.
      expect(at({ status: "active" })?.phase).toBe("plan");
    });

    it("prefers the lifecycle once the run is paused or stopped", () => {
      expect(at({ status: "user_paused" })?.phase).toBe("user_paused");
      const stopped = at({ status: "cancelled" });
      expect(stopped?.phase).toBe("cancelled");
      expect(stopped?.cancelled).toBe(true);
      expect(stopped?.done).toBe(true);
    });

    it("does not mistake a pause for a finish", () => {
      const paused = at({ status: "user_paused" });
      expect(paused?.done).toBe(false);
      expect(paused?.failed).toBe(false);
      expect(paused?.cancelled).toBe(false);
    });

    it("catches lifecycle words we have not seen, on their stems", () => {
      // The CLI's own vocabulary nearby: budget_limited, interrupted, failed.
      // Each must outrank the position the same way a measured one does.
      for (const status of ["budget_limited", "workflow_interrupted", "failed", "agent_paused"]) {
        expect(at({ status })?.phase, status).toBe(status);
      }
    });

    it("still falls back when no status arrives at all", () => {
      expect(at({ status: undefined })?.phase).toBe("plan");
      expect(parseRunProgressUpdate({
        sessionUpdate: "workflow_updated", run_id: "r", name: "deep-research",
      })?.phase).toBe("updated");
    });
  });

  // The owner, reading a card built from real captured frames: "phase_entered?
  // Can't we translate those labels? Is this the only one?" No, it was not —
  // the phase word leaks the same way, and that half is fixed at the render
  // site (see media/chat.js and the note in src/run-progress.ts).
  describe("wire event names do not reach the card", () => {
    const detailOf = (over: Record<string, unknown>) =>
      parseRunProgressUpdate({
        sessionUpdate: "workflow_updated",
        run_id: "run-real",
        name: "deep-research",
        agents_used: 4,
        agent_budget: 128,
        ...over,
      })?.detail;

    // Every case below is a frame shape the 2026-09-17 live capture actually
    // produced, with the phase it arrived alongside.
    it("drops `phase_entered`, because the row already shows the phase", () => {
      expect(detailOf({ current_phase: "Research", last_event: "phase_entered", last_event_detail: "Research" }))
        .toBe("4/128 agents");
    });

    it("keeps a phase_entered detail that is NOT the phase on screen", () => {
      // Same event, different content: only the duplicate is noise.
      expect(detailOf({ current_phase: "Research", last_event: "phase_entered", last_event_detail: "Verify" }))
        .toBe("Verify · 4/128 agents");
    });

    it("prints a `log` message without its own name in front of it", () => {
      expect(detailOf({
        current_phase: "Plan", last_event: "log",
        last_event_detail: "research plan: 3 question(s), capped at 4",
      })).toBe("research plan: 3 question(s), capped at 4 · 4/128 agents");
    });

    it("says nothing for a lifecycle event the phase slot already carries", () => {
      // `workflow_started` beside a row reading `· active`, and
      // `workflow_cancelled` beside one reading `· cancelled`: in both the
      // event name is the row's job, so the detail is the spend alone.
      expect(detailOf({ status: "active", last_event: "workflow_started" })).toBe("4/128 agents");
      expect(detailOf({ status: "cancelled", last_event: "workflow_cancelled" })).toBe("4/128 agents");
    });

    it("keeps a lifecycle event's prose, and drops its bare reason token", () => {
      // The CLI explains a failure in a sentence — that must survive. A pause
      // reason is a single word the row has already said.
      expect(detailOf({
        status: "budget_exceeded", last_event: "workflow_failed",
        last_event_detail: "maximum agent budget reached; start a new run",
      })).toBe("maximum agent budget reached; start a new run · 4/128 agents");
      expect(detailOf({
        status: "user_paused", current_phase: "Plan",
        last_event: "workflow_paused", last_event_detail: "user",
      })).toBe("Plan · 4/128 agents");
    });

    it("sentence-cases a name nobody predicted, rather than shipping Rust", () => {
      expect(detailOf({ current_phase: "Verify", last_event: "verification_failed" }))
        .toBe("Verification failed · 4/128 agents");
    });

    it("leaves a pause message and a result summary to speak for themselves", () => {
      // These outrank last_event and are already prose from the CLI.
      expect(detailOf({ last_event: "log", pause_message: "Waiting for your review" }))
        .toBe("Waiting for your review · 4/128 agents");
      expect(detailOf({ last_event: "log", result_summary: "3 sources agreed" }))
        .toBe("3 sources agreed · 4/128 agents");
    });
  });

  it("marks completed / failed / cancelled terminal", () => {
    expect(
      parseRunProgressUpdate({
        sessionUpdate: "workflow_updated",
        run_id: "r1",
        display_name: "review-changes",
        phase: "completed",
        result_summary: "All checks green",
      }),
    ).toMatchObject({ done: true, failed: false, detail: "All checks green" });

    expect(
      parseRunProgressUpdate({
        sessionUpdate: "workflow_failed",
        run_id: "r2",
        display_name: "x",
        phase: "failed",
      }),
    ).toMatchObject({ done: true, failed: true });

    expect(
      parseRunProgressUpdate({
        sessionUpdate: "workflow_cancelled",
        run_id: "r3",
        name: "y",
        phase: "cancelled",
      }),
    ).toMatchObject({ done: true, cancelled: true });
  });

  it("returns null without an id / name", () => {
    expect(parseRunProgressUpdate({ sessionUpdate: "workflow_updated" })).toBeNull();
  });

  it("falls back to display name as id", () => {
    const u = parseRunProgressUpdate({
      sessionUpdate: "workflow_updated",
      display_name: "review-changes",
      phase: "running",
    });
    expect(u?.id).toBe("review-changes");
  });
});

describe("parseRunProgressUpdate — goal", () => {
  it("parses goal_updated with deliverable progress", () => {
    const u = parseRunProgressUpdate({
      sessionUpdate: "goal_updated",
      goal_id: "g1",
      objective: "Migrate auth module",
      phase: "Executing",
      total_deliverables: 4,
      completed_deliverables: 1,
      current_deliverable_title: "Rewrite login handler",
    });
    expect(u).toMatchObject({
      kind: "goal",
      id: "g1",
      title: "Goal",
      subtitle: "Migrate auth module",
      phase: "executing",
      done: false,
    });
    expect(u?.progress).toBeCloseTo(0.25);
    expect(u?.detail).toMatch(/1\/4 deliverables/);
    expect(u?.detail).toMatch(/Rewrite login handler/);
  });

  it("marks goal_completed / goal_cleared done", () => {
    expect(
      parseRunProgressUpdate({ sessionUpdate: "goal_completed", goal_id: "g1", phase: "completed" }),
    ).toMatchObject({ done: true });
    expect(
      parseRunProgressUpdate({ sessionUpdate: "goal_cleared", goal_id: "g1", phase: "cleared" }),
    ).toMatchObject({ done: true, cancelled: true });
  });
});

describe("workflowControlCommand", () => {
  it("builds pause/resume/stop slash commands", () => {
    expect(workflowControlCommand("pause", "review-changes")).toBe("/workflow pause review-changes");
    expect(workflowControlCommand("resume", "deep-research-2")).toBe("/workflow resume deep-research-2");
    expect(workflowControlCommand("stop", "x")).toBe("/workflow stop x");
  });

  it("rejects empty or unsafe names", () => {
    expect(workflowControlCommand("pause", "")).toBeNull();
    expect(workflowControlCommand("pause", "a b")).toBeNull();
    expect(workflowControlCommand("pause", "foo;rm -rf")).toBeNull();
  });
});

describe("labels", () => {
  it("kind labels", () => {
    expect(runProgressKindLabel("workflow")).toBe("Workflow");
    expect(runProgressKindLabel("goal")).toBe("Goal");
  });
  it("percent formatting", () => {
    expect(formatRunProgressPct(0.25)).toBe("25%");
    expect(formatRunProgressPct(undefined)).toBe("");
  });
});
