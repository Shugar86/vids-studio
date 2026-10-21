# Claude client profile

The shared [operate-vids](operate-vids.md) guide defines editor behavior and limits.
This file adds client differences only; private documents, historical coordinates
and another person's installation paths are not operational requirements.

* MCP is `vids-claude`; the extension is **Vids Studio · Claude**. Use the installed
  Claude profile build and its diagnostics. Installation paths and extension IDs
  come from the actual setup; the Codex build is not a substitute.
* Discover deferred tools through the client's available ToolSearch/discovery.
  A name is not evidence of connection. Respect busy control and background-only
  operation. Use the authorized install/reload route, not system-input workarounds.
* Text, geometry, timing, captions, upload and export follow the common guide and
  current observation. Reconciliation mode, unknown receipts and snapshot
  freshness apply to both clients.
* Additional helpers are in [client-tools](client-tools.md). `vids_call.mjs` invokes
  the same installed MCP build and grants no bypass. For a standalone skill copy,
  explicitly set `VIDS_CLAUDE_BRIDGE`; it checks profile.json and refuses another
  profile. Do not point it at a user's unrelated project.
* A Design storyboard canvas is optional. A table and rendered frames suffice
  without it; missing Design is not a reason to stop the edit.

Recovery preserves the old unknown action, observes the real document and
completes native reconciliation before new intents. Job recovery needs a new
writer token; never pass the previous token to another runner.
