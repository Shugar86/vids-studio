# Testing and verified limits

[English](testing.md) · [Русский](../ru/testing.md) · [Home](../../README.md)

Treat three kinds of evidence separately: **source checks**, **loaded runtime**, and **live product behavior**. Tests with a disposable browser are useful evidence of the mechanism. They do not establish that a particular Google account, current editor UI or generated video behaves the same way.

## Reproduce the automated checks

From a source checkout, install the locked dependencies and Playwright browser. Install FFmpeg/ffprobe through your environment's package manager if they are not already available.

```sh
bun install --frozen-lockfile
bunx playwright install chromium
python3 scripts/build_profiles.py --profile codex --target . --write
bun run test
python3 -I -m unittest discover -s skill/google-vids/tests
python3 -I -m unittest discover -s skill/vids-director/tests
```

The full suite includes Python unit/process tests and Node tests. Browser fixtures use disposable profiles and locally served or intercepted content. They do not attach to the user's Chrome or edit a real Google document. Media checks generate small local fixtures and use FFmpeg/ffprobe.

For a materialized profile, supply the complete source checkout to run the cross-profile source test:

```sh
VIDS_STUDIO_CANONICAL_SOURCE=/absolute/path/to/vids-studio bun run test
```

Without that explicit source, the cross-profile source test can be skipped in a standalone profile archive. Do not describe such a run as full source acceptance. Run the profile's own skill tests as well: `skill/google-vids/tests` for Codex or `skill/vids-director/tests` for Claude Code.

Useful focused checks include:

```sh
node --test tests/jobs.test.mjs tests/export-watch.test.mjs
node --test tests/profiles.integration.test.mjs
python3 scripts/build_profiles.py --profile codex --target /absolute/installation/codex --check
python3 scripts/build_profiles.py --profile claude --target /absolute/installation/claude --check
```

`--check` verifies managed file hashes and returns nonzero on drift. It does not reload any process or authenticate an AI client.

## What the suite exercises

| Area | Evidence provided by the suite |
| --- | --- |
| Profile packaging | Distinct identities, deterministic common builds, fresh targets, guarded updates and release contents |
| Setup | Preserved unrelated settings, collision refusal, exact rollback and prerequisite validation |
| MCP transport | Real local MCP clients/native processes; standard text and image responses |
| Document ownership | Independent documents, refusal of a second owner for the same document, durable unknown outcomes and generation fencing |
| Browser driver | Target/document validation, Unicode input, snapshots, drag, upload interception and screenshot recovery |
| Export watcher | Actual MV3 watcher with a disposable Chromium profile; HTTP, redirect and blob fixtures, event order and attribution failures |
| Export jobs | Durable intent, retained job capabilities, restart/recovery, cancellation, no automatic replay and local MP4 verification |
| Media helpers | Real small media/image fixtures, frame/alpha checks and take history/dependency invalidation |

Fixtures test known failure modes, not every timing interleaving or future browser change. Review new behavior with an appropriately targeted regression case; do not add tests that only restate implementation details.

## Read-only live smoke

After reloading the extension and refreshing MCP in a suitable pause, explicitly attach an otherwise unassigned test document. Match its exact session/document in discovery; give this check only that popup pairing code. Store the code alone in an owned 0600 text file inside a private 0700 directory (Windows: an equivalent owner-only ACL). Run inside that profile:

```sh
node scripts/live_smoke.mjs --document EXACT_DOCUMENT_ID --session EXACT_SESSION_UUID \
  --pairing-file /absolute/private/popup-code.txt --recovery /absolute/private/new-smoke.json
```

Use `--pairing-file -` to read the code from stdin; never put a code or token in command arguments. Optionally add `--screenshot /absolute/new-file.png`; the path must be new and absolute. The script checks runtime compatibility and the exact document/session, generates its own binding credentials, saves them in the new private recovery file before claiming, acquires control, observes, receives a standard PNG response, then releases its control and binding. It neither edits the movie nor selects another document. A busy or already assigned document is rejected; the helper never borrows an existing binding.

A failed or unconfirmed release remains a failed check. Keep the private recovery file while the result is unresolved; use its exact assignment and the regular binding/status tools to reconcile, without replaying input. After a successful check, the file can be deleted. The consumed popup code cannot claim a new task: explicitly disconnect/reconnect this tab for a new code. Printed evidence excludes capabilities and full DOM content. The old `--document ID` mode remains available only for a legacy single host; it fails closed on fleet discovery.

