#!/usr/bin/env python3
"""Check an episode card against a series kit before any generation; read nothing remote.

    python3 -I series_card.py check episodes/P190/card.json --kit kit [--recent prev.card.json ...] [--json]
    python3 -I series_card.py topic P190 --kit kit --plan sources/topics.jsonl

A series kit is a directory with formats.json, worlds.json and episode_rules.json
(template: assets/series-kit/). `check` exits 1 on errors; warnings need the director's
decision. The slideshow-risk score follows OpenMontage's plan-level heuristic: it rates the
plan, not the rendered pixels. `topic` prints one plan row with its format rule from the kit.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import re
import sys

MAX_JSON_BYTES = 4 * 1024 * 1024
MAX_PLAN_BYTES = 64 * 1024 * 1024
REQUIRED = ("topic_id", "title", "format", "truth_mode", "situation", "event_on_screen", "opening", "world",
            "styles", "taste", "beats", "spoken_text", "voices", "generation", "graphics", "avoid", "truth",
            "sample", "gates", "budget")
SITUATION = ("want", "obstacle", "turn", "final_image")
GATES = ("viewer_waits_for", "what_changes", "why_next", "not_generic")
ASPECTS = ("subject", "motion", "scene", "framing", "camera")
DIALS = ("visual_variance", "motion_intensity", "information_density")
METAPHOR = ("idea", "action", "object", "performer", "archetype")
KINDS = ("scene", "screen", "graphic")
QUOTES = "«»\"“”„"
TOL = 0.05


def read_json(path, limit=MAX_JSON_BYTES):
    path = Path(path)
    if not path.is_file():
        raise ValueError(f"not a file: {path}")
    if path.stat().st_size > limit:
        raise ValueError(f"file too large: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def load_kit(kit):
    kit = Path(kit)
    formats = read_json(kit / "formats.json")
    worlds = read_json(kit / "worlds.json")
    rules = read_json(kit / "episode_rules.json")
    for key in ("formats", "archetypes", "shot_sizes", "generic_words", "banned_openings"):
        if key not in formats:
            raise ValueError(f"formats.json has no {key}")
    for key in ("duration_seconds", "spoken_words", "budget_caps"):
        if key not in rules:
            raise ValueError(f"episode_rules.json has no {key}")
    return {"formats": {f["id"]: f for f in formats["formats"]}, "archetypes": set(formats["archetypes"]),
            "shot_sizes": set(formats["shot_sizes"]), "generic": [w.lower() for w in formats["generic_words"]],
            "banned": [w.lower() for w in formats["banned_openings"]], "worlds": {w["id"] for w in worlds["worlds"]},
            "rules": rules}


def words(text):
    return re.findall(r"[\wёЁ-]+", str(text))


def generic_hits(text, vocab):
    low = str(text).lower()
    return [w for w in vocab if w in low]


def span(beat):
    return float(beat["t"][0]), float(beat["t"][1])


def slideshow_risk(beats, total, generic_vocab):
    """Per-dimension 0–5 (lower is better) and a verdict with OpenMontage thresholds."""
    dims = {}
    sized = [b.get("shot") for b in beats if b.get("kind") != "graphic"]
    score, why = 0.0, []
    if len(sized) >= 4:
        size, count = Counter(sized).most_common(1)[0]
        if count / len(sized) > 0.5:
            score += 2.0
            why.append(f"shot {size} in {count}/{len(sized)} beats")
        run = longest = 1
        for a, b in zip(sized, sized[1:]):
            run = run + 1 if a == b else 1
            longest = max(longest, run)
        if longest >= 3:
            score += 1.5
            why.append(f"{longest} same-size shots in a row")
    pictures = [str(b.get("picture", "")).lower()[:40] for b in beats]
    if pictures and len(set(pictures)) / len(pictures) < 0.6:
        score += 1.5
        why.append("repeated picture descriptions")
    dims["repetition"] = (min(5.0, score), "; ".join(why) or "varied")
    no_why = sum(1 for b in beats if not str(b.get("why", "")).strip())
    dims["no_purpose"] = (round(5.0 * no_why / max(1, len(beats)), 1), f"{no_why} beats without why")
    text_time = 0.0
    for b in beats:
        try:
            if b.get("kind") == "graphic":
                a, z = span(b)
                text_time += max(0.0, z - a)
        except (KeyError, IndexError, TypeError, ValueError):
            pass
    dims["text_first"] = (round(min(5.0, 10.0 * text_time / max(total, 1e-9)), 1), f"graphics {text_time:.1f}/{total:.1f} s")
    vague = sum(1 for b in beats if generic_hits(f"{b.get('picture', '')} {b.get('action', '')}", generic_vocab))
    ratio = vague / max(1, len(beats))
    dims["generic_language"] = (3.0 if ratio >= 0.3 else round(ratio * 10, 1), f"generic words in {vague} beats")
    heroes = [i for i, b in enumerate(beats) if b.get("hero")]
    if not heroes:
        dims["hero"] = (4.0, "no hero moment")
    else:
        h = heroes[0]
        same = [j for j in (h - 1, h + 1) if 0 <= j < len(beats) and beats[j].get("shot") == beats[h].get("shot")]
        dims["hero"] = (2.0, "hero has the same shot size as a neighbour") if same else (0.0, "distinct hero moment")
    average = sum(s for s, _ in dims.values()) / len(dims)
    verdict = "strong" if average < 2 else "acceptable" if average < 3 else "revise" if average < 4 else "fail"
    return round(average, 2), verdict, dims


def check(card, kit, recent=()):
    errors, warnings = [], []
    for key in REQUIRED:
        if key not in card or card[key] in ("", None) or (key in ("beats", "styles") and not card[key]):
            errors.append(f"missing field {key}")
    if errors:
        return errors, warnings, None

    for key in SITUATION:
        if not str(card["situation"].get(key, "")).strip():
            errors.append(f"situation.{key} is empty")
    for key in GATES:
        if not str(card["gates"].get(key, "")).strip():
            errors.append(f"gates.{key} is empty: answer it before generation")

    fmt = kit["formats"].get(card["format"])
    if not fmt:
        errors.append(f"unknown format {card['format']}")
        return errors, warnings, None
    if card["truth_mode"] != fmt.get("truth_mode"):
        warnings.append(f"truth_mode {card['truth_mode']} differs from the format's {fmt.get('truth_mode')}")
    if card["world"] not in kit["worlds"]:
        errors.append(f"world {card['world']} is not in worlds.json: add it there or pick one")
    extra = set(card["styles"]) - set(fmt.get("styles", ()))
    if extra:
        errors.append(f"styles {sorted(extra)} are not allowed by format {fmt['id']}")

    taste = card["taste"]
    read = str(taste.get("design_read", ""))
    if len(words(read)) < 6 or (generic_hits(read, kit["generic"]) and len(words(read)) < 10):
        errors.append("taste.design_read needs one concrete sentence about this episode, not a list of adjectives")
    for dial in DIALS:
        value = taste.get(dial)
        if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= 10:
            errors.append(f"taste.{dial} must be an integer from 1 to 10")

    if fmt.get("metaphor_required"):
        metaphor = card.get("metaphor") or {}
        missing = [k for k in METAPHOR if not str(metaphor.get(k, "")).strip()]
        if missing:
            errors.append(f"format {fmt['id']} needs metaphor: missing {missing} (idea → action → object → performer)")
        elif metaphor["archetype"] not in kit["archetypes"]:
            errors.append(f"metaphor.archetype {metaphor['archetype']} is not in formats.json archetypes")
        if not str(card["gates"].get("without_hero", "")).strip():
            errors.append("gates.without_hero is empty: what is lost without the hero? If nothing, the hero is decoration")

    rules = kit["rules"]
    dmin, dmax = rules["duration_seconds"]
    wmin, wmax = rules["spoken_words"]
    text = str(card["spoken_text"]).strip()
    count = len(words(text))
    if not wmin <= count <= wmax and not card.get("length_exception"):
        errors.append(f"spoken text has {count} words, expected {wmin}–{wmax} (or length_exception with a reason)")
    first = (words(text) or [""])[0].lower()
    if first in kit["banned"] and not card.get("opening_exception"):
        errors.append(f"spoken text opens with «{first}»: show the framing with a label and an action (or opening_exception)")
    if any(q in text for q in QUOTES):
        warnings.append("quotation marks in the spoken text become straight quotes in captions")

    beats = card["beats"]
    t = 0.0
    graphic_total = 0.0
    for i, beat in enumerate(beats, 1):
        try:
            a, z = span(beat)
        except (KeyError, IndexError, TypeError, ValueError):
            errors.append(f"beat {i}: t must be [start, end] in seconds")
            continue
        if abs(a - t) > TOL:
            errors.append(f"beat {i} starts at {a} but the previous one ends at {t}: beats must be contiguous")
        if z <= a:
            errors.append(f"beat {i} ends before it starts")
        duration, t = z - a, z
        kind = beat.get("kind")
        if kind not in KINDS:
            errors.append(f"beat {i}: kind must be scene, screen or graphic")
        elif kind == "scene" and not str(beat.get("action", "")).strip():
            errors.append(f"beat {i}: scene without action — what happens?")
        elif kind == "screen" and len(beat.get("changes", [])) < duration / 2 - TOL:
            errors.append(f"beat {i}: screen of {duration:.1f} s has {len(beat.get('changes', []))} changes; need one per 2 s")
        elif kind == "graphic":
            graphic_total += duration
            if duration > fmt.get("max_graphic_seconds", 2) + TOL:
                errors.append(f"beat {i}: graphic lasts {duration:.1f} s, limit {fmt.get('max_graphic_seconds', 2)} s")
        if kind != "graphic" and beat.get("shot") not in kit["shot_sizes"]:
            errors.append(f"beat {i}: shot must be one of {sorted(kit['shot_sizes'])}")
        if not str(beat.get("why", "")).strip():
            errors.append(f"beat {i}: why is empty — why does this frame exist?")
    if beats and beats[0].get("kind") == "graphic":
        errors.append("beat 1 is a graphic: the opening must be an event")
    if not dmin - TOL <= t <= dmax + TOL and not card.get("duration_exception"):
        errors.append(f"duration {t:.1f} s, expected {dmin}–{dmax} (or duration_exception with a reason)")
    if t and graphic_total / t > fmt.get("max_graphic_share", 0.25) + 1e-9:
        errors.append(f"graphics take {graphic_total / t:.0%} of the time, limit {fmt.get('max_graphic_share', 0.25):.0%}")
    heroes = [i for i, b in enumerate(beats, 1) if b.get("hero")]
    if len(heroes) != 1:
        errors.append(f"exactly one beat needs hero: true, found {len(heroes)}")

    risk = slideshow_risk(beats, t, kit["generic"])
    average, verdict, dims = risk
    detail = "; ".join(f"{k} {s:g} ({why})" for k, (s, why) in dims.items() if s >= 2)
    if verdict == "fail":
        errors.append(f"slideshow risk {average} — fail: {detail}")
    elif verdict == "revise":
        warnings.append(f"slideshow risk {average} — revise: {detail}")

    spoken = " ".join(str(b.get("speech", "")) for b in beats)
    if words(spoken.lower()) != words(text.lower()):
        warnings.append("beat speech does not add up to spoken_text: check that the whole text is placed")

    sample = card["sample"].get("beats", []) if isinstance(card["sample"], dict) else []
    if 1 not in sample or (heroes and heroes[0] not in sample):
        errors.append("sample.beats must include beat 1 (the hook) and the hero moment")

    for graphic in card["graphics"]:
        if len(words(graphic.get("text", ""))) > 3:
            errors.append(f"on-screen text «{graphic.get('text')}» is longer than 3 words")
    for take in card["generation"]:
        spec = take.get("spec") or {}
        missing = [k for k in ASPECTS if not str(spec.get(k, "")).strip()]
        if missing:
            errors.append(f"take «{take.get('what')}»: spec lacks aspects {missing}")
        blob = " ".join(str(v) for v in [take.get("what", ""), take.get("prompt_notes", ""), *spec.values()])
        hits = generic_hits(blob, kit["generic"])
        if hits:
            errors.append(f"take «{take.get('what')}»: mood or stock words {hits} — describe the visible cause")
    if len(card["generation"]) > len(beats) / 2:
        warnings.append(f"{len(card['generation'])} takes for {len(beats)} beats: cover neighbouring beats with one take")

    for key, cap in rules["budget_caps"].items():
        if card["budget"].get(key, 0) > cap:
            errors.append(f"budget.{key} = {card['budget'][key]}, limit {cap}")
    if len(card["avoid"]) < 2:
        warnings.append("avoid: name at least two false paths for this episode")
    for key in ("opening_exception", "length_exception", "duration_exception"):
        if card.get(key):
            warnings.append(f"{key}: {card[key]}")

    for prev in recent:
        if prev.get("world") == card["world"]:
            errors.append(f"world {card['world']} was used in {prev.get('topic_id')}: neighbours change the world")
        prev_first = (words(prev.get("spoken_text", "")) or [""])[0].lower()
        if prev_first and prev_first == first:
            warnings.append(f"first word «{first}» repeats {prev.get('topic_id')}")
    return errors, warnings, {"average": average, "verdict": verdict,
                              "dimensions": {k: {"score": s, "reason": r} for k, (s, r) in dims.items()}}


def topic(topic_id, kit, plan):
    plan = Path(plan)
    if plan.stat().st_size > MAX_PLAN_BYTES:
        raise ValueError(f"plan too large: {plan}")
    for line in plan.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("topic_id") != topic_id:
            continue
        fmt = kit["formats"].get(row.get("format"))
        if not fmt:
            raise ValueError(f"topic {topic_id} has format {row.get('format')} that the kit does not define")
        out = {k: v for k, v in row.items() if k not in ("visual_brief", "production_status", "publish_date", "video_url")}
        out.update({"format_rule": fmt.get("visual_brief"), "event_patterns": fmt.get("event_patterns", []),
                    "styles": fmt.get("styles", []), "metaphor_required": bool(fmt.get("metaphor_required"))})
        return out
    raise KeyError(topic_id)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    c = sub.add_parser("check", help="validate one episode card")
    c.add_argument("card", type=Path)
    c.add_argument("--kit", type=Path, required=True)
    c.add_argument("--recent", type=Path, nargs="*", default=[], help="cards of previous episodes, newest last")
    c.add_argument("--json", action="store_true", help="print a JSON report")
    t = sub.add_parser("topic", help="print one plan row with its format rule")
    t.add_argument("topic_id")
    t.add_argument("--kit", type=Path, required=True)
    t.add_argument("--plan", type=Path, required=True)
    args = parser.parse_args()
    try:
        kit = load_kit(args.kit)
        if args.command == "topic":
            print(json.dumps(topic(args.topic_id, kit, args.plan), ensure_ascii=False, indent=1))
            return 0
        card = read_json(args.card)
        errors, warnings, risk = check(card, kit, [read_json(p) for p in args.recent])
    except (ValueError, KeyError, OSError, json.JSONDecodeError) as exc:
        print(f"series_card: {exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps({"topic_id": card.get("topic_id"), "errors": errors, "warnings": warnings,
                          "slideshow_risk": risk}, ensure_ascii=False, indent=1))
    else:
        for e in errors:
            print("ERROR:", e)
        for w in warnings:
            print("warning:", w)
        if risk:
            print(f"slideshow risk: {risk['average']} ({risk['verdict']})")
        print(f"{card.get('topic_id', '?')}: {len(errors)} errors, {len(warnings)} warnings")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
