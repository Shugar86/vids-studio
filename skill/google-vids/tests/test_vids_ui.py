"""vids_ui pure helpers: python3 -m unittest discover -s tests"""
import sys
import contextlib
import io
import subprocess
import tempfile
import os
import threading
from concurrent.futures import ThreadPoolExecutor
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import vids_ui  # noqa: E402


class ThumbnailStrip(unittest.TestCase):
    def test_finds_row_with_all_thumbnails(self):
        k = 1.5
        im = Image.new("RGB", (int(1300 * k), int(900 * k)), (240, 243, 248))
        dr = ImageDraw.Draw(im)
        boxes = [(60, 140), (170, 230), (260, 420), (450, 500)]
        for x0, x1 in boxes:   # thumbnails 650–720 CSS, a taller toolbar block above them
            dr.rectangle([x0 * k, 650 * k, x1 * k, 720 * k], fill=(60, 50, 40))
        dr.rectangle([60 * k, 580 * k, 1000 * k, 600 * k], fill=(30, 90, 200))
        y, rs = vids_ui.thumb_runs(im, k, n=4)
        self.assertTrue(650 <= y <= 720)
        for (a0, a1), (b0, b1) in zip(rs, boxes):
            self.assertAlmostEqual(a0, b0, delta=1.5)
            self.assertAlmostEqual(a1, b1, delta=1.5)

    def test_missing_strip_returns_empty(self):
        im = Image.new("RGB", (1000, 900), (240, 243, 248))
        self.assertEqual(vids_ui.thumb_runs(im, 1.0, n=3), (None, []))

    def test_strip_wider_than_the_default_search_is_found(self):
        # With the side sheet closed, the last thumbnails sit past x 1250 CSS px (seen live with 8 scenes).
        im = Image.new("RGB", (1728, 900), (240, 243, 248))
        dr = ImageDraw.Draw(im)
        boxes = [(51, 245), (271, 421), (447, 587), (614, 788), (815, 989), (1016, 1159), (1185, 1336), (1362, 1499)]
        for x0, x1 in boxes:
            dr.rectangle([x0, 722, x1, 790], fill=(60, 50, 40))
        with patch.object(vids_ui, "shot", return_value=(im, 1.0)):
            rs = vids_ui.thumbs(8)
        self.assertEqual(len(rs), 8)
        self.assertAlmostEqual(rs[-1][1], 1499, delta=1.5)


class Parsing(unittest.TestCase):
    def test_objects_from_cli_output(self):
        out = '{"result": {"image": {"scaleX": 1.6667}}}\n{"image": "/tmp/x.png", "mimeType": "image/png"}\n'
        objs = vids_ui._objects(out)
        self.assertEqual(len(objs), 2)
        self.assertEqual(objs[0]["result"]["image"]["scaleX"], 1.6667)

    def test_runs(self):
        self.assertEqual(vids_ui.runs([1, 2, 3, 7, 8, 10]), [(1, 3), (7, 8), (10, 10)])


class FailedCalls(unittest.TestCase):
    def test_process_failure_cannot_return_a_success_receipt(self):
        result = subprocess.CompletedProcess([], 1, '{"result":{"performed":true}}', 'failure')
        with patch.object(vids_ui.subprocess, "run", return_value=result), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                vids_ui.call("vids_click")

    def test_tool_error_is_rejected_even_if_process_exits_zero(self):
        result = subprocess.CompletedProcess([], 0, '{"ok":false,"error":{"code":"BROWSER_TIMEOUT"}}', '')
        with patch.object(vids_ui.subprocess, "run", return_value=result), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                vids_ui.call("vids_screenshot")

    def test_timeout_stops_without_exposing_control_arguments(self):
        error = subprocess.TimeoutExpired(['node', 'secret-control-token'], 1)
        stderr = io.StringIO()
        with patch.object(vids_ui.subprocess, "run", side_effect=error), contextlib.redirect_stderr(stderr):
            with self.assertRaises(SystemExit):
                vids_ui.call("vids_scroll")
        self.assertNotIn('secret-control-token', stderr.getvalue())


