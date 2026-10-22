# Operate the attached Vids interface

## Connection, ownership and background work

Use the user's selected document. Confirm its URL/document ID, title, edit mode
and current scene. Authorization for one video does not extend to other files or
public sharing. Read current schemas and call `vids_diagnostics`/`vids_status`.
Runtime compatibility must be ready: MCP, native host and extension need matching
profile/version/build identity. A listed tool does not establish a connection.

Acquire control for the exact session and this task's owner label. Pass its
`controlToken` to observation and actions; never borrow or share another task's
token. `CONTROL_BUSY` means continue independent preparation, not force takeover.
Release control when finished. Owner actions refresh activity; use renew during
long waits and read actual lease timing from the response. Unsettled requests,
including unknown timeouts, can prevent safe release.

Operate through the Vids MCP inside the attached tab. Do not activate windows or
use system mouse, keyboard, clipboard, browser shortcuts or desktop automation.
Document-scoped `press_key` is not an OS keyboard. Do not bypass clipboard
restrictions with menus or another tool. If the connection is missing, prepare
scripts/assets/reviews and report the needed connection step.

User reload of the extension card is required after extension code changes;
reconnecting alone or the general extensions-page update button does not reload
that code. Native/MCP changes also need their appropriate restart/reconnection.
Observe compatibility again and discard old sessions/snapshots. Do this in a
suitable pause, not during unsettled work. Background operation does not imply
survival of browser closure, device sleep or tab suspension.

Updated client profiles arbitrate the same document across tabs. Separate
documents are independent. This does not block manual user edits: coordinate a
handoff when the person edits the same video. Recovery never treats a dead PID or
elapsed time as proof that Chrome stopped. A reconciliation lease allows
inspection first; evidence and explicit acknowledgement can enable new intents
while preserving the old unknown outcome. Never automatically replay it.

## Observe → act → verify

Read the actual response shape: status may be flat, while observation/action data
is under `result`. Obtain a fresh `snapshotId` and node refs before each action.
Screenshot coordinates are image pixels; convert them to CSS coordinates with
`image.scaleX`/`scaleY`, not a guessed DPR. A screenshot creates a new snapshot
without AX refs; observe again before a node-based action.

Use one meaningful operation with current `sessionId`, `controlToken`,
`snapshotId`, and a new `operation_id`. Select a visible target from the fresh AX
or screenshot. Read the receipt and observe its effect. Mutation, scrolling,
navigation or external editing invalidates old targets. A delay can let layout
settle but is not proof of state. Stale snapshots require renewed observation,
not bypassing the guard. After repeated ineffective actions, inspect selection,
focus, overlays and scale before choosing a different visible route.

On timeout preserve the original response and inspect status/current content.
Do not repeat a mutation with either the same or a new operation ID to discover
whether it ran. In-memory receipt caching has bounded retention and can disappear
on restart; it is not durable exactly-once execution. A later response does not
rewrite an original `unknown`. An error on a later screenshot does not establish
the cause of the earlier disconnection. Isolating a timed-out screenshot read never authorizes
mutation replay.

After `BROWSER_TIMEOUT` from `vids_screenshot`, inspect `vids_status`. The updated
behavior is identified by `recovery.state: screenshot_read_pending`,
`blocks: ["screenshot"]` and `timeoutMs: 10000`. The read times out after ten
seconds without detaching the tab or revoking control; there is no second detach
deadline. The old snapshot is invalid, so obtain a fresh `vids_observe` and use
its evidence for supported actions. While the original read remains pending,
another screenshot returns `BROWSER_RECOVERING` without sending another capture.
Do not poll screenshot in a loop. The late result is discarded and cannot replace
a newer snapshot. Once the read settles, `recovery` becomes `null` and another
screenshot can be requested. Normal lease expiry, navigation and real disconnects
still require their respective recovery steps.

Do not apply this behavior to an older build reporting `waiting_for_read`: it
blocks observation, screenshots and input, waits up to ten more seconds, then
detaches at its hard deadline. Poll status within that declared interval; obtain
a new observe if the same session survives, or reconnect explicitly and acquire
new control after a detach. A missing `recovery` field does not establish support
for the new implementation. Check the loaded version/build; updating source files
alone does not reload the extension.

A hidden or occluded Chrome window may not supply a frame; a timeout alone does
not establish the cause. The bridge never foregrounds the window or uses system
input. Background AX operations do not guarantee background screenshots. If the
next edit requires visual evidence, keep it pending rather than act on old pixels
or a guess.

`BROWSER_TIMEOUT` from `vids_scroll` is a separate case. In the updated build,
a pending `Input.dispatchMouseEvent` preserves attachment but status reports
`recovery.state: input_ack_pending`, `blocks: ["mutations"]` and
`requiresReconciliation: true`. AX/status remain available; all mutations,
control release and reconciliation are blocked until the original Chrome command
actually settles. The wheel may not have been sent yet and can execute later.
A timeout is not cancellation: do not apply the screenshot mode's permission for
fresh input to this pending mutation.

