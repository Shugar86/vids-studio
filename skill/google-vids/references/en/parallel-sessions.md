# Multiple chats and videos

Each task owns one explicitly assigned document. Agents can work concurrently in different documents; discovering an attachment does not grant ownership.

1. The user attaches the intended tab through the correct profile's popup and gives its one-time pairing code to this chat. `vids_list_sessions` lists only published attachments for this profile. Match the exact document ID from the task; never select the first, free or active tab.
2. Before `vids_claim_attachment`, generate and privately retain `bindingId` and `intentId` (UUIDs), and `bindingToken` (32 random bytes encoded as base64url). Supply these, the exact `sessionId`, `expectedDocumentId`, `pairingTicket` and a clear `ownerLabel`. An identical claim can recover a missing receipt; a new identity cannot replace an owner.
3. Supply your binding credentials, exact document and session to `vids_acquire_control`. Use its `controlToken` for all observations and actions. A `snapshotId` and nodeRef belong only to the session and state that created them.
4. Release control when done. Release the binding only when this task is finished with the document. Idle control expiry retains the chat's document assignment; a pause does not hand it to another agent. After releasing the binding, explicitly disconnect and reattach that tab to obtain a new pairing code for a different task.

Never put capabilities in the shared panel, public logs, messages to other agents or reusable skills. Keep private recovery material only in the task's authorized workspace. An owner label is a description, not a password.

After explicit reattachment, use `vids_resume_binding` with your previous binding, the exact same document and the new popup code. The previous debugger generation must have a confirmed fence. If native returns reconciliation mode, inspect and reconcile before new input; do not repeat the old action. Process death, an old heartbeat, a free PID or elapsed time does not authorize takeover.

## Capacity and pauses

The shared governor limits concurrent operations across both profiles. More chats can remain connected than the current operation allowance. Waiting for cloud generation does not itself keep a command slot occupied; a browser capture with an unsettled outcome retains its slot.

`FLEET_BUSY` or a pause with `outcome: not_performed` means the command was not dispatched. If a response supplies `retryAfterMs`, respect it; otherwise wait at least a second before a bounded capacity retry. A pause requires resumption, not repeated requests. Continue independent preparation and re-observe before a new mutation. Avoid tight polling. An `unknown` outcome never authorizes retry, even with a new operation ID.

Start the panel with `bun run monitor` from an installed profile. It displays Codex/Claude attachments, active commands, waiting, recovery and measured resources. Pause blocks new input, captures, uploads and export triggers. Accessibility observations, status/diagnostics and existing download checks remain available. It does not claim to cancel already-dispatched input or cloud rendering. The panel does not capture screenshots, activate tabs, reveal capabilities or invent Google AI completion percentages.

A separate runner handles export: closing an MCP client should not stop an already-started download wait. Inspect only your jobId/jobToken. Missing heartbeat means unconfirmed status, not automatic replay. Local MP4 verification has its own shared limit; `waiting_for_local_capacity` means waiting for resources, not another export.

No guard locks the person's physical keyboard. Arrange a handoff if they edit the same document; background operation lets them use other apps and videos. Device sleep, closing Chrome, Google limits and shared GPU/memory remain system boundaries.
