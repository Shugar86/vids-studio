# Sasha and the lamp · Claude v5

[English](demo.md) · [Русский](../ru/demo.md) · [Home](../../README.md)

[**Watch the demo**](https://shugar86.github.io/vids-studio/) · [Download MP4 · 8 MB](https://shugar86.github.io/vids-studio/assets/sasha-and-the-lamp-v5.mp4)

The creator selected **Claude v5** as the public demo. This 45.5-second Russian-language short was assembled in Google Vids with Claude Code. It replaces the earlier Codex v4 film on the demo page.

## What changed

- New generated shots let the lamp turn away while Sasha remains in frame. In the finale, his hands stay on the keyboard while the lamp moves itself.
- The 12-scene edit aligns its 11 cuts to the highlighted words in Vids, addressing repeated words at scene boundaries.
- Unwanted words were cleared from the editor’s transcript. The downloaded MP4’s extra soft-subtitle track was removed locally, leaving the burned-in Russian captions. Picture and sound were preserved without re-encoding.

The project remains editable in Vids. English translation is available as an optional caption track in the web player; it is separate from the MP4.

## What was checked

Checks reviewed on **22 October 2026**:

| Check | Result |
| --- | --- |
| File | MP4, 7,961,035 bytes; container duration 45.464671 seconds |
| Picture | H.264, 1080 × 1920, 30 fps, 1,363 frames |
| Sound | AAC, 44.1 kHz, stereo; measured −16.5 LUFS |
| Full decoding | Video and audio decoded without errors |
| Export preservation | All 1,363 video and 1,958 audio packets, including timestamps, match the native v5 export |
| Captions | No embedded soft-subtitle stream; Russian captions remain in the picture |
| Saved speech check | Whisper small, without a prompt: 103/103 normalized words matched the script |

SHA256 of the published MP4:

```text
21bca0fd9f5e3d25b7fda4a3458a8bd215483228ba201262f4a206125fea2459
```

## Review limits

The production review inspected frame sheets and cuts. It records a one-frame early appearance of the next caption line around frames 86 and 543 (approximately 2.87 and 18.10 seconds). No fresh full real-time viewing or listening was performed for that review. Speech recognition and loudness measurements do not establish how the mix sounds or how natural every movement feels.

## Export status

This file verifies the delivered film, including the local removal of its extra subtitle stream. The retained evidence does not establish successful completion of the typed `export_mp4` recipe for v5 or acceptance of the current runtime build.

The [earlier Codex v4 export observation](testing.md#codex-v4-export) remains a separate historical record: its downloaded file was verified, while automatic download correlation failed. That job outcome is not attributed to Claude v5. [Testing and verified limits](testing.md).
