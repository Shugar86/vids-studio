# Series on autopilot

For a channel or series whose episodes are produced from a topic plan without hand-directing each one. This is a method, not a template. The voice, hero, worlds and rules of a particular series live in the author's private project, in its **series kit**; editorial principles are in [editorial-series.md](editorial-series.md).

## Why a series slides into illustrated narration

Usually the inputs ask for it, not the producers:
- a script contract where a scene is "seconds → picture → spoken fragment", with no event field;
- one presentation rule for every topic of a format ("conditional animation", "one precise diagram");
- mandatory opening words ("imagine", "suppose") and identical openings;
- a stock character bible: warm light, plants, a smile into the lens;
- technical gates only: fingers, captions, export.

Fix the inputs. An episode starts with a **situation and an on-screen event**, and speech accompanies the event. Before generating, answer:
- what the viewer is waiting for right now;
- what changed in the frame with the sound off;
- whether the next moment is worth seeing.

## Series kit

A directory in the author's project; template: [assets/series-kit/](../../assets/series-kit/). Copy it and rewrite the wording, keeping the keys.

| File | Defines |
| --- | --- |
| `formats.json` | the format's presentation rule `visual_brief` (replaces the same field for every topic of that format), event patterns, styles, graphic limits, `metaphor_required`; archetypes, shot sizes, mood words, banned openings |
| `worlds.json` | lived-in worlds: specific light, traces of life, the hero's clothes; neighbouring episodes use different worlds |
| `episode_rules.json` | duration, word count, target voice tempo, generation and review-round limits |

Next to the kit keep a free-form series bible: the event principle, the hero and their behaviour, voices and lips, an anti-slop list and graphic styles.

## Episode card

One JSON page, the only input of the executor. Example: [example.card.json](../../assets/series-kit/example.card.json). Fields:
- **basis:** `situation` (want, obstacle, turn, final image), `event_on_screen`, `opening`, `world`, `styles`;
- **taste:** `taste`, a sentence and three dials;
- **metaphor:** `metaphor`, for formats that require it;
- **beats** (`beats`): `t`, `kind` (`scene`, `screen` or `graphic`), `shot`, `why`, `picture`, `action` or `changes`, `speech`, `sound`; exactly one `hero`;
- **voice and generation:** `spoken_text`, `voices`, `generation` (`beats`, `from`, `prompt_notes`, a five-aspect `spec`);
- **the rest:** `graphics`, `sound_events`, `avoid`, `truth`, `sample`, `gates`, `budget`.

Check before any generation; run from the series project, where `VIDS_SKILL_DIR` is the path to this skill:

```bash
python3 -I "$VIDS_SKILL_DIR/scripts/series_card.py" check episodes/T1/card.json --kit kit --recent episodes/T0/card.json
python3 -I "$VIDS_SKILL_DIR/scripts/series_card.py" topic T1 --kit kit --plan sources/topics.jsonl
```

An error (exit 1) stops the pipeline. A warning needs the director's decision. Exceptions — `opening_exception`, `length_exception`, `duration_exception` with a reason — show up as warnings. The script reads local files only.

## Gated pipeline

| # | Stage | Output | Gate | On failure |
| --- | --- | --- | --- | --- |
| S1 | Situation | 3 loglines + on-screen event | G1, critic: is the event visible with the sound off in the first 2 s, what changes, is the next moment wanted, truth label, no repeat of neighbours | one retry, then postpone the topic |
| S2 | Card | `card.json` | `series_card.py` without errors; G2, a critic reads only the card: the three questions and "where viewers swipe away" | one rewrite |
| S3 | Keyframes | 4–6 frames: event start, turn, result, ending; one sheet | G3, director: anti-slop, event readable, face, hands, caption space | change world, composition or style, not more prompt negations |
| S4 | Sample | the `sample` beats (hook and hero moment) with voice | G4, director: 4 fps sheet and blind ASR | two attempts per take, then simplify or change style |
| S5 | Vids assembly | edit by beats, cuts on word onsets, one export | G5, automatic: `cut_check.py` against the beats, ASR, streams | fix what is named, recheck what changed |
| S6 | Final critique | sheet and transcript | G6, critic | one fix round, then delivery |

**Roles:**
- **director** (strong model) — S1, S2, the G3 and G4 decisions, fixes after S6;
- **executor** (cheaper model) — S3–S5 strictly by the card; stops on any mismatch;
- **critic** — fresh context, only the artifact, without the intent or the desired verdict. Without a separate critic, pass the gate yourself and mark it as not independent.

**Budget.** Exceeding the limits in `episode_rules.json` means stop and report, not another round. The episode log records per stage: the model, tokens, generations, time, "accepted / rejected", and material decisions with their options. Compare the cost of an **accepted** episode including rework.

**Context.** The executor reads its stage, the card and the needed skill section, not the whole corpus. Take a screenshot only to verify an action. Script repeated operations.

## Techniques

From OpenMontage (ideas; no code was copied) and the practice of "Sasha and the lamp".

- **Slideshow risk on the plan.** `series_card.py` scores 0–5: repeated shot sizes and descriptions, frames without purpose, graphics share, generic words, the hero moment. With "fail", generation does not start. It rates the plan, not the pixels: check the result by frames.
- **Five aspects** for `spec`: subject, motion, scene (overlays listed separately), framing, camera. Write the visible cause instead of a mood: "cold fridge light on his face" instead of "cosy evening". Several speakers in one take break sync: one line per clip, or a listener's reaction.
- **Episode taste:** one concrete sentence and three dials — visual variance, motion, information density. The replace-the-title test: if the video would fit another topic, it is too generic.
- **Action metaphor** (Ink Theater): idea → one physical action → a simple contraption → the hero performs it. If the metaphor survives without the hero, the hero is decoration. Archetypes are in `formats.json`.
- **Explainer dramaturgy:**
  - misconception first, then the correction;
  - a naive attempt that breaks;
  - "but / therefore" instead of "and then";
  - 1–2 s of quiet after the insight.
- **Sample = hook + hero moment.** One take covers 2–3 neighbouring beats: fewer generations, smoother motion.
- **Programmatic style** (for example ink: black line on white, a mascot hero, strict colour). Rendered locally by the agent without network or third-party services when the project allows it; the finished clip is inserted into Vids. The OpenMontage engine is AGPLv3: run it from its own clone, do not copy it into the project.
- **A critic's note** is accurate (field, beat or frame), complete (check the whole class of error) and comes with a concrete fix. Two rounds, then the episode moves on with the open questions recorded.

Source: [calesthio/OpenMontage](https://github.com/calesthio/OpenMontage) — `lib/slideshow_risk.py`, `lib/variation_checker.py`, `skills/meta/taste-direction.md`, `skills/meta/reviewer.md`, `skills/creative/storytelling.md`, `skills/creative/short-form.md`, `skills/creative/ink-theater.md`, `skills/creative/video-gen-prompting.md` (version of 16 October 2026).
