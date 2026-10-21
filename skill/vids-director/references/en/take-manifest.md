# Local take manifest

`scripts/take_manifest.py` records takes and the dependency checks reopened by a
replacement. It never contacts Google or edits the Vids timeline.
`planned_start_seconds` is a local plan; the actual edit needs separate evidence.
Run from the skill directory with a manifest path and JSON request file, or send
JSON on stdin when the second argument is omitted:

```bash
python3 scripts/take_manifest.py /absolute/project/takes.json /absolute/request.json
```

One manifest represents one project. Writes are atomic and concurrent calls use
a local lock. Sources are copied under SHA-256 into the adjacent `takes.takes/`
archive; original files remain unchanged. Keep manifest and archive together.
Restoration uses the stored copy and verifies its hash. There is no automatic
cleanup or guarantee against external deletion.

Audio/video duration is measured from the archived copy with existing ffprobe.
Nothing is downloaded. Images have no measured source duration; set their display
duration when assigning. Evidence can be existing local files or HTTP(S) links;
the helper stores remote URLs but does not inspect their content.

## Register and select

```json
{"op":"init","project_id":"episode-01"}
```

```json
{
  "op":"add_take",
  "take_id":"opening-v1",
  "asset_id":"opening",
  "kind":"video",
  "source":"/absolute/opening-8s.mp4",
  "source_range":{"start":0,"end":8},
  "prompt_id":"opening-prompt-v2",
  "reference_ids":["hero-reference-v3"],
  "action":{"start":"The character faces the camera","end":"The character turns away"},
  "verdict":{"status":"accepted","reason":"The complete action and both boundaries were reviewed in motion","evidence":["/absolute/review/opening-v1.json"]}
}
```

Omit source_range to use the full measured source. `prompt_id` may be null and
references empty for nongenerated material. Audio uses `speech_text` instead of
`action` (empty for non-speech audio). Images use `reference_version` and no source
range. Take IDs are immutable. Without a verdict, a take remains `unreviewed`
and cannot be assigned. `accepted`/`rejected` need reason and evidence; old
verdicts remain in history. Replace an assigned take before rejecting it.

```json
{"op":"verdict","take_id":"opening-v1","verdict":{"status":"accepted","reason":"Movement and audibility reviewed","evidence":["/absolute/review/opening-v1.json"]}}
```

## Replace eight seconds with five

Register the shorter take under a new ID, then assign/replace:

```json
{"op":"assign","scene_id":"opening","take_id":"opening-v1","reason":"Initial assembly"}
```

```json
{"op":"replace","scene_id":"opening","take_id":"opening-v2","reason":"Shorter complete turn"}
```

Ranges of eight and five seconds preserve both takes and the old selection,
record delta −3, and shift later **planned** scene starts by three seconds. Restore
with replace and the earlier take ID. A new source_range selects a different
trim without re-encoding. Image assign/replace requires `duration_seconds`.

Every change opens checks for `timing`, `voice`, `styled_captions`, `soft_captions`,
`music`, `sfx` and `neighbors`. A later plan change invalidates earlier dependency
checks. Open issues carry forward. `status` reports change IDs and timeline revision.

```json
{"op":"status"}
```

## Record a specific recheck

First inspect the current Vids/export ranges. `verified` and `failed` need a
reason and evidence. `not_applicable` needs a specific reason for an absent
optional layer. Old timeline revisions and already replaced selections cannot
be marked as checked.

```json
{"op":"review","change_id":"change-000002","timeline_revision":2,"dependency":"timing","review":{"status":"verified","reason":"The next scene begins at 00:05 in Vids and the export","evidence":["/absolute/review/export-timing.json"]}}
```

```json
{"op":"review","change_id":"change-000002","timeline_revision":2,"dependency":"music","review":{"status":"not_applicable","reason":"This brief has no music track","evidence":[]}}
```

`dependency_review_complete` means current checks have records, not that the
helper edited Vids or performed artistic QA. Never fabricate evidence for a green
status. From the repository root run `python3 -m unittest discover -s
skill/google-vids/tests -p 'test_take_manifest.py'`; the test uses real local eight-
and five-second clips with installed ffmpeg/ffprobe, without user Chrome.
`VIDS_TAKE_SCRIPT` can select another materialized client's helper for the same test.
