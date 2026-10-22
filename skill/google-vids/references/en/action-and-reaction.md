# A person and an object: action, reaction and editing

Read this when a character and an object act together, especially when the object must move by itself. These lessons come from observed production trials; their lamp, voice and durations are not a template for the next film. See [generation](generation.md) for the basic generation workflow.

## Stage the event before generating

In the existing shot list, define an observable chain: **cue → object action → noticed change → human reaction → stable result**. If the brief needs a joint shot, keep the person and object together throughout the important action. A separate detail shot can supplement the scene but does not prove their joint action. Synchronization need not mean simultaneous starts: a reaction after a noticed event is often clearer than everyone moving at once.

| Participant | Define before the take | Check in the result |
| --- | --- | --- |
| Person | Initial gaze, both hands, reaction point, whether they speak | Recognizable identity; hands do not perform the forbidden action; reaction follows its cue; no accidental lip articulation under unrelated narration |
| Object | Initial orientation, axis/hinge, fixed support, final position | The intended part moves; the base stays in contact with the surface; shape remains stable; switching off a light or moving the camera does not substitute for motion |
| Camera and setting | Viewpoint, permitted camera motion, light, background landmarks | The person and event stay visible; the background does not dissolve or become another room |

For autonomous movement, describe the hands positively: for example, “Both hands rest on the desk away from the lamp and remain there.” A prohibition in the prompt is not proof. Visible hands and the gap between them and the object help establish lack of contact; if framing hides possible contact, do not claim that its absence was verified.

The reference must precede the action. An already turned-away object removes the needed transition. Retain the reference version, object side relative to the character, base geometry, clothing and light direction. Compare construction, not just color, between detail and joint shots. Preserve the new state in later shots unless a return movement is shown or intended.

## Prompt and select the take

Describe one main event in a short sequence. Example for a silent character with separate narration:

> One uninterrupted vertical medium shot based on the reference. The person and lamp remain visible together. Both hands stay on the desk away from the lamp. After a brief initial hold, the shade turns by itself around its visible vertical hinge, away from the person toward the wall; the base stays fixed. Only after the turn does the person look at the lamp, raise their eyebrows and smile slightly. The mouth remains naturally closed. Hold the lamp's final orientation and the reaction. Preserve face, clothing, object construction, light and background; keep the camera still.

This is a prompt structure, not a model guarantee or mandatory staging. Request mechanically possible motion for the reference. Timed beats may guide generation, but verify their precision in the result. Attach exact notifications, captions and SFX to the accepted take's actual motion. If an event must match a spoken line, choose its range and pace under both constraints while preserving meaning and speech.

Inspect the whole selected event range, including hands, mouth, background and the state after completion. Beginning/middle/end checks help select candidates; dense frames and available playback test the transition itself. Record actual movement start, completion and reaction times, `source in/out`, and the acceptance/rejection reason. “The object turned” does not resolve “the person helped,” “it immediately turned back,” “the reaction came before the cue” or “the model changed shots.”

When one defect repeats, change a relevant assumption: pose/reference, motion axis, framing, number of simultaneous actions or source. Do not endlessly add prohibitions to the same prompt. A usable range of an older take is valid if it contains the entire required event. Prefer verified material over generation for novelty alone.

## Pacing, graphics and a return to the opening

- Put the first distinct event early in a dynamic opening: a cue, action or result that raises a question. Also inspect the remaining time before the next meaningful change. In one trial, an earlier turn improved the entrance but did not automatically make the remaining static seconds interesting.
- Develop the scene through useful contrast: joint action → detail → reaction → graphic consequence. Change shots for new information, not a mandatory interval. Preserve the causal chain instead of cutting merely for frequency.
- Keep a usable master voiceover while rebuilding pictures. Several shots may share one phrase; a new cutaway alone does not require new TTS. Recheck captions and accents on the final timeline.
- Make graphics reveal development: a notification prompts a gesture, a stamp establishes an unexpected deadline, a growing document shows escalation. Even in the busiest frame, keep the face, hands and the object part that proves the event visible. A large check or bill must not hide the only evidence of a turn.
- Compare an expressive transition with a straight cut. A fade or dissolve cannot repair a pose jump or different object construction. First choose ranges, gaze direction and framing; then inspect text/audio overlap and both ends of the transition.

Changing the speed of a **selected silent range** is allowed only within the authorized preparation method. Measure the new action/reaction timing, realign SFX and do not accidentally stretch speech. Slow motion may emphasize expression but worsen morphing or judder; smoothness needs playback. Reusing an accepted take in the finale can deliberately recall the opening. Record the reuse and check that it does not look like an accidental loop; do not present it as a new independent take.

## Accept the event

Before batch generation, give an independent reviewer a short sample without explaining how well it is intended to work. Ask who did what, what caused it, when the person noticed, whether hands touched the object and what state remained. Require observable frames/timecodes and a separate statement of access to real-time video and sound. If causality exists only in the author's explanation, the scene still needs work.

After insertion, check the same event in the **native export**. A clean local take does not prove that Vids uses the correct range. Compare neighboring shots, hands/mouth, reaction timing, graphics and captions. A small later edit needs its changed windows and neighbors; a length/speed change requires checking affected downstream timing. See [timing and caption QA](timing-and-caption-qa.md) and [review and delivery](review-and-delivery.md).
