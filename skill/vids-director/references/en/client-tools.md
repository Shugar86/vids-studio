# Additional Claude helpers

These helpers preserve the shared [workflow](workflow.md), take-acceptance and QA
requirements. Inspect current arguments before use. They do not grant tab access,
new service permissions or dependency installation. Run examples from the skill
folder; keep generated material in the authorized task workspace.

## Layers and storyboard

Copy `assets/layers.en.html` to a scene source. Set format, colors, fonts, composition
and safe areas for the brief; sample portrait dimensions/margins are not platform
requirements. Each `.layer` with an ID has its final position on the full frame.
Movement is assembled in Vids.

```bash
node scripts/render_layer.mjs layers/scene.html layers/png/note-v1.png --show note
```

The result is a transparent full-frame PNG. `--guides --opaque` is for inspection,
not final import. Exit code 3 means text did not fit; repair layout. Rendering uses
isolated headless Chromium. After import check actual Vids geometry. PNG text is
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

`vids_call.mjs` is an optional CLI for the installed Claude MCP. It checks the
profile and requires its actual build path when it cannot resolve one locally.
Use `-` for JSON on stdin to avoid placing control capabilities in shell arguments.
Prefer the client's normal tools. This helper does not bypass discovery,
ownership, fresh snapshots, unknown receipts or background-only operation.