@unittest.skipUnless(os.name == "posix", "Explicit private Python screenshot files require POSIX checks")
class ScreenshotReceipt(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'shot.png'
        Image.new('RGB', (1728, 891), 'red').save(self.path)
        self.old = self.path.read_bytes()
        self.receipt = {'snapshotId': 'fresh-shot', 'coordinateSpace': 'css-viewport',
                        'image': {'width': 200, 'height': 100, 'scaleX': 2, 'scaleY': 2}}

    def response(self, tool, params, image):
        Image.new('RGB', (200, 100), 'blue').save(image)
        return self.receipt, [self.receipt, {'image': str(image), 'mimeType': 'image/png'}]

    def test_failed_capture_does_not_read_the_previous_image(self):
        error = {'ok': False, 'error': {'code': 'BROWSER_TIMEOUT'}}
        with patch.object(vids_ui, 'call', return_value=(error, [error])), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                vids_ui.shot(self.path)
        self.assertEqual(self.path.read_bytes(), self.old)

    def test_missing_new_image_does_not_fall_back_to_the_previous_image(self):
        with patch.object(vids_ui, 'call', return_value=(self.receipt, [self.receipt])), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                vids_ui.shot(self.path)
        self.assertEqual(self.path.read_bytes(), self.old)

    def test_success_returns_fresh_pixels_and_reported_scale(self):
        with patch.object(vids_ui, 'call', side_effect=self.response):
            im, scale = vids_ui.shot(self.path)
        self.assertEqual(im.size, (200, 100))
        self.assertEqual(im.getpixel((0, 0)), (0, 0, 255))
        self.assertEqual(scale, 2)
        self.assertNotEqual(self.path.read_bytes(), self.old)
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_parallel_default_shots_use_distinct_private_paths_and_delete_them(self):
        gate = threading.Barrier(2)
        captures = []
        def capture(tool, params, image):
            image = Path(image)
            captures.append(image)
            self.assertEqual(image.parent.stat().st_mode & 0o777, 0o700)
            gate.wait(timeout=2)
            return self.response(tool, params, image)
        with patch.object(vids_ui, "call", side_effect=capture), ThreadPoolExecutor(max_workers=2) as pool:
            tasks = [pool.submit(vids_ui.shot) for _ in range(2)]
            for task in tasks:
                image, scale = task.result(timeout=5)
                self.assertEqual((image.size, scale), ((200, 100), 2))
        self.assertEqual(len(set(captures)), 2)
        self.assertTrue(all(not path.parent.exists() for path in captures))

    def test_explicit_success_is_private_and_symlink_target_is_not_overwritten(self):
        with patch.object(vids_ui, "call", side_effect=self.response):
            vids_ui.shot(self.path)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        linked = self.path.parent / "linked.png"
        linked.symlink_to(self.path)
        before = self.path.read_bytes()
        with patch.object(vids_ui, "call") as call, contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            vids_ui.shot(linked)
        call.assert_not_called()
        self.assertEqual(self.path.read_bytes(), before)

    def test_missing_scale_does_not_infer_the_old_viewport_size(self):
        del self.receipt['image']['scaleX']
        with patch.object(vids_ui, 'call', side_effect=self.response), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                vids_ui.shot(self.path)
        self.assertEqual(self.path.read_bytes(), self.old)

    def test_image_dimensions_must_match_the_current_receipt(self):
        self.receipt['image']['width'] = 300
        with patch.object(vids_ui, 'call', side_effect=self.response), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                vids_ui.shot(self.path)
        self.assertEqual(self.path.read_bytes(), self.old)


class Playhead(unittest.TestCase):
    def snapshot(self, name):
        return {"nodes": [{"ref": "n1", "role": "time", "name": name}]}

    def test_reads_seconds_milliseconds_and_minutes(self):
        self.assertEqual(vids_ui.playhead_seconds(self.snapshot("Playhead at 3 seconds out of 42 seconds.")), 3)
        self.assertAlmostEqual(vids_ui.playhead_seconds(self.snapshot("Playhead at 78 milliseconds out of 14 seconds.")), 0.078)
        self.assertEqual(vids_ui.playhead_seconds(self.snapshot("Playhead at 1 minute 2 seconds out of 2 minutes.")), 62)

    def test_missing_node_is_none(self):
        self.assertIsNone(vids_ui.playhead_seconds({"nodes": []}))


class FakeEditor(unittest.TestCase):
    """Mutating helpers against small editor models: a result counts only when the model's state shows it.
    The three refusal cases reproduce gaps found in review (an append landing mid-timeline, input that did
    not apply, a transition that kept its old type)."""

    def run_helper(self, model, helper, *args):
        self.calls = []

        def fake_call(tool, params=None, image=None, timeout=150):
            params = {k: v for k, v in (params or {}).items() if k not in ("snapshotId", "operation_id")}
            self.calls.append((tool, params))
            if tool == "vids_observe":
                return {"result": {"snapshotId": "snap", "nodes": model.nodes()}}, []
            model.act(tool, params)
            return {"result": {"performed": True}}, []

        with patch.object(vids_ui, "call", side_effect=fake_call), patch.object(vids_ui.time, "sleep"), \
                patch.object(vids_ui, "set_zoom"), patch.object(vids_ui, "thumbs", side_effect=model.thumbs), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return helper(*args)

    def tools(self):
        return [tool for tool, _ in self.calls if tool != "vids_observe"]

    # --- add ---------------------------------------------------------------------------------------
    class Timeline:
        def __init__(self, scenes, insert_offset=1):
            self.scenes, self.selected, self.offset = list(scenes), 0, insert_offset

        def thumbs(self, n=None):
            vids_ui.STRIP_Y = 750
            return [(100 * i, 100 * i + 80) for i in range(len(self.scenes))]

        def nodes(self):
            n = len(self.scenes)
            out = [{"ref": f"s{i}", "role": "button", "name": f"Scene {i + 1} of {n}"} for i in range(n)]
            out += [{"ref": "new", "role": "button", "name": "New scene (Ctrl+M)"},
                    {"ref": "insert", "role": "menuitem", "name": "Insert"},
                    {"ref": "upload", "role": "menuitem", "name": "Upload u"}]
            names = self.scenes[self.selected]
            out += [{"ref": f"m{j}", "role": "StaticText", "name": m} for j, m in enumerate(names)]
            if not names:
                out.append({"ref": "empty", "role": "StaticText", "name": "This scene has no objects."})
            return out

        def act(self, tool, params):
            if tool == "vids_click" and "x" in params:
                self.selected = int(params["x"] // 100)
            elif tool == "vids_click" and params.get("nodeRef") == "new":
                at = self.selected + self.offset   # offset 0 models a new scene landing before the selected one
                self.scenes.insert(at, [])
                self.selected = at
            elif tool == "vids_upload_via_picker":
                self.scenes[self.selected] = [Path(params["files"][0]).name]

    def test_add_appends_after_the_last_scene(self):
        model = self.Timeline([["A.mp4"], ["B.mp4"]])
        self.run_helper(model, vids_ui.add_scene, "/tmp/new.mp4")
        self.assertEqual(model.scenes, [["A.mp4"], ["B.mp4"], ["new.mp4"]])

    def test_add_stops_when_the_new_scene_lands_mid_timeline(self):
        model = self.Timeline([["A.mp4"], ["B.mp4"]], insert_offset=0)
        with self.assertRaises(SystemExit):
            self.run_helper(model, vids_ui.add_scene, "/tmp/new.mp4")
        self.assertNotIn("vids_upload_via_picker", self.tools())

    def test_add_refuses_when_the_last_scene_is_already_empty(self):
        model = self.Timeline([["A.mp4"], []])
        with self.assertRaises(SystemExit):
            self.run_helper(model, vids_ui.add_scene, "/tmp/new.mp4")
        self.assertNotIn("vids_upload_via_picker", self.tools())
        self.assertEqual(len(model.scenes), 2)

    # --- fullframe ---------------------------------------------------------------------------------
    class Geometry:
        def __init__(self, applies=True, aspect=16 / 9, **values):
            self.values = {"Width": "1808", "Height": "1017", "X": "32", "Y": "32", **values}
            self.applies, self.aspect = applies, aspect

        def thumbs(self, n=None):
            return []

        def nodes(self):
            return [{"ref": k, "role": "spinbutton", "name": k, "value": v} for k, v in self.values.items()]

        def act(self, tool, params):
            if tool == "vids_type_text" and self.applies:
                self.values[params["nodeRef"]] = params["text"]
                if params["nodeRef"] == "Width":
                    self.values["Height"] = str(round(float(params["text"]) / self.aspect))

    def test_full_frame_applies_and_verifies(self):
        model = self.Geometry()
        self.run_helper(model, vids_ui.full_frame)
        self.assertEqual(model.values, {"Width": "1920", "Height": "1080", "X": "0", "Y": "0"})

    def test_full_frame_leaves_correct_geometry_untouched(self):
        model = self.Geometry(Width="1920", Height="1080", X="0", Y="0")
        self.run_helper(model, vids_ui.full_frame)
        self.assertEqual(self.tools(), [])

    def test_full_frame_stops_when_input_did_not_apply(self):
        with self.assertRaises(SystemExit):
            self.run_helper(self.Geometry(applies=False), vids_ui.full_frame)

    def test_full_frame_stops_on_other_proportions(self):
        with self.assertRaises(SystemExit):
            self.run_helper(self.Geometry(aspect=4 / 3), vids_ui.full_frame)

    # --- transition --------------------------------------------------------------------------------
    class Boundary:
        def __init__(self, current="Push", duration="0.6", applies=True):
            self.current, self.duration, self.applies, self.chosen = current, duration, applies, None

        def thumbs(self, n=None):
            return []

        def nodes(self):
            label = "Add transition" if self.current == "None" else self.current
            out = [{"ref": "b", "role": "button", "name": f"{label} between scene 4 and 5"}]
            out += [{"ref": kind, "role": "radio", "name": kind, "states": {"checked": str(kind == self.current).lower()}}
                    for kind in ("None", "Dissolve", "Push")]
            if self.current != "None":
                out.append({"ref": "d", "role": "spinbutton", "name": "Transition duration in seconds", "value": self.duration})
            return out

        def act(self, tool, params):
            if tool == "vids_click" and params.get("nodeRef") in ("None", "Dissolve", "Push") and self.applies:
                self.current = params["nodeRef"]
            elif tool == "vids_type_text" and params.get("nodeRef") == "d":
                self.duration = params["text"]

    def test_transition_sets_type_and_duration(self):
        model = self.Boundary(current="None", duration="1.5")
        self.run_helper(model, vids_ui.transition, 4, "Dissolve", 0.6)
        self.assertEqual((model.current, model.duration), ("Dissolve", "0.6"))

    def test_transition_stops_when_the_type_did_not_change(self):
        with self.assertRaises(SystemExit):
            self.run_helper(self.Boundary(current="Push", applies=False), vids_ui.transition, 4, "Dissolve", 0.6)

    def test_transition_none_removes_without_a_duration_field(self):
        model = self.Boundary(current="Push")
        self.run_helper(model, vids_ui.transition, 4, "None")
        self.assertEqual(model.current, "None")
        self.assertNotIn("vids_type_text", self.tools())


if __name__ == "__main__":
    unittest.main()
