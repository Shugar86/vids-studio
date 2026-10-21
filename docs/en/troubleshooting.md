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
| `BROWSER_RECOVERING` | An earlier screenshot read is still settling. Inspect status until `recovery: null`, then obtain a new observe. Do not send input while recovery is active. |
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

## Screenshot recovery has a boundary

For screenshot reads only, the driver can return `BROWSER_TIMEOUT` after ten seconds while retaining a barrier for the original read. It waits up to ten more seconds for that read to settle. Its late image is discarded; actions remain blocked and old snapshots are invalid. If the read never settles, the attachment is revoked.

This handles a delayed read, not a permanently hung Chrome renderer. It does not automatically foreground Chrome, reconnect or replay input. Timeout behavior for a mutation remains conservative.

## Upload and input checks

- Use `vids_upload_via_picker` when a file input is created after the upload trigger. Do not use desktop input to service a system dialog.
- Read coordinates in CSS viewport pixels and account for screenshot scale.
- Verify both the target and the resulting edit. A received event does not prove the application changed the scene.
- Unicode input is independent of keyboard layout; Russian support in a particular AI voice/generation feature must be checked separately.
- Close DevTools for the controlled tab if it has taken over the debugger. Reconnect explicitly after the active work is settled.

## Share useful diagnostics

A good bug report includes the commit/version, profile, OS/browser/Node versions, a minimal sequence, expected versus actual behavior, the error code and a redacted runtime compatibility result. State whether it came from a disposable fixture or live Vids and whether the current build was actually loaded.

Do not attach raw client configuration, rollback records, cookies, capabilities, job databases, private media or full editor snapshots. `bridge.log` is intentionally bounded and metadata-only, but still inspect a report before publishing it. For vulnerabilities, use the repository's [security policy](../../SECURITY.md).
