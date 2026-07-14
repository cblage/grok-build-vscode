// Pure helpers for global mode defaults and per-session mode restoration. Kept
// out of sidebar.ts so the precedence policy is unit-testable without
// vscode/spawn.

export type ModeId = "agent" | "plan" | "yolo";

/**
 * The mode value to persist for a user's mode switch, or `null` to leave the
 * remembered preference unchanged. Plan is a transient per-task choice, so it is
 * never remembered (#25). Mirrors how `defaultModel`/`defaultEffort` persist.
 */
export function modeToRemember(modeId: ModeId): "agent" | "yolo" | null {
  return modeId === "plan" ? null : modeId;
}

/**
 * Whether a brand-new session should start in Auto accept (YOLO), given the
 * remembered `grok.defaultMode` and whether this start is a resume. Resumed
 * sessions are resolved from their own sidecar metadata, so they never
 * pre-apply the global new-session preference.
 */
export function startsInYolo(defaultMode: string | undefined, isResume: boolean): boolean {
  return !isResume && defaultMode === "yolo";
}

export interface RestoredModeOptions {
  /** Value read from the extension-owned per-session metadata sidecar. */
  savedMode?: unknown;
  /** Compatibility fallback for sessions saved before `mode` was persisted. */
  legacyPlanActive: boolean;
  /** The CLI globally auto-approves, independently of the ACP mode. */
  configAutoApprove: boolean;
  /** Current policy forbids the extension's host-owned Auto accept mode. */
  yoloDisabled: boolean;
}

export function isModeId(value: unknown): value is ModeId {
  return value === "agent" || value === "plan" || value === "yolo";
}

/**
 * Resolve the mode shown and enforced when reopening a persisted session.
 *
 * An explicit per-session choice is authoritative. Older sessions fall back to
 * the verdict-derived Plan/Agent behavior. A saved (or legacy) Plan remains
 * Plan even when the CLI globally auto-approves: the host-side plan gate is the
 * stronger safety boundary. Outside Plan, a global always-approve setting must
 * be displayed honestly as Auto accept. A newly-disabled saved Auto accept is
 * downgraded for this run without deleting the user's stored choice.
 */
export function resolveRestoredMode(options: RestoredModeOptions): ModeId {
  const stored = isModeId(options.savedMode)
    ? options.savedMode
    : options.legacyPlanActive
      ? "plan"
      : "agent";
  if (stored === "plan") return "plan";
  if (options.configAutoApprove) return "yolo";
  if (stored === "yolo" && options.yoloDisabled) return "agent";
  return stored;
}
