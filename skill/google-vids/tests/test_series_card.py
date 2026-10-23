"""series_card: the template kit's example passes and each broken rule is caught; no network."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/series_card.py"
KIT_DIR = ROOT / "assets/series-kit"
spec = importlib.util.spec_from_file_location("series_card", SCRIPT)
series = importlib.util.module_from_spec(spec)
spec.loader.exec_module(series)
KIT = series.load_kit(KIT_DIR)
EXAMPLE = json.loads((KIT_DIR / "example.card.json").read_text(encoding="utf-8"))


def errors_of(card, recent=()):
    return series.check(card, KIT, recent)[0]


def warnings_of(card):
    return series.check(card, KIT)[1]


class Example(unittest.TestCase):
    def test_worked_example_is_clean_and_strong(self):
        errors, warnings, risk = series.check(EXAMPLE, KIT)
        self.assertEqual((errors, warnings), ([], []))
        self.assertEqual(risk["verdict"], "strong")


class CardRules(unittest.TestCase):
    def setUp(self):
        self.card = copy.deepcopy(EXAMPLE)

    def test_banned_opening_and_explicit_exception(self):
        self.card["spoken_text"] = "Допустим, " + self.card["spoken_text"]
        self.assertTrue(any("opens with" in e for e in errors_of(self.card)))
        self.card["opening_exception"] = "deliberate callback"
        self.assertFalse(any("opens with" in e for e in errors_of(self.card)))
        self.assertTrue(any("opening_exception" in w for w in warnings_of(self.card)))

    def test_long_static_graphic_and_short_graphic(self):
        long_card = copy.deepcopy(self.card)
        long_card["beats"][4]["kind"] = "graphic"
        self.assertTrue(any("graphic lasts 6.9 s" in e for e in errors_of(long_card)))
        self.card["beats"][2]["kind"] = "graphic"
        self.assertFalse(any("graphic" in e for e in errors_of(self.card)))

    def test_screen_needs_a_change_every_two_seconds(self):
        self.card["beats"][4]["changes"] = ["one message"]
        self.assertTrue(any("changes; need one per 2 s" in e for e in errors_of(self.card)))

    def test_scene_action_shot_why_and_hero(self):
        self.card["beats"][0]["action"] = ""
        self.card["beats"][1]["shot"] = "dutch"
        self.card["beats"][2]["why"] = ""
        self.card["beats"][-1]["hero"] = False
        errs = errors_of(self.card)
        for needle in ("scene without action", "beat 2: shot", "beat 3: why", "exactly one beat needs hero"):
            self.assertTrue(any(needle in e for e in errs), needle)

    def test_contiguous_beats_and_duration(self):
        gap = copy.deepcopy(self.card)
        gap["beats"][1]["t"] = [6.5, 8.6]
        self.assertTrue(any("contiguous" in e for e in errors_of(gap)))
        kit = copy.deepcopy(KIT)
        kit["rules"]["duration_seconds"] = [30, 40]
        self.assertTrue(any("duration 45.4 s" in e for e in series.check(self.card, kit)[0]))

    def test_text_length_and_quotes(self):
        self.card["spoken_text"] += " ещё" * 60
        self.assertTrue(any("expected 70–150" in e for e in errors_of(self.card)))
        quoted = copy.deepcopy(EXAMPLE)
        quoted["spoken_text"] = quoted["spoken_text"].replace("кнопка: ладно, ещё пять минут", "кнопка «ладно, ещё пять минут»")
        self.assertTrue(any("quotation marks" in w for w in warnings_of(quoted)))

    def test_overlay_world_style_gates_budget(self):
        self.card["graphics"][0]["text"] = "Launch already this very Friday"
        self.card["world"] = "beach"
        self.card["styles"] = ["ink", "neon"]
        self.card["gates"]["not_generic"] = ""
        self.card["budget"]["video_generations"] = 12
        errs = errors_of(self.card)
        for needle in ("longer than 3 words", "world beach", "not allowed by format", "gates.not_generic", "budget.video_generations"):
            self.assertTrue(any(needle in e for e in errs), needle)

    def test_five_aspects_and_visible_causes(self):
        del self.card["generation"][0]["spec"]["camera"]
        self.card["generation"][1]["spec"]["scene"] += ", moody cinematic light"
        errs = errors_of(self.card)
        self.assertTrue(any("lacks aspects ['camera']" in e for e in errs))
        self.assertTrue(any("visible cause" in e for e in errs))

    def test_taste_must_be_concrete(self):
        self.card["taste"]["design_read"] = "современно и стильно"
        self.card["taste"]["motion_intensity"] = 11
        errs = errors_of(self.card)
        self.assertTrue(any("design_read" in e for e in errs))
        self.assertTrue(any("motion_intensity" in e for e in errs))

    def test_explanation_needs_action_metaphor(self):
        self.card.update(format="visual_explanation", truth_mode="explainer", styles=["ink", "overlay"])
        errs = errors_of(self.card)
        self.assertTrue(any("needs metaphor" in e for e in errs))
        self.assertTrue(any("without_hero" in e for e in errs))
        self.card["metaphor"] = {"idea": "calm", "action": "pulls", "object": "lever", "performer": "hero", "archetype": "mechanism"}
        self.card["gates"]["without_hero"] = "nobody pulls the lever"
        self.assertFalse(any("metaphor" in e or "without_hero" in e for e in errors_of(self.card)))

    def test_sample_covers_hook_and_hero(self):
        self.card["sample"]["beats"] = [2, 12]
        self.assertTrue(any("sample.beats" in e for e in errors_of(self.card)))

    def test_one_take_per_beat_warns(self):
        self.card["generation"] = [dict(EXAMPLE["generation"][0], beats=[i]) for i in range(1, 8)]
        self.assertTrue(any("cover neighbouring beats" in w for w in warnings_of(self.card)))

    def test_neighbour_world_repeats(self):
        prev = dict(EXAMPLE, topic_id="P021")
        self.assertTrue(any("was used in P021" in e for e in errors_of(self.card, [prev])))


class MalformedCards(unittest.TestCase):
    def test_wrong_shapes_return_errors_without_scoring(self):
        cases = [None, [], dict(EXAMPLE, beats=[None]), dict(EXAMPLE, styles=[{}]),
                 dict(EXAMPLE, taste=[]), dict(EXAMPLE, generation=[{"spec": []}]),
                 dict(EXAMPLE, beats=[{"shot": {}}]), dict(EXAMPLE, sample={"beats": None})]
        for card in cases:
            with self.subTest(card=card):
                errors, _, risk = series.check(card, KIT)
                self.assertTrue(errors)
                self.assertIsNone(risk)

    def test_nonfinite_or_wrong_timestamps_cannot_bypass_checks(self):
        for times in ([0, float("nan")], [0, float("inf")], [False, 6.2], [0, 6.2, 9], ["0", "6.2"]):
            card = copy.deepcopy(EXAMPLE)
            card["beats"][0]["t"] = times
            card["duration_exception"] = "Intentional longer episode"
            self.assertTrue(any("t must be" in e for e in errors_of(card)))

    def test_budget_and_exceptions_need_real_values(self):
        for value in (True, -1, "6", float("nan")):
            card = copy.deepcopy(EXAMPLE)
            card["budget"]["video_generations"] = value
            self.assertTrue(any("budget.video_generations" in e for e in errors_of(card)))
        for reason in (True, 1, " "):
            self.assertTrue(any("written reason" in e for e in errors_of(dict(EXAMPLE, duration_exception=reason))))

    def test_hero_flag_is_not_a_truthy_string(self):
        card = copy.deepcopy(EXAMPLE)
        card["beats"][0]["hero"] = "false"
        self.assertTrue(any("boolean" in e for e in errors_of(card)))


class SlideshowRisk(unittest.TestCase):
    def test_slide_deck_plan_fails(self):
        beats = [{"t": [i * 4, i * 4 + 4], "kind": "graphic" if i % 2 else "scene", "shot": "medium",
                  "picture": "beautiful background", "action": "cozy atmosphere", "why": ""} for i in range(8)]
        average, verdict, dims = series.slideshow_risk(beats, 32, KIT["generic"])
        self.assertEqual(verdict, "fail")
        self.assertGreaterEqual(dims["repetition"][0], 3.5)


class Cli(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run([sys.executable, "-I", str(SCRIPT), *args], capture_output=True, text=True, timeout=60)

    def test_exit_codes_and_json(self):
        ok = self.run_cli("check", str(KIT_DIR / "example.card.json"), "--kit", str(KIT_DIR), "--json")
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertEqual(json.loads(ok.stdout)["slideshow_risk"]["verdict"], "strong")
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "bad.json"
            card = copy.deepcopy(EXAMPLE)
            card["beats"][0]["why"] = ""
            bad.write_text(json.dumps(card, ensure_ascii=False), encoding="utf-8")
            self.assertEqual(self.run_cli("check", str(bad), "--kit", str(KIT_DIR)).returncode, 1)
            self.assertEqual(self.run_cli("check", str(bad), "--kit", tmp).returncode, 2)

    def test_malformed_json_card_has_machine_readable_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "card.json"
            for value in ([], None, dict(EXAMPLE, beats=[None])):
                path.write_text(json.dumps(value), encoding="utf-8")
                run = self.run_cli("check", str(path), "--kit", str(KIT_DIR), "--json")
                self.assertEqual(run.returncode, 1, run.stderr)
                self.assertTrue(json.loads(run.stdout)["errors"])
                self.assertNotIn("Traceback", run.stderr)

    def test_topic_row_gets_the_kit_rule(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan = Path(tmp) / "plan.jsonl"
            plan.write_text(json.dumps({"topic_id": "T1", "format": "thought_experiment", "visual_brief": "old rule"}) + "\n", encoding="utf-8")
            run = self.run_cli("topic", "T1", "--kit", str(KIT_DIR), "--plan", str(plan))
            self.assertEqual(run.returncode, 0, run.stderr)
            row = json.loads(run.stdout)
            self.assertNotIn("visual_brief", row)
            self.assertTrue(row["metaphor_required"])
            self.assertIn("assumption as a deed", row["format_rule"])
            self.assertEqual(self.run_cli("topic", "T2", "--kit", str(KIT_DIR), "--plan", str(plan)).returncode, 2)


if __name__ == "__main__":
    unittest.main()
