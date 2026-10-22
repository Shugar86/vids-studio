# Sound, captions and frame-by-frame cut checks

Use this when replacing a take, changing pacing, synchronizing SFX, fixing caption repetition or checking an export. It supplements [speech checks](russian-and-speech.md) and [film review](review-and-delivery.md). Observed edits illustrate possible failures; their offsets and durations are not settings for every Vids project.

## Preserve speech and attach sound to the event

Separate voice, object sounds, ambience and music in the scene map. Tie each needed SFX to an actual event in the selected take: a notification, movement start/end, stamp impact or paper appearing. Music may give way to a pause before a reaction; a whoosh at every cut does not create pacing by itself.

If local audio preparation is authorized, a separate effects/pulse stem **without speech** lets you change accents independently. Assembly and mixing remain in Vids. Before replacing anything, establish which old bed is replaced and which tracks remain. Importing a new stem does not authorize deleting needed speech. Check source AI clips for an unnoticed second bed or voice.

After importing, inspect **both ends of the track**. In one observed edit, a stem landed at the current playhead around 3.1 seconds instead of zero; an export confirmed the position correction. When scene timing changes, recheck SFX and the music fade. Judge audibility, character and synchronization with the picture, not from waveforms or Volume % alone.

Technical source-to-mix comparisons must account for actual export delay. If editing splits the voice, compare sections separately: one global offset can hide local shifts. Low correlation within an overly narrow search window does not prove a missing track. Expected signal, LUFS and lack of clipping do not establish pleasant balance or natural delivery. Do not turn one export's measured offset/level into a permanent correction.

## Locate the repeated layer first

| Layer | Check | What this does not establish |
| --- | --- | --- |
| Spoken words | Audio and blind ASR without script/captions, then comparison | Correct visible text or intonation from ASR alone |
| Burned text | Video-stream frames without a subtitle-track overlay | Absence of a second set in the player |
| Separate CC | Extracted subtitle track and the target player | That text is burned in or actually spoken |

At a cut, distinguish **a complete caption held continuously**, **its reappearance**, **a one-word remnant of the previous phrase**, and **a position/entrance-animation jump**. In one reviewed export, two words continued across a cut without reappearing. Three other remnants were laid out anew on the next shots and were corrected. The judgment belongs to that export: similar words in a different version may behave differently.

Do not delete a correct word from the shared Transcript merely because it appears on both sides of a cut: linked captions may also lose it where needed. Moving a cut is justified when it improves the edit and speech, and requires checking video, neighbors and dependent timing. A universal “+1 frame” does not guarantee a fix. If the edit boundary is already correct and only a caption remnant is wrong, change the caption's own interval.

## A verified local caption trim

In an observed edit, three remnants were removed by trimming **the left edge of the next scene's caption object**, without changing voice/video or the shared Transcript:

1. From the export, establish the remnant range and the next complete phrase's start.
2. In Vids, open timing for the correct scene, zoom the timeline and select **Caption for the intended voice**. Use a fresh screenshot to distinguish the left handle from the object body and voice/video tracks.
3. Before trimming, inspect all text shown by that caption object. If it holds a correct complete caption before the defective remnant, first find an available way to isolate the defective interval; blindly trimming its left edge could remove the valid hold. When the left edge affects only the unwanted range, trim it to the intended point. Use the current zoom and CSS coordinates; old coordinates and pixel distances are not presets. Moving the body shifts the entire caption.
4. Observe again to verify caption start/duration, unchanged video/voice and Saved to Drive. Check the same cut in a new export.

In the reviewed UI, **Set timeline zoom** appeared as a textbox; clicking opened percentage options and Fit. Choose an observed option. Typing Fit and Enter produced a transient inconsistent canvas/timeline state. After zooming or scrolling, verify stable layout before dragging. Neither an AX click receipt nor the displayed zoom proves current geometry.

Do not copy trim lengths from that trial. Its remnants lasted 1, 1 and 5 frames; the correction retained the complete following phrases but delayed their appearance by one frame. This was a verified tradeoff, not a general synchronization rule. Measure the actual effect in each new case.

## Deliver one intended caption set

A player may enable `mov_text` over burned styled captions. If delivery needs one burned set, a separate copy without the subtitle track is acceptable **without re-encoding video or audio**. Preserve the native export; verify stream contents and equal A/V packet hashes before/after. This is container cleanup, not external picture editing. It neither fixes burned remnants nor updates the Vids project's captions. If the user wants selectable subtitles, preserve the corresponding deliverable; burned text alone does not authorize removing a requested track.

## Coverage and focused rechecks

A whole-film overview at 2 fps is useful, but even 10 fps windows can miss a one-frame defect. At a suspicious cut, decode **every frame from the end of the previous phrase through stable appearance of the next**, recording frame index and actual PTS. A −3…+3-frame window is a starting point, not sufficient coverage for every remnant: one observed remnant continued five frames past the cut.

Compare the new window with baseline: the old complete caption remains; the remnant is gone; the next phrase's first word survives; its actual onset is known; no blank frames appear. Separately inspect vertical alignment, readability at phone size and overlap with faces, hands and important action. A frame grid establishes visible states and event order, not real-time smoothness.

Compare actual cuts and PTS with selected source ranges, and inspect video/audio stream durations separately. One reviewed Vids export added an almost repeated final video frame without shifting other cuts; slightly longer AAC was not an additional video frame. First localize the difference: final hold, rounding, shifted edit or blank tail. Do not automatically remove the last frame to meet a planned count.

After a caption-only change, a full new ASR pass is unnecessary **if the new export's entire decoded audio is proven identical to the already checked audio**, with its original results and limits retained. Filename, duration and size do not prove this. If audio changed, recheck affected speech and mix. A substantial reconstruction requires full review through available methods.

Bind QA to file version/hash. Separate spoken text, audible quality, image, event order, smoothness, captions and viewer pacing; record method and `verified`/`failed`/`not_checked`. A single `export_verified: true` hides unchecked claims. Give an independent reviewer the material and original task without a desired verdict; ASR needs a separate pass without expected text. A technical PASS is not editorial acceptance and does not require asking the user to review every take.

If native UI confirms export while the job still awaits download correlation, do not blindly export again. Match the actual document and expected content, using time only as a clue; retain the confirmed file and follow the current [reconciliation workflow](operate-vids.md#long-operations-export-and-checkpoints). File evidence does not turn an unfinished job into a successful `job_result`. End waiting only through an authorized mechanism, without borrowing another agent's lease.
