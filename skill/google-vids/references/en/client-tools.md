# Shared Codex and Claude tools

Both profiles receive the same helpers and templates. They preserve the shared [workflow](workflow.md), take-acceptance and QA
requirements. Inspect current arguments before use. They do not grant tab access,
new service permissions or dependency installation. Run examples from the skill
folder; keep generated material in the authorized task workspace.

## Layers and storyboard

Copy `assets/layers.en.html` to a scene source. Set format, colors, fonts, composition
and safe areas for the brief; sample portrait dimensions/margins are not platform
requirements. Each `.layer` with an ID has its final position on the full frame.
Movement is assembled in Vids.

```bash
node scripts/render_layer.mjs layers/scene.html layers/png/note-v1.png --show headline
```

The result is a transparent full-frame PNG. `--guides --opaque` is for inspection,
not final import. Exit code 3 means text did not fit; repair layout. Rendering uses
isolated offline headless Chromium for static HTML; document JavaScript and
service workers are disabled. Frame and selected-element size limits prevent
accidentally enormous screenshots. After import check actual Vids geometry. PNG text is
not separately editable; keep future-editable text native where needed.

`vendor_fonts.py` explicitly downloads selected Google Fonts CSS/font files only
when authorized. Supply the applicable local license text and its source with
`--license-file` and `--license-source`; it copies the license and writes a
provenance manifest with hashes. It does not establish that a license permits your
intended use. No font binaries are bundled here. Check required glyphs in actual
rendered/native text, including Cyrillic.

A supported Design canvas can show frames and scene notes. It is optional; a
scene table and rendered frames suffice. For short motion inserts see
[motion-inserts](motion-inserts.md) and [HyperFrames notes](hyperframes.md).

## Authorized website capture

```bash
node scripts/capture_site.mjs https://example.com --out work/assets/site-v1 --scroll 6 --locale en-US
```

Dimensions, scale, capture height and scroll duration are bounded; invalid arguments
report supported limits. Encoding stops on admission loss and confirms process exit.
This uses an isolated browser without user profiles, cookies, clipboard or system
input. It makes network requests to the specified page and its resources; only
use it for authorized sites. Do not copy cookies for authentication. Check real
content, loading errors, privacy and crop. The optional scroll clip animates a
captured tall image; it is not evidence of real interactive behavior.

## Export QA and blind ASR

```bash
python3 scripts/qa_export.py exports/v1.mp4 --out qa/v1 --profile social
python3 scripts/asr_blind.py exports/v1.mp4 --out qa/v1-asr --language en
```

QA outputs findings.md, report.json and sheets: 2 fps full coverage, dense opening/
ending and candidate cut windows, with optional safe-area guides. It preserves the
source and refuses a nonempty output directory. Profiles `social`, `web` and
`broadcast` are diagnostic thresholds, not delivery goals. Silence, low motion,
loudness and peaks need interpretation against the brief; silent content needs
no speech or subtitle track. This tool cannot hear intonation, understand meaning
or prove smooth movement/burned captions. Shared review_sheet/inspect_media allow
explicit boundaries and thresholds.

Blind ASR uses existing whisper.cpp/model paths, with an existing HyperFrames
cache as a convenience fallback; no downloads. Choose `--language en` or `ru`.
Transcribe without the script first, then optionally `--compare` after preserving
the raw transcript. Offset/duration select a sample; another model can still make
the same recognition error. Matching words do not replace listening.

## SRT and low-level MCP client

```bash
python3 scripts/script_srt.py qa/v1-asr.words.json script.txt --out captions.srt
```

This combines script text with ASR timing; it is a candidate, not evidence of spoken
words. Resolve discrepancies against sound before import. Do not force disputed
speech to PASS by substituting expected copy. Verify supported subtitle upload,
sync, soft tracks and burned captions separately in the current build/export.

## Montage in the assigned video

`vids_ui.py` provides `scenes`, `replace`, `delete`, `add`, `fullframe`, `transition`, `playhead0` and `release`. Each step uses its own profile MCP, a fresh snapshot and a new operation ID. Add verifies an empty new last scene, fullframe checks Width/Height/X/Y, and transition verifies the selected type and duration. Review the actual result and export separately.

The montage helper supports Linux/macOS; use the same native MCP tools directly on Windows. It requires existing Node, Python and Pillow. Run from the skill directory and substitute only this task's explicitly assigned session/document:

```sh
mkdir -p -m 700 work/private-vids
python3 scripts/vids_ui.py acquire work/private-vids/control.json \
  --session SESSION_UUID --document DOCUMENT_ID --ticket-file - --label "My video task"
export VIDS_CONTROL=work/private-vids/control.json
python3 scripts/vids_ui.py scenes
python3 scripts/vids_ui.py replace 4 EXPECTED_MEDIA_NAME work/clip.mp4
python3 scripts/vids_ui.py fullframe 1920 1080
python3 scripts/vids_ui.py transition 4 Dissolve 0.6
python3 scripts/vids_ui.py release
```

Supply the popup ticket through stdin or an owned 0600 file, never argv/logs. The sibling `control.json.binding.json` saves this task's authority before claim; preserve it if a receipt is lost. There is no free-tab selection, borrowed token, automatic resume or replay of an unknown acquire. Release ends the writer lease, not the binding. Reconnection requires own credentials, a fresh ticket and protocol-defined fencing.

An existing control file must include `schemaVersion: 1`, `bindingId`, `documentId`, the exact `profileId` (`codex` or `claude`), `sessionId` and this task's `controlToken`, with file mode 0600 and directory mode 0700. Screenshot failure never reuses an old image. A mutation timeout stops the chain: inspect fresh status/observe and reconcile before further edits; do not repeat the intent using a different gesture. Montage heuristics target checked English labels and geometry; unsupported layouts require fresh native observations, not guessed coordinates.

The old filename-based `export` command is disabled. Use typed `vids_job_start/status/result` and download provenance; a matching filename does not establish provenance.

## Frame-cut review

```sh
python3 scripts/cut_check.py exports/v1.mp4 --out qa/v1-cuts --plan 86,258,299 --around 2.37,8.6
```

This local helper compares frame cuts against a plan, flags brief white/black flashes and creates caption-band sheets around cuts or selected times. It preserves the source and requires a new output directory, Pillow and FFmpeg/ffprobe. Findings are review heuristics, not proof of editing quality or speech perception.

## Low-level MCP client

`vids_call.mjs` resolves its own installed profile relative to the skill or through `VIDS_CODEX_BRIDGE` / `VIDS_CLAUDE_BRIDGE`, validating identity before launch. It never falls back to the other profile. Pass JSON through `-` and stdin to keep capabilities out of argv. Prefer normal MCP tools. The helper does not bypass discovery, ownership, fresh snapshots, unknown receipts or background-only operation.

Heavy `qa_export`, `cut_check`, `asr_blind`, `render_layer` and `capture_site` work waits for shared cross-profile media admission. This caps local processes, not video assignments. Do not nest a budgeted helper inside an active permit, or remove an interrupted permit marker without the prescribed confirmation.
