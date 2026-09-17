// A command allowed for the session (#61) still reaches the transcript as a
// card, so the user can see what ran — but it arrives already answered, in one
// `historyBatch`, carrying no options. This drives the REAL shipped chat.js and
// pins the two things that makes it: it must not announce a wait nobody is
// waiting on, and it must not become a button.
//
// The read-aloud half is the one that matters. `permissionRequest` used to
// announce "Grok is waiting for your permission" on arrival, unconditionally —
// which would have fired on every auto-approved command, i.e. on exactly the
// commands the grant exists to keep quiet, and would have said something false
// each time. The condition is now the card being answerable at all, which is
// also correct for any other optionless card.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch } from "./webview-harness";

const WAIT_PHRASE = "waiting for your permission";

function bootWithSpeech() {
  const spoken: string[] = [];
  class Utterance {
    constructor(public text: string) {}
  }
  const booted = bootWebview({
    beforeScripts: (w: any) => {
      w.SpeechSynthesisUtterance = Utterance;
      w.speechSynthesis = { cancel() {}, speak(value: Utterance) { spoken.push(value.text); } };
    },
  });
  dispatch(booted.window, {
    type: "initialState", useCtrlEnter: false, effort: "", cwd: "/x",
    extVersion: "4.9.0", readRepliesAloud: false,
  });
  dispatch(booted.window, { type: "readRepliesAloud", value: true });
  return { ...booted, spoken };
}

/** What the host emits for a command the session already allows. */
function autoApproved(window: any, id: number, title: string) {
  dispatch(window, {
    type: "historyBatch",
    messages: [
      { type: "permissionRequest", req: { id, toolCall: { toolCallId: `tc${id}`, kind: "execute", title }, options: [] } },
      { type: "permissionResolved", requestId: id, optionId: "once" },
    ],
  });
}

/** What the host emits for a command that still needs an answer. */
function asks(window: any, id: number, title: string) {
  dispatch(window, {
    type: "permissionRequest",
    req: {
      id,
      toolCall: { toolCallId: `tc${id}`, kind: "execute", title },
      options: [
        { optionId: "once", name: "Yes, proceed", kind: "allow_once" },
        { optionId: "reject", name: "No", kind: "reject_once" },
      ],
    },
  });
}

describe("a command allowed for the session arrives answered, not asked", () => {
  it("says nothing aloud, while a card that does need an answer still speaks", () => {
    const { window, spoken } = bootWithSpeech();

    autoApproved(window, 1, "npm test — auto-approved for this session");
    expect(spoken.join(" ")).not.toContain(WAIT_PHRASE);

    // The same session, a command that was never granted: unchanged behaviour.
    asks(window, 2, "rm -rf build");
    expect(spoken.filter((t) => t.includes(WAIT_PHRASE))).toHaveLength(1);
  });

  it("is not a button, and does not take the keyboard", () => {
    const { window, doc } = bootWithSpeech();
    autoApproved(window, 3, "npm run build — auto-approved for this session");

    const card = doc.querySelector(".card.permission")!;
    expect(card).not.toBeNull();
    expect(card.querySelectorAll(".card-actions button")).toHaveLength(0);
    expect(doc.activeElement?.tagName).not.toBe("BUTTON");
  });

  it("leaves a visible line naming what ran", () => {
    // The whole safety argument for a session-wide grant is that it stays
    // auditable: "it stopped asking" must not become "I could not see what it
    // did". If this assertion ever goes, the feature stops being safe to have.
    const { window, doc } = bootWithSpeech();
    autoApproved(window, 4, "npm ci — auto-approved for this session");

    const line = doc.querySelector(".perm-resolved-line")!;
    expect(line).not.toBeNull();
    expect(line.textContent).toContain("npm ci");
    expect(line.textContent).toContain("auto-approved for this session");
    expect(line.className).toContain("perm-allowed");
    // And it says ALLOWED, not the neutral "Answered". A host-answered card
    // carries no options, so the renderer cannot look the kind up — and a
    // green line whose verb declines to say what happened is the one thing a
    // grant this wide cannot afford. The word and the colour come off one
    // test now, so they cannot drift apart again.
    expect(doc.querySelector(".perm-resolved-verb")!.textContent).toBe("Allowed");
  });

  it("says Rejected, in reject colours, for an unknown reject kind", () => {
    // The same split used to mislabel a reject_always as allowed: the class
    // ternary only recognised reject_once. No host of ours sends
    // reject_always any more (#154) — an older one still can.
    const { window, doc } = bootWithSpeech();
    dispatch(window, { type: "historyBatch", messages: [
      { type: "permissionRequest", req: { id: 9, toolCall: { toolCallId: "tc9", kind: "execute", title: "rm -rf /" },
        options: [{ optionId: "never", name: "No, and never ask again", kind: "reject_always" }] } },
      { type: "permissionResolved", requestId: 9, optionId: "never" },
    ] });

    const line = doc.querySelector(".perm-resolved-line")!;
    expect(line.className).toContain("perm-rejected");
    expect(doc.querySelector(".perm-resolved-verb")!.textContent).toBe("Rejected");
  });
});
