# References, generated media and avatars

Generate what advances the scene, then accept the actual result against its
purpose. “Generated,” “selected,” “inserted” and “reviewed in playback” are
different states. Final assembly remains in Vids.

## Choose the source for the scene

Use provided real footage, documents, screens or product images when the scene
claims to demonstrate something real. Use licensed stock, native Vids media,
generated imagery or graphic explanation where they serve the purpose. Do not
invent data, client testimony, interface behavior or real-world evidence.

Use an available image-generation tool for photographic or illustrative raster
assets. Make precise text, diagrams and UI-like graphic layers with native Vids
objects or an authorized deterministic local renderer. A generated screenshot
is not proof of a working interface. Native text remains editable; text baked
into a PNG does not.

Real website capture may use provided recordings or an authorized isolated
browser. Exclude personal data or use demonstration data. Do not copy user
cookies/profiles to gain access. If authentication is unavailable, prepare an
honestly labeled mockup or the independent parts of the edit.

## Storyboard and references

Before costly generation, map the meaningful shots. For each, identify the
scene's job, starting state, concrete action, result, framing/scale, duration
relative to speech, essential invariants and the acceptance test. Distinguish
subject action, camera movement and overlays. Describe observable events rather
than adjectives such as “dynamic.”

Build a small reference set appropriate to the scene: identity/character,
location, object/mechanism, composition, lighting and any necessary ending state.
A single portrait is not enough to specify every angle or physical action. Keep
versions and provenance; use the same master identity where consistency matters.
Do not reuse the same framing everywhere merely because it generated reliably.

Keep complete TTS phrases independent of shot boundaries. A voice can continue
over detail shots and demonstrations. Reference every visible scene; do not
create a new voice generation merely to change the picture.

## Still images and graphic layers

Inspect an existing reference before editing it. Specify the subject, viewpoint,
composition, light, visual style, needed space for text and what must remain
consistent. Create a clean composition rather than asking a raster generator to
render important small text accurately. Check the actual result for identity,
anatomy, geometry, unsupported marks and usable framing.

For graphics, inspect a fully visible still before animation. A compact HTML/SVG
render is suitable for exact panels or diagrams when authorized. Use local
runtime/fonts with known licenses. Keep transparent layers separate when they
need independent movement in Vids. Check their full-frame dimensions and the
actual inserted object geometry; transparent margins still count as geometry.

## Native AI video and motion

Inspect the currently available modes: text/reference generation, image
animation, edit, extend or upscale may differ by account and release. Do not
bind the entire workflow to a remembered model name, duration or reference count.
A visible button establishes an available route, not a successful production result.

Prompt a concrete sequence: initial state → physically plausible action → final
state, with subject and background invariants. A horizontal hinge and a vertical
pivot permit different motion. If an action fails, change the staging assumption
or source instead of repeatedly adding prohibitions to the same prompt.

Generate a short representative take and wait for a definite result. Do not
click Generate again while the previous outcome is unknown. Review the beginning,
middle, end and full important movement: shape, hands/contact, background,
unwanted cuts, identity and actual action. Listen to any generated audio.

Check the active picture, not only the MP4 dimensions. A portrait container may
hold a letterboxed landscape composition. Reframe only if the required action
and subjects remain intact. Keep a clean source in/out range when a take contains
both usable and defective sections; the selected range must preserve the event,
not merely hide the failure. Apply the trim in Vids and verify the export.

An orbit around a stable subject is useful for revealing space or scale; it does
not fulfill “the subject turns away.” If the required event changes, call that a
creative revision. A short reversed clean range can be useful only when physically
plausible and within the authorized preparation scope; remove reversed audio and
check both new boundaries. A silent on-screen character must also look silent:
absence of an audio track does not rule out unintended lip articulation.

### Person and object in one take

When a scene depends on “the object acts → the person reacts,” stage both in one
Animate take from a frame that contains both subjects. Separate object/reaction
shots cannot demonstrate their joint presence. In one production trial, the brief
required the lamp to turn while the character stayed in frame. The following
techniques worked in a small set of trials; they are not model guarantees:

- **Say who moves the object.** A generated take assigned the turn to the person's
  hand. A useful correction was: “Both hands stay on the keyboard the whole time
  and never come near the lamp; nobody touches the desk lamp, it moves by itself.”
  Inspect the hands throughout the selected range.
- **Write timed beats against speech.** For example, “For the first 2.5 seconds
  they …; around 3 seconds the lamp …; around 3.5 seconds they …”: three or four
  beats, each with one action. Beat time = target word start − scene start + take
  source-in. Accepted trials landed within roughly ±0.3 seconds; this is observed
  precision, not a promise. An extra 1–2 seconds of generated material can provide
  room to select the entrance and exit.
- **Name the final state and its visible consequence.** For example, “…and stays
  turned away until the end; its warm light leaves him and his face is lit only
  by the laptop.” Without a sustained endpoint, an earlier take produced a
  one-frame flash and turned back. Simplify the sequence and clarify the result
  instead of endlessly adding prohibitions. One retry per take can be a useful
  budget; track generations when the observed panel provides no quota counter.
- **Join the preceding shot.** Use its last frame as the Animate reference when
  seeking a seamless cut. The model redraws the first generated frame, so inspect
  the actual difference across the join.
- **Preserve the resulting state.** If the lamp turned away, later shots should
  not show it lighting the person again without a motivated return. A reaction
  after a cutaway can come from the same take's tail rather than an older take
  with the previous lighting.
- **Silent character:** a naturally closed mouth, no generated speech, unwanted
  text/logos, extra hands or object morphing.

For the full causal sequence and acceptance checks, use
[action and reaction](action-and-reaction.md).

## Choose the right avatar deliverable

* **Static portrait/fictional character:** an image asset; movement and speech
  require separate production and checks.
* **Native script-avatar:** use the observed avatar/voice controls and test a
  short take in the requested language for identity, words and lip sync.
* **Personal avatar:** a separate account-holder face/voice recording workflow;
  do not promise it from a single arbitrary portrait or record on their behalf.
* **Saved avatar as a video ingredient:** verify that particular mode's access
  and language support independently.
* **Master portrait as an image reference:** a generated clip from an image,
  not registration of a Personal Avatar. Similar appearance does not establish
  voice cloning, exact speech or lip sync.

A control named “Start with an image” does not prove it accepts an uploaded
portrait. Use observed options. Keep identity, chosen voice and delivery stable
across scenes; compare an avatar voice to narration if switching between them.
After script changes check the actual new audio, not only an outdated indicator.
Do not represent a fictional speaker as a real owner or customer.

Keep the approved master portrait, source provenance, version, invariants, prompt
and tested use in a compact asset record. Do not promise an account-wide avatar
library from behavior observed in one document. If the requested mode is unavailable,
continue scripts/references/independent scenes. A portrait plus narration is an
alternative, not an automatic substitute for an agreed talking avatar.

## Assemble and accept

Insert the selected asset into the correct Vids scene, set crop, duration,
entrance/exit timing, text and audio, and inspect its neighbors. Let the action
finish. Do not mask a defective take with a fast transition. Use
[review-and-delivery](review-and-delivery.md) and retain unresolved issues until
there is evidence for their resolution.
