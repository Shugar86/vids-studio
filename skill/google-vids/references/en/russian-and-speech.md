# Speech, Russian text and captions

Check language support for the specific feature and account: voiceover,
script-avatar, personal avatar, image ingredient, Convert Slides, closed captions
and styled captions are separate capabilities. Cyrillic text rendering does not
prove Russian TTS availability. Prefer current feature-specific documentation
and an observed short test; see [sources](sources.md). A visible track does not
prove anyone listened to it. These verification principles also apply to English.

## Produce a usable voice

Know whom the character addresses, why, and where their attitude changes. Turn
that into delivery: emphasis on an objection, a pause before admitting something,
a brief reaction after a result. Correct but monotone speech can still fail the scene.

Start with a short meaningful sample containing important names, numbers and
terms. Write for speaking; on-screen copy can be shorter. If audio tags are
available, compare a short tagged and untagged sample. A tag is not evidence of
expressive delivery. Spell out a difficult number/acronym for pronunciation while
preserving meaning and the requested language; changing language is not a fix.

After script changes, inspect the actual new audio even without an outdated
warning. If Insert/Update keeps old words, observe the available Preview → wait
for completion → Insert route and verify a fresh export. This is a candidate
check, not a guaranteed regeneration mechanism. Never retry an unknown generation.

Complete voice phrases need not align with shot boundaries. Keep one voice over
several meaningful cutaways rather than regenerating TTS for every shot. If native
voice is unavailable, use provided audio or a TTS route already authorized in the
task. A new provider, paid call or script upload does not follow automatically.
Do not silently substitute a silent video for a voiced brief.

## Review each speech take

1. Listen to the complete selected range: words, omissions, repetition, extra
   syllables, clipped edges, silence, pronunciation, intonation and intelligibility.
2. For independent ASR, supply audio without script, captions or expected prompt.
   Preserve the initial transcript before comparing it to the script. Never edit
   recognition to match expectations.
3. Check discrepancies against audio with adjacent words. Test a doubtful acronym
   in the full sentence and with local context, without cutting a word at the QA
   boundary. Two recognizers can share an error; neither establishes expression.
4. Fix clear defects within scope. Simplify a difficult phrase if the meaning
   remains; captions must follow the new speech. A clean self-contained range can
   be trimmed in Vids after checking its joins. Otherwise reject/regenerate it.

If listening or ASR is unavailable, exhaust available methods and state the
specific remaining limit. Do not call a transcript heard speech or require the
user to approve each take because of the current model's limitation.

[transcribe_local.py](../../scripts/transcribe_local.py) uses an existing local
whisper.cpp and model without installs, downloads, prompts or remote transcription.
Select language explicitly; the compatibility default is `ru`.

```bash
python3 scripts/transcribe_local.py work/export.mp4 --output work/qa/scene1 --language en --offset 10 --duration 5 --whisper-cli /path/to/whisper-cli --model-path /path/to/model.bin
```

Without explicit paths it checks an existing HyperFrames cache; absence is not
permission to install it. Every run requires a fresh output prefix. Timestamps
are relative to the ASR crop and approximate; `offset_seconds` is recorded in
run.json. Token probabilities are not calibrated accuracy or listening evidence.

## Captions and time domains

Check the actual language/font in native canvas and export. Latin preset samples
do not prove Cyrillic glyph coverage or fallback behavior. Choose font and size
for this scene. Divide UTF-8 SRT by meaning, punctuation and reading time; avoid
orphan prepositions and excessive short flashes.

Distinguish ASR crop time, original source time and final timeline time. At normal
playback speed:

```text
sourceMs = cropMs + cropOffsetMs
timelineMs = clipTimelineStartMs + sourceMs - sourceInMs
```

An ASR of the final export already uses timeline time. Changed playback speed
needs an explicit scale conversion. Recheck first/last words, neighbors and cues
after trim, split or replacement.

Closed captions, uploaded subtitle tracks and styled captions are different
layers. Extracted `mov_text` can differ from visible burned text; check both,
including cuts. Transcript edits do not prove a newly exported file and do not
change spoken audio. Locate the defect in sound, subtitle data or picture before
fixing the corresponding layer. UI guidance is in [operate-vids](operate-vids.md).
