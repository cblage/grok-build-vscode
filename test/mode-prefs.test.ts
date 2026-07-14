import { describe, it, expect } from "vitest";
import { modeToRemember, resolveRestoredMode, startsInYolo } from "../src/mode-prefs";

describe("remembered mode preference (#25)", () => {
  it("remembers a switch to Agent or Auto accept, but never Plan", () => {
    expect(modeToRemember("agent")).toBe("agent");
    expect(modeToRemember("yolo")).toBe("yolo");
    // Plan is a transient per-task choice — leave the remembered preference alone.
    expect(modeToRemember("plan")).toBeNull();
  });

  it("starts a NEW session in Auto accept only when that's the remembered mode", () => {
    expect(startsInYolo("yolo", false)).toBe(true);
    expect(startsInYolo("agent", false)).toBe(false);
    expect(startsInYolo("", false)).toBe(false); // unset = Agent
    expect(startsInYolo(undefined, false)).toBe(false);
  });

  it("never pre-applies the remembered mode on a resume (those are verdict-driven)", () => {
    expect(startsInYolo("yolo", true)).toBe(false);
    expect(startsInYolo("agent", true)).toBe(false);
  });
});

describe("per-session mode restoration", () => {
  const resolve = (overrides: Partial<Parameters<typeof resolveRestoredMode>[0]> = {}) =>
    resolveRestoredMode({
      savedMode: undefined,
      legacyPlanActive: false,
      configAutoApprove: false,
      yoloDisabled: false,
      ...overrides,
    });

  it("restores every explicit session mode independently of the global new-session default", () => {
    expect(resolve({ savedMode: "agent" })).toBe("agent");
    expect(resolve({ savedMode: "plan" })).toBe("plan");
    expect(resolve({ savedMode: "yolo" })).toBe("yolo");
  });

  it("preserves verdict-driven Plan/Agent behavior for legacy metadata", () => {
    expect(resolve({ legacyPlanActive: true })).toBe("plan");
    expect(resolve({ legacyPlanActive: false })).toBe("agent");
    expect(resolve({ savedMode: "corrupt", legacyPlanActive: true })).toBe("plan");
  });

  it("reflects globally forced auto-approve unless a Plan gate is active", () => {
    expect(resolve({ savedMode: "agent", configAutoApprove: true })).toBe("yolo");
    expect(resolve({ savedMode: "yolo", configAutoApprove: true })).toBe("yolo");
    expect(resolve({ savedMode: "plan", configAutoApprove: true })).toBe("plan");
  });

  it("does not apply a saved Auto accept mode when current policy disables it", () => {
    expect(resolve({ savedMode: "yolo", yoloDisabled: true })).toBe("agent");
    // The CLI's own global always-approve remains honest even if both settings
    // are present; the extension cannot disable that server-side behavior.
    expect(resolve({ savedMode: "yolo", yoloDisabled: true, configAutoApprove: true })).toBe("yolo");
  });
});
