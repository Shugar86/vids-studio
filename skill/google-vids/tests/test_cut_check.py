"""Synthetic cut/flash fixtures; no private video or live browser."""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/cut_check.py"
SPEC = importlib.util.spec_from_file_location("vids_cut_check", SCRIPT)
CUT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CUT)
ROOT = SCRIPT.parents[3]


class CutAlgorithms(unittest.TestCase):
    def test_one_detected_cut_does_not_satisfy_two_plan_entries(self):
        rows, extra = CUT.compare([10, 12], [{"frame": 11}])
        self.assertEqual(rows, [{"plan": 10, "actual": 11, "delta": 1}, {"plan": 12, "actual": None, "delta": None}])
        self.assertEqual(extra, [])

    def test_empty_video_and_full_caption_band_fail_clearly(self):
        for frames, band in (([], (0, 1)), ([bytes(4)], (0, 2))):
            with self.assertRaisesRegex(ValueError, "No decoded pixels"):
                CUT.detect(frames, 2, band)

    def test_caption_decoder_rejects_missing_frames_instead_of_relabeling(self):
        guard = mock.Mock()
        guard.run.return_value.stdout = b""
        with mock.patch.object(CUT, "media_tool", return_value="ffmpeg"):
            with self.assertRaisesRegex(ValueError, "exactly the requested"):
                CUT.band_frames(Path("local.mp4"), [10, 12], 100, 100, (70, 90), guard)

    def test_variable_rate_metadata_is_not_given_frame_times(self):
        guard = mock.Mock()
        guard.run.return_value.stdout = json.dumps({"streams": [{"width": 100, "height": 100, "r_frame_rate": "30/1", "avg_frame_rate": "25/1"}], "format": {"duration": "10"}})
        with mock.patch.object(CUT, "media_tool", return_value="ffprobe"):
            with self.assertRaisesRegex(ValueError, "Variable"):
                CUT.probe(Path("local.mp4"), guard)

    def test_frame_limit_rejects_overlong_decode(self):
        guard = mock.Mock()
        guard.run.return_value.stdout = bytes(4 * 5)
        with mock.patch.object(CUT, "media_tool", return_value="ffmpeg"), mock.patch.object(CUT, "MAX_FRAMES", 4):
            with self.assertRaisesRegex(ValueError, "18,000"):
                CUT.decode_gray(Path("local.mp4"), 2, 2, guard)


@unittest.skipUnless(CUT.Image is not None and shutil.which("ffmpeg") and shutil.which("ffprobe"), "Existing Pillow and FFmpeg are required for synthetic sheet acceptance")
class CutCheckFindsPlantedCuts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.tmp.cleanup)
        root = Path(cls.tmp.name)
        cls.env = {**os.environ, "VIDS_STUDIO_FLEET_DIR": str(root / "fleet"), "VIDS_STUDIO_MEDIA_BUDGET_DIR": str(root / "media")}
        cls.video = root / "planted.mp4"
        subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-threads", "2", "-filter_complex_threads", "2",
            "-f", "lavfi", "-i", "testsrc2=s=270x480:r=30:d=2",
            "-f", "lavfi", "-i", "color=c=0xaa2222:s=270x480:r=30:d=1",
            "-f", "lavfi", "-i", "color=c=white:s=270x480:r=30:d=0.0334",
            "-f", "lavfi", "-i", "mandelbrot=s=270x480:r=30",
            "-filter_complex", "[3:v]trim=end_frame=30,setpts=PTS-STARTPTS[m];[0:v][1:v][2:v][m]concat=n=4:v=1:a=0,format=yuv420p[v]",
            "-map", "[v]", "-c:v", "libx264", "-threads", "2", "-crf", "12", str(cls.video)], check=True)
        cls.out = root / "qa"
        run = cls.call("--out", str(cls.out), "--plan", "60,91", "--around", "2.0")
        if run.returncode:
            raise AssertionError(run.stderr)
        cls.report = json.loads((cls.out / "report.json").read_text(encoding="utf-8"))

    @classmethod
    def call(cls, *args):
        return subprocess.run([sys.executable, "-I", str(SCRIPT), str(cls.video), *args], capture_output=True, text=True, env=cls.env, timeout=60)

    def test_cut_on_exact_frame(self):
        self.assertIn(60, [c["frame"] for c in self.report["cuts"]])
        self.assertEqual(self.report["plan"][0], {"plan": 60, "actual": 60, "delta": 0})
        self.assertIn("Heuristic", self.report["assessment"])
        self.assertIn("not proof", self.report["timeBasis"])

    def test_white_flash_reported(self):
        whites = [f for f in self.report["flashes"] if f["kind"] == "white"]
        self.assertEqual(len(whites), 1)
        self.assertEqual(whites[0]["from"], 90)

    def test_sheets_written_and_lease_released(self):
        for name in ("cuts.png", "onsets.png"):
            self.assertTrue((self.out / name).stat().st_size > 0)
        self.assertEqual(list((Path(self.tmp.name) / "media").glob("slot-*.json")), [])

    def test_refuses_non_empty_out(self):
        self.assertNotEqual(self.call("--out", str(self.out)).returncode, 0)

    def test_invalid_band_and_nonfinite_points_do_not_decode(self):
        for args in (("--band", "0.9:0.2"), ("--plan", "nan"), ("--span", "500")):
            result = self.call("--out", str(Path(self.tmp.name) / "invalid"), *args)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((Path(self.tmp.name) / "invalid").exists())


if __name__ == "__main__":
    unittest.main()
