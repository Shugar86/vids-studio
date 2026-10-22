# Review and delivery

Keep four review results separate: **speech text accuracy**, **heard sound**,
**image/motion**, and **viewer clarity/rhythm**. For each applicable result record
method → evidence/timecode → `verified`, `failed` or `not_checked`; use
`not_applicable` with a reason for an absent optional layer. Technical integrity
is additional evidence, not a substitute. Passing one does not pass the others. Track meaningful unresolved issues against
the export version, with stable ID, time range, evidence, impact, recheck method
and status. New timing updates the range without erasing the original concern.
A repaired caption or clean decode does not close “nothing happens in the opening.”

When a comparison confirms that the final audio is unchanged from an earlier
reviewed export, retain only the listening evidence that actually existed.
Previously unperformed listening remains `not_checked`; identical sound does not
establish synchronization with a new picture. The same voice source on the
timeline does not prove an unchanged final mix.

## Review the working material

Inspect each scene and its neighbors for missing content, crop, text, identity,
object/contact errors, unexpected scene changes, visual hierarchy and continuity.
For a new take, compare initial state → actual action → result with the scene's
purpose. Reject absent action; an attractive camera move cannot replace it.
Review the opening through its first completed event early, before scaling up
expensive generation. A deliberate quiet format can have different criteria.

After changing a transition, inspect newly exposed frames, actual neighboring
scene boundaries and layers at the cut: overlap may have hidden an earlier defect.
A sample closes only the question it tested; a storyboard does not establish
identity in motion or the feasibility of a gesture.

Listen to every new speech take and to new music both separately and in the
final mix. Check words, extra/missing syllables, clipped edges, pronunciation,
intonation, loops, fades, rhythm and intelligibility. Treat Vids volume percentages
as controls to measure and hear, not a known linear gain formula. If there is
no audio in a deliberately silent brief, its absence is not a defect.

Watch the important motion in playback where available. Frames cannot establish
smoothness; a waveform, Play button or transcript cannot establish heard sound.
Use already available authorized perception tools and identify any remaining
limit. Do not make the user approve every take because one model cannot listen.

## Full coverage and independent critique

For a new or substantially re-edited video, inspect the entire export on a time
grid, not only convenient frames after an edit. Use
[review_sheet.py](../../scripts/review_sheet.py) for full coverage, a larger opening
and dense windows around known cuts. Read the manifest with actual timestamps,
then inspect every sheet and suspicious full-size frames. Sampling still leaves
motion between frames unobserved.

When an independent reviewer is available, give the raw export/frames, necessary
brief and viewing context without your intended verdict or explanation of why
it should work. For sound-off work, initially show the frames without transcript.
Ask them to identify the actual idea, the first completed event, why they would
keep watching or leave, the image proving the promise, unclear moments and the
three most consequential weaknesses. Request timecode → observed basis → concrete
change, not invented retention numbers. Use the same pass yourself if delegation
is unavailable and call it non-independent.

Review storyboard/representative samples before mass generation, but never treat
metadata such as `shot_intent`, camera names or a “slideshow risk” score as proof
of movement in pixels. Repeated objects may support causality; repeated unchanged
presentation may not. A critique cannot override the user's deliberate choice or
invent platform requirements.

Check every critique against actual evidence. Fix confirmed issues, explain a
supported exception or identify the missing information. Preserve unresolved
viewer issues until specifically rechecked or knowingly accepted by the user.
After a fix recheck the changed range and both neighboring boundaries. Narrow
edits can use this affected-range scope; a full reconstruction needs full coverage.

## Export the final version

Wait for saves, uploads and generation to settle. Use observed UI or the available
typed export job under its stated preconditions. A direct Drive route requires
an already authorized tool and current official documentation; do not extract
cookies or create credentials to bypass UI limits. Never assume the newest file
in Downloads belongs to the job.

Confirm the actual completed file: path, hash, duration, dimensions, expected
content and successful decode. Inspect opening, important events, cuts and ending
for blank tails, wrong crop and stale content. Check audio, visible burned captions
and any soft subtitle track separately. `mov_text` presence does not establish
burned captions, rendering in every player or accurate words. Editor CC settings
do not prove the final export.

Also check these delivery conditions:

- The file belongs to the intended document. Shared download folders may contain
  another agent's export; an observed wait selected the wrong film. Filename and
  modification time are clues, not attribution evidence. Compare actual content
  with the intended document and edit. A successful typed export requires the
  job's own evidence and its supported correlation with the browser download;
  independent file verification does not replace that status.
- Compare frame-level shot changes with the edit plan. Inspect scene ends for
  white/black frames: a scene longer than its clip may show white behind overlays.
  At each cut, inspect the caption band frame by frame from the old phrase's end
  through stable appearance of the next, looking for repetition or remnants.
- After changing only caption text, verify that audio stayed unchanged by
  comparing the previous and new export's decoded PCM.

Local helpers use installed ffmpeg/ffprobe, do not install them and preserve the
source. Run from the skill directory with new output paths:

```bash
python3 scripts/review_sheet.py work/export.mp4 --output-dir work/qa/sheets
python3 scripts/inspect_media.py work/export.mp4 --output work/qa/signal.json
```

* Review sheets cover the video at 2 fps, the first three seconds at larger scale,
  and known `--cuts` at 10 fps around ±0.5 seconds. Explicit `--safe-area` and a
  label provide diagnostic guides, not a universal platform guarantee.
* Signal inspection reports decode, integrated LUFS, oversampled true peak,
  sample peak/RMS, amplitude silence, low frame change and candidate cuts.
  Supply `--target-lufs` only for an actual delivery target; −14 LUFS is not a
  universal requirement.
* Silence/freeze thresholds are configurable prompts to inspect timing. Music
  can conceal a speech pause in a signal meter; a deliberate readable hold is not
  automatically a pacing defect. Candidate cuts can miss dissolves or misclassify
  motion. Supply observed cut times when known.
* `--pause-windows` measures the **whole mix** in independently established speech
  pauses. It cannot isolate music from clip noise or identify musical character.
* An analysis error is not a measurement. Successful execution with findings is
  not a creative pass. Use [speech guidance](russian-and-speech.md) for blind ASR;
  matching words do not establish intelligibility, delivery or musical balance.

## Deliver an honest result

Provide the editable Vids project and requested file when actually obtained.
Lead with what the video shows and how well it serves the viewer, including a
remaining weak point or sound-off ambiguity when relevant. Then give useful
format/duration and what was checked versus still unknown. Keep hashes and test
counts in technical evidence unless the user needs them for a decision.

Do not call a video finished with missing requested speech, pending generation,
known substantial damage or an unresolved material viewer issue. Technical
success is narrower than delivery acceptance. Downloading for the task does not
authorize public publication, sharing changes, messaging others or uploading to
another platform. Continue authorized preparation while stopping only the action
that lacks authorization.
