# Troubleshooting

[English](troubleshooting.md) · [Русский](../ru/troubleshooting.md) · [Home](../../README.md)

Start with `vids_diagnostics` and `vids_status`. They do not attach tabs, take control or edit the document. Establish which profile, build and document are actually active before changing anything.

| Symptom | Check and next step |
| --- | --- |
| MCP tools are missing | Run setup's dry-run in the correct profile directory. Confirm the client uses that MCP entry, then refresh/restart its MCP connection. Claude Code and Claude Desktop have different configuration routes. |
| `connected: false` | The native host may not be running. Check that the correct extension is loaded and explicitly connect a Vids tab. Verify the native manifest path and executable Python host; do not search other tabs through automation. |
| `attached: false` | Open the intended Vids document and attach it with the matching extension's button. Status alone cannot attach it. |
| `RECONNECT_REQUIRED` | Finish active work, reload the extension card, reconnect the intended tab and refresh MCP. Compare MCP/host/extension profile/version/build fields. Rebuilding files alone is insufficient. |
| `CONTROL_BUSY` | Another task owns this document. Let that task release its lease. Do not borrow its token, delete state, or use another profile to bypass ownership. |
| `STALE_SNAPSHOT` or stale session | Get current status, establish your own valid control and obtain a fresh observation. Do not reuse coordinates or tokens from an earlier attachment. |
| `BROWSER_RECOVERING` | Read `status.recovery.state`. `screenshot_read_pending` blocks another screenshot; `input_ack_pending` blocks mutations while an earlier scroll may still execute. AX/status remain available in these new modes. Obtain fresh evidence and follow the distinct recovery paths below. Older `waiting_for_read` blocks all browser operations. |
| `BROWSER_TIMEOUT` after a mutation | The outcome may be unknown. Inspect the receipt and document; do not repeat the click/type/upload merely because the response timed out. |
| `mode: reconcile` | Inspect the current document, then supply meaningful evidence to `vids_reconcile_control`. Keep the original unknown outcome recorded; this is not permission to replay it. |
| Export job needs reconciliation | Check [jobs](jobs.md): unsupported UI labels, referrer, session or ambiguous download evidence stop safely. Do not switch to guessing the latest MP4. |
| Setup reports a collision | It found another registration, profile, skill or path. Inspect the named conflict and keep the existing configuration intact. Setup deliberately does not guess which installation to replace. |
| Host cannot execute after ZIP extraction | Some extractors lose Unix mode bits. In the chosen installation run `chmod +x native/bridge.py`, then rerun setup's dry-run. |

## Reload the right component

An extension **reload**, tab **reconnect** and MCP **refresh** solve different problems:

1. Wait for active work to finish and release the task's control.
2. In `chrome://extensions`, click **↻ on the relevant extension card**. The page-wide Update button is different.
3. Return to the intended Vids document and explicitly connect it with that extension.
4. Refresh the matching client's MCP connection.
5. Require compatible diagnostics and the expected document. Acquire new control and a new snapshot.

For shared-document coordination, update **both** profiles. A still-running 0.1 host does not honor the 0.2 coordinator. Do not interrupt another task's active generation merely to refresh a file.

## A screenshot timeout preserves the attachment

In the updated driver, a screenshot read that does not answer within ten seconds returns `BROWSER_TIMEOUT`. This timeout does not detach the tab or revoke the task's control. Status reports `recovery.state: screenshot_read_pending`, `blocks: ["screenshot"]` and `timeoutMs: 10000`. There is no second deadline that detaches the tab. Normal control expiry, document changes and real disconnects still apply.

Obtain a fresh `vids_observe`: the timeout invalidates the old snapshot, but AX observation and actions using a fresh snapshot remain available. A new screenshot returns `BROWSER_RECOVERING` without sending another capture while the original read is pending. Its late result is discarded and cannot replace a newer snapshot. After the read settles, `recovery` becomes `null` and a new screenshot may be requested.

Chrome may fail to provide a frame when its window is hidden or occluded; a timeout alone does not prove that cause. The bridge does not foreground Chrome, use system input or promise that every background screenshot will succeed. Continue through AX only when it provides enough evidence for the intended action. If visual evidence is required, leave that action pending rather than guess from old pixels.

**Older builds:** `waiting_for_read` means the previous recovery contract: all browser operations remain blocked for up to ten more seconds, after which an unsettled read detaches the tab. Wait for `recovery: null` and re-observe if the same session survives, or reconnect explicitly after a detach. A missing `recovery` field does not establish support for the new behavior; verify the loaded build, not just files on disk. Mutation timeouts still require reconciliation of their unknown outcome, never automatic replay.

## A scroll timeout requires reconciliation

The updated driver also preserves attachment when a scroll's `Input.dispatchMouseEvent` times out. This is a pending **mutation**, not a screenshot read: status reports `recovery.state: input_ack_pending`, `blocks: ["mutations"]` and `requiresReconciliation: true`. AX observation and status remain available, but all mutations, control release and reconciliation are blocked until that original Chrome command actually settles. A timeout does not prove the wheel was delivered or cancelled; it may execute later.

After a late ACK or rejection, the original outcome remains `unknown`. Obtain a fresh `vids_observe`, establish what happened and use `vids_reconcile_control` with evidence before any new write. The end of `input_ack_pending` alone does not authorize another action, and a successful ACK alone does not prove the editor scrolled. Do not retry the old scroll or switch to another gesture to repeat the same intent.

This contract applies only to a loaded build reporting `input_ack_pending`. Other mutation timeouts retain their existing fail-closed/reconnect handling. The bridge does not foreground Chrome or use system input to resolve a pending wheel event.

## Upload and input checks

- Use `vids_upload_via_picker` when a file input is created after the upload trigger. Do not use desktop input to service a system dialog.
- Read coordinates in CSS viewport pixels and account for screenshot scale.
- Verify both the target and the resulting edit. A received event does not prove the application changed the scene.
- Unicode input is independent of keyboard layout; Russian support in a particular AI voice/generation feature must be checked separately.
- Close DevTools for the controlled tab if it has taken over the debugger. Reconnect explicitly after the active work is settled.

## Share useful diagnostics

A good bug report includes the commit/version, profile, OS/browser/Node versions, a minimal sequence, expected versus actual behavior, the error code and a redacted runtime compatibility result. State whether it came from a disposable fixture or live Vids and whether the current build was actually loaded.

Do not attach raw client configuration, rollback records, cookies, capabilities, job databases, private media or full editor snapshots. `bridge.log` is intentionally bounded and metadata-only, but still inspect a report before publishing it. For vulnerabilities, use the repository's [security policy](../../SECURITY.md).