Run this separately for each profile. A successful SDK smoke confirms the transport and current attachment. It does not prove that a previously open client chat refreshed its tools, or that the client's model followed the creative skill correctly.

## Current acceptance boundary

The 0.4 implementation has automated coverage of both profiles and isolated browser mechanisms. The public package deliberately excludes private project content, local installation state and historical film screenshots.

### Ten concurrent Codex agents · 22 October 2026

Runtime **0.4.0**, core build `343c32838c097496cf09da154b82de7d800108615b7ad8993000ed606334f370`: ten actual `codex exec` model processes ran concurrently against ten disposable Chrome pages through separate MCP clients and native hosts. All ten performed and verified their own edit; all eighty tool calls succeeded, controls and bindings were released, and the active cover tab and its input remained unchanged. The run completed at 21:37:27 UTC. Private capabilities and model transcripts are not published.

The full Linux source suite and a freshly materialized Claude profile each passed 212 Node tests and 136 Python tests, with two Windows-only Python tests skipped. Separate integration checks cover a screenshot held past its deadline, targeted detach, cross-document refusal and export continuation after the MCP parent exits.

These are real model processes operating local fixtures, **not ten completed Google Vids films**. Claude model behavior and live multi-film editing remain separate acceptance steps. Reproduce the optional model run with the command in [parallel sessions](parallel.md).

<a id="codex-v4-export"></a>

### Earlier Codex v4 export · 22 October 2026

The earlier Codex v4 cut of Sasha and the lamp was exported from Google Vids on Linux. Its MP4 was obtained and independently verified, including decoded frames, stream preservation and subtitle timing. The public page now features a different film, [Claude v5](demo.md); the following job evidence belongs only to Codex v4.

The typed job triggered export once, and the editor reported that the video had exported. The watcher nevertheless remained `armed`, with no accepted download GUID or ID. The job reached `needs_reconciliation` with `EXPORT_WAIT_EXPIRED`, then was cancelled without repeating the export. The file's content was verified separately; its name and modification time were not treated as proof of browser-event correlation.

**Artifact verification passed; automatic download correlation did not pass acceptance.** The loaded runtime version is absent from the retained evidence. This observation therefore cannot be attributed to the v0.3.0 build or generalized to Claude Code, Windows or macOS. That review used frame inspection and technical audio comparisons, without fresh real-time playback or listening.

### Current Claude v5 demo

The [current film](demo.md) has separate verification of decoding, audio/video preservation after removing its soft-subtitle track, and a saved speech-recognition check. Its evidence does not establish a successful typed `export_mp4` job. The earlier Codex watcher failure is not a finding about this v5 export.

The following still require explicit live verification with the **current loaded build**:

- The typed `export_mp4` recipe against an actual Google Vids export, including its document referrer and download-event behavior.
- Account-dependent generation, avatars, voices, captions and other UI features chosen for a specific project.
- Audible, visible and editorial quality of each new video or take.
- Recovery from a particular real browser hang; a passing delayed-read fixture does not establish every live failure mode.

The export fixture intentionally supplies a full document referrer using `referrer=unsafe-url`. It proves the watcher under those conditions. Actual Vids may supply no referrer or only an origin; the implementation rejects that attribution rather than accepting a nearby file. Deprecated CDP download events and same-document concurrent downloads introduce additional limits described in [jobs](jobs.md).

A prior successful upload or observed menu is not evidence of a new export, a new build activation or a different account feature. Record observed results with version, profile and the type of environment; keep confidential project data out of public evidence.

## Building release artifacts

```sh
python3 scripts/build_release.py --output dist
```

This creates source, Codex and Claude ZIPs, `SHA256SUMS` and `release-manifest.json`. Dependencies, runtime stores, configuration backups and local work are excluded. Validate the archives, their hashes and both profile installs before publishing. Release creation does not itself create a GitHub release or push source changes.

## Native Windows/macOS CI

Run `python tests/platform_smoke.py` with the Windows dependency installed where applicable. The full regression suite above runs on Linux; native Windows/macOS CI exercises both profiles, installation/rollback, ownership, transport, media and archive reproducibility. It uses a simulated Chrome peer and makes no live Google Vids claim. [Platform guide](platforms.md).
