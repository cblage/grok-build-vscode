# Workflow completion review, 2026-09-23

The CLI state file wraps the run in `state`; `version` and `script_revision`
belong to the outer object. The five captures in
[`test/fixtures/workflow-state`](../test/fixtures/workflow-state/README.md)
preserve that structure. `readWorkflowCompletion` selects the wrapped state
before applying the existing terminal vocabulary. Flat input remains accepted;
an invalid wrapped state never falls back to a root status. Read failures
remain nonterminal observations.

## What the evidence establishes about card placement

The explanation in commit `089070d` cannot explain production repairs from
these files: the old reader never reached the append it replaced. That commit
prevents an append once the reader works, but its historical attribution was
not established.

There are two independently verified paths relevant to the report:

1. `syncWorkflowPin` in `media/chat.js` collects every workflow whose last
   observation has `done:false` and puts the stack inside the composer. Those
   cards can remain there after the underlying runs finish when the terminal
   notification is missed and the disk reader cannot repair it. They are
   pinned copies, not transcript entries moved by `refreshWorkflowCompletions`.
   The captured-file lifecycle tests exercise their removal and preservation
   of transcript order after the reader fix.
2. Cold replay had a separate routing gap at `0ad9b0a`. A local `session/load`
   probe using a copy of an actual completed session produced this sequence
   (zero-based received-frame positions):

   | Position | Method | Update |
   | --- | --- | --- |
   | 40, 41, 49, 58, 63 | `_x.ai/session/update` | `workflow_updated`, active, revisions 1, 2, 7, 16, 23 |
   | 66 | `_x.ai/session/update` | `workflow_updated`, complete, revision 28 |
   | 67 | `session/update` | later user message |
   | 69, 74 | `session/update` | later assistant messages |

   `AcpClient` sends `_x.ai/session/update` to `subagentLifecycle`.
   That sidebar forwarded it as `subagentUpdate`, and that renderer handles
   `turn_completed`, `subagent_spawned` and `subagent_finished`, not workflows.
   Only the separate `xaiNotification` listener called `parseRunProgressUpdate`.
   Thus the replayed workflow frames did not establish transcript cards at
   their historical positions. The disk poll only repairs existing
   `runProgress` entries; it does not discover those discarded frames.

The probe loaded successfully with an isolated CLI home, copied conversation
and workflow files, and a deliberately invalid non-secret fixture API key.
No prompt was sent and no credential file was read, copied, parsed or moved.
It emitted no workflow notifications after the replay, including a one-second
wait after load. It therefore does **not** prove that a later CLI snapshot
appended the owner's four cards. The renderer would append a new ordinary
`runProgress` for an absent run, but that condition alone is not evidence that
the owner's session took that path.

The owner's exact four-card session/trace was not among the supplied files.
Its historical cause remains unproven. Stale composer pins and the cold-replay
routing gap must not be reported as a confirmed explanation of that specific
incident without its trace or DOM evidence. The subsequent routing correction
reuses `parseRunProgressUpdate` on the persisted rail, returning after emitting
`runProgress`. `test/workflow-replay.dom.test.ts` fails its middle-of-conversation
order assertions at `0ad9b0a` and passes with that correction; it also checks
duplicate/live delivery and reload without moving or duplicating the card.
