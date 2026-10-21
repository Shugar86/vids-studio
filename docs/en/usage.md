# Creative workflow and tools

[English](usage.md) · [Русский](../ru/usage.md) · [Home](../../README.md)

The skill makes production decisions; the connector provides observations and actions. Neither a successful click nor a clean file proves that a video communicates well. Keep an editable Vids project and inspect the actual result.

## Choose a starting point

| You want to… | A useful brief |
| --- | --- |
| Create a video | Audience, intended change in understanding, platform, language, duration and available materials |
| Improve an existing edit | The problem you see and the parts worth preserving |
| Replace a take | Which scene, what should change, and what must remain consistent |
| Review a video | Intended viewer and the decision or impression the video should produce |
| Diagnose a connection | Expected client/profile and observed error; no permission to edit a film is implied |

In Codex, invoke **google-vids**; in Claude Code, invoke **vids-director**. Both entry points route to the same English or Russian creative guidance. The model must use the tools actually available in that session rather than inventing a scene API.

### New video

> Use google-vids. In the connected document, create a 30-second English onboarding video for someone using our product for the first time. Use only the supplied product screenshots as factual UI evidence. Start with the user's problem, show one action and its visible result, and end with the next step. Use restrained motion and clear captions. Review the opening before producing the remaining scenes.

### Focused edit

> Use vids-director. Shorten the first scene without changing the agreed visual style. Keep the full spoken phrase, let the next shot begin under it, then verify the captions, music join and neighboring scene boundaries. Preserve the previous take.

### Review

> Review the connected video for a first-time viewer. Check the whole sequence, separate technical defects from editorial weaknesses, and identify where the promised action never actually happens. State what you viewed or heard and what remains unverified before proposing changes.

## A complete production pass

1. **Define one promise.** What will the viewer understand, feel or do after watching? Each scene should advance that promise.
2. **Prove the opening.** Create a representative beginning through its first completed event. A polished still or a later climax does not test whether the opening earns attention.
3. **Build usable material.** Separate narration from on-screen copy. Choose references and assets that actually show the intended action; do not invent product screens or factual results.
4. **Edit to speech and action.** Speech boundaries and shot boundaries can differ. Use cutaways under continuous narration; time silent scenes for reading and visible action.
5. **Shape the sound.** State voice intent, check delivery, and distinguish voice, music, ambience and sound effects. Do not regenerate every voice line just because the shot changes.
6. **Review the final sequence.** Check picture and motion, words and captions, audio, and viewer clarity. Fix open issues and recheck the affected neighbors. Export verification is a separate step.

The full creative corpus is in [`skill/google-vids/references/en/`](https://github.com/Shugar86/vids-studio/tree/main/skill/google-vids/references/en/); the [Russian corpus](https://github.com/Shugar86/vids-studio/blob/main/skill/google-vids/references/workflow.md) carries the same workflow. Profile builds ship the shared material to the corresponding skill.

## Tool rhythm

A typical agent sequence is:

```text
diagnostics → status → acquire_control → observe / screenshot
            → one observed action → fresh observe / screenshot
            → verify the result → release_control
```

`vids_status` does not attach or find tabs. The user attaches the intended tab through the extension. The task then acquires its own `controlToken`. Observations also require control so another task cannot invalidate its UI snapshot. Do not share a token with another agent or override `CONTROL_BUSY`.

| Tool group | Purpose |
| --- | --- |
| `vids_diagnostics`, `vids_status` | Runtime compatibility, attachment and control state |
| `vids_acquire_control`, `vids_renew_control`, `vids_release_control` | Own and release a task's lease |
| `vids_observe`, `vids_screenshot` | Current accessibility tree and viewport image |
| `vids_click`, `vids_drag`, `vids_scroll` | Input directed to an observed editor target |
| `vids_type_text`, `vids_press_key` | Unicode input and permitted tab-local keys |
| `vids_upload`, `vids_upload_via_picker` | Select explicitly authorized local media |
| `vids_reconcile_control` | Resume new work after inspecting an unknown old outcome |
| `vids_job_*` | Durable, conditional export workflow; see [jobs](jobs.md) |

Use current tool schemas for exact fields. Mutations require `sessionId`, the task's `controlToken`, a fresh `snapshotId`, and a unique `operation_id`. Coordinates are **CSS viewport pixels**, not necessarily screenshot pixels; use the returned scale. A mutation invalidates the previous snapshot. New UI evidence determines the next action.

If a timeout leaves an action's outcome unknown, inspect the document and receipt. Do not repeat the action simply because an answer was lost. The [architecture guide](architecture.md) explains ownership, fencing and reconciliation.

## Uploads without a system picker

If an observed `file-input` exists, use `vids_upload` with its `nodeRef`. If the input appears only after clicking Upload, use **one** `vids_upload_via_picker` call with the observed trigger and files. It enables interception before the click and checks the resulting input.

Do not click Upload first and then attempt desktop automation. The supported interception scope is the attached main CDP target and verified same-origin frames. Cross-origin and out-of-process iframe targets are rejected. This is not a universal promise that arbitrary web pages can never open an OS dialog.

The files must be existing local media included in the user's upload request. Upload sends them to Google. Unsupported formats or panel workflows need observation and verification; support for a PNG in one panel does not establish every media path.

## Retain takes and review evidence

The local `take_manifest.py` helper records source hashes/ranges, prompts/references, decisions and evidence. An 8-second take replaced by a 5-second take preserves both sources, records a −3-second planned change, and opens checks for timing, voice, styled captions, soft captions, music, SFX and neighbors. It does not edit the Vids timeline or prove those checks passed.

Other helpers prepare a transparent or opaque graphic, produce review frame sheets and inspect media signals. They use installed local tools and a separate headless browser where needed; they do not control the user's Chrome. Follow the skill's helper instructions and retain the manifest together with its asset archive.

## Deliver with an honest review boundary

A useful delivery identifies the editable project, the export if one was produced, what changed, what was inspected and any remaining weakness. Separate these four review axes:

| Axis | Evidence to seek |
| --- | --- |
| Picture and motion | Whole-sequence coverage, actual action, composition and transitions |
| Speech and text | Intended wording, pronunciations, readable and synchronized captions |
| Sound | Listening to voice, music, ambience and effects; clipping or silence checks alone are insufficient |
| Viewer clarity | A fresh viewer's understanding, attention and the promised result |

A frame sheet cannot prove motion quality; an accurate transcript cannot prove a natural voice; a valid MP4 cannot prove a compelling film. If your current client cannot hear or view something, record that limitation instead of claiming a review.
