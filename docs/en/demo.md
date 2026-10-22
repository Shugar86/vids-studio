# Sasha and the lamp

[English](demo.md) · [Русский](../ru/demo.md) · [Home](../../README.md)

[**Watch the demo**](https://shugar86.github.io/vids-studio/) · [Download MP4 · 5.5 MB](https://shugar86.github.io/vids-studio/assets/sasha-and-the-lamp-v4.mp4)

**Dynamic opening v4** is a 46-second portrait short in Russian. It shows a real editing task in Google Vids with the Codex profile on Linux: give an existing sequence a more active beginning while preserving its voice and music.

## What changed

The first 8.4 seconds were rebuilt around a close-up of the lamp, its turn and Sasha's reaction. The edit remains in the original Vids project. Scene assembly, narration, music and burned-in captions were exported from Google Vids.

The published MP4 has one local finishing step: two repeated words were removed from its separate subtitle track. This remux preserved every video and audio packet and their timestamps; no picture or sound was re-encoded. The editable Vids project still contains those two soft-caption repetitions.

## What was checked

Evidence reviewed on **22 October 2026**:

| Check | Result |
| --- | --- |
| File | MP4, 5,461,679 bytes; container duration 45.859410 seconds |
| Picture | H.264, 1080 × 1920, 30 fps, 1,375 decoded frames |
| Sound | AAC, 44.1 kHz, stereo; audio packets and timing unchanged from the prior cut |
| Frame comparison | First 253 frames matched the prepared opening inserts; the remaining 1,122 matched the previous sequence |
| Subtitles | 19 soft-caption cues; two repeated-word prefixes removed, all cue timestamps preserved |
| Independent visual review | Sampled frames and cut boundaries inspected; no critical visual defect found in that inspection |

The frame comparison used grayscale images at 108 × 192. It excluded the lower burned-in caption strip in the first two scenes. This supports identification of the edit; it is not a full-resolution perceptual quality score.

SHA256 of the published MP4:

```text
9f9448fb4d580286076d916d6783b26f5b0bdcf89935c74c191f771b2432c4e8
```

## Export status

The connector triggered export once, the editor reported completion, and a downloaded file was obtained and verified separately. The automatic watcher stayed `armed` without a download GUID or ID. The typed job reached `needs_reconciliation` (`EXPORT_WAIT_EXPIRED`) and was then cancelled without retrying the export.

**The MP4 is verified; the complete automated export workflow has not passed live acceptance.** File recovery and content comparison do not retroactively prove browser-event correlation. The runtime version was not retained in the evidence, so this result cannot be credited to release v0.3.0 or to other clients/platforms. [Testing and verified limits](testing.md).

## Review limits

- No fresh real-time playback or listening was performed for this review. Unchanged audio is technical evidence, not a new assessment of how the mix sounds.
- The lamp close-up is nearly static from 3.7 to 6.2 seconds. Its turn is visible, but the light spot does not clearly move onto the wall.
- Two brief burned-in caption tails remain at the cuts around 6.2 and 10 seconds. The soft-caption correction does not alter burned-in text.
- The review did not verify social-platform safe zones or every account-dependent Google Vids feature.

This example shows the editing result and its documented limits. It is not a screen recording of the agent or a guarantee of the same result from every model, account or source material.