Even after a late ACK or rejection, the scroll outcome remains `unknown`.
Obtain a fresh `vids_observe`, establish the result and use
`vids_reconcile_control` with evidence before another mutation. The end of
`input_ack_pending` alone does not authorize a write; an ACK does not prove
scrolling. Do not retry the scroll or switch gestures to repeat the same intent.
This procedure requires the new mode in the loaded build. Other mutation timeouts
retain the existing fail-closed/reconnect handling. Never foreground Chrome or use
system input for recovery.

An AX tree may show scene count, playhead and total duration without all scene
boundaries. Do not infer exact timeline timing from thumbnail widths. Record
observed boundaries while editing; scene-change candidates from the export are
hints, not Vids' timeline model. Names below are UI landmarks, not selectors or
invented RPCs such as `add_scene`/`set_voice`.

## Common editing decisions

* Select the scene on the main scene strip, or the object on its timing track;
  these selections are different. A full-frame transparent layer may intercept
  canvas clicks; use its observed track where needed.
* After inserting a full-frame PNG, inspect Format options → size/position. The
  image's dimensions do not establish the inserted geometry. Check units, origin,
  aspect lock and actual canvas placement. Transparent margins count as part of
  the object. Background placement is not equivalent to a movable foreground layer.
* Replace image/video may preserve some properties and change others. Recheck
  geometry, timing, animation, scene duration and neighboring tracks after every
  replacement. Trim source range and scene duration separately; no empty tail.
* Show timing exposes object tracks. Separate entrance and exit animation when
  an object must remain through the cut. Inspect the complete photo effect and
  final frames for loop resets, jumps or collisions with text.
* A scene edge, transition badge and add-scene button can overlap. Use a fresh
  screenshot to identify a free handle area, drag, then verify actual timing. If
  using Split scene and deleting an unwanted tail, confirm that exactly the
  intended tail scene is selected immediately before Delete.
* Split may also split a continuous voice/caption object. Caption edits may affect
  linked occurrences. Check speech, visible captions and soft subtitle cues at
  every new boundary; do not assume split text objects are independent copies.
* Transcript correction can live under a selected voice/video → transcript →
  word → contextual Edit/Replace. Observe actual controls. After replacement,
  refresh stale refs. Correcting captions does not alter recorded speech.
* Styled captions need per-scene placement and legibility checks even with All
  scenes selected. Inspect silent clips for error-caption objects and remove only
  the confirmed error, preserving the video and legitimate captions. Animation
  can make short words translucent or restart at cuts; test a simpler entry/exit.
* Transitions can overlap scenes and change total timing. Verify downstream
  boundaries instead of adding a transition duration to the old scene total.

## File upload without a system picker

If fresh observation exposes a file input, establish its purpose first: an
Ingredients input uploads a reference, not necessarily media into a scene. Use
`vids_upload` only for that observed input. If a visible upload button creates an
input after clicking, use the atomic `vids_upload_via_picker` with the current
observed node or supported CSS coordinates and explicit local files. Do not click
first and expect a later tool to service an OS dialog.

The supported path intercepts the chooser before the guarded click, checks its
frame/input, sets only the specified files and restores interception in cleanup.
Main target and validated same-origin frames are supported; cross-origin/OOPIF
routes fail closed. This is not a promise about arbitrary OS dialogs or detached
sessions. An unknown chooser timeout must not be automatically retried. A successful
upload receipt proves neither completion, scene insertion nor generated output;
check the preview and intended canvas object.

## Enter text only after proving text-edit mode

Add a title creates an object; it may leave focus on the button. An offscreen
Document content field or an object bounding box does not prove text mode.
Ctrl+A/Backspace or `replace: true` can delete scene objects in selection mode.

Observe the new object, use the supported double-click on its visible text, then
confirm a caret or selection of letters **inside that title**. Only then replace
text. Keep editing scoped to that text, exit editing and verify exact Unicode,
line breaks and the surrounding scene. If text mode cannot be established, stop
that destructive replacement and inspect a supported alternative.

## Long operations, export and checkpoints

Wait with bounded observation for generation/upload/save completion. Do not
press Generate again because the result is not immediate. Inspect an actual
failure and the account's current availability; the skill cannot remove quotas.
Keep a compact checkpoint with the private project reference, decisions, actual
changes/evidence, current scene, open issues and next step in the authorized
workspace. Do not publish that checkpoint or persist control capabilities.

When available, typed `vids_job_start` supports only `export_mp4`, using a fresh
explicit automatic-download attestation. Generate and retain the caller job ID,
intent ID and random job capability before start. Its status/result/cancel tools
preserve unknown outcomes; recovery requires a newly acquired writer lease and
never replays a click. The job's technical success does not establish audiovisual
QA. Unsupported menus/referrers stop for reconciliation. Otherwise use an observed
authorized export route and verify the actual final file; see
[review-and-delivery](review-and-delivery.md).
