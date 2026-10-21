"""qa_export must find planted defects in a synthetic clip: python3 -m unittest discover -s tests"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/qa_export.py"


class QaExportFindsPlantedDefects(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        srt = root / "subs.srt"
        srt.write_text("1\n00:00:01,000 --> 00:00:04,000\nПроверка\n", encoding="utf-8")
        cls.video = root / "planted.mp4"
        # 0–4 s moving, 4–6 s frozen, 6–12 s moving; sound 1–5 s and 7–10 s only.
        subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error",
            "-f", "lavfi", "-i", "testsrc2=s=540x960:r=30:d=4",
            "-f", "lavfi", "-i", "color=c=0x334455:s=540x960:r=30:d=2",
            "-f", "lavfi", "-i", "testsrc2=s=540x960:r=30:d=6",
            "-f", "lavfi", "-i", "aevalsrc='if(between(t,1,5)+between(t,7,10),0.3*sin(2*PI*220*t),0)':s=44100:d=12",
            "-i", str(srt),
            "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
            "-map", "[v]", "-map", "3:a", "-map", "4:s", "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-c:s", "mov_text", str(cls.video)], check=True)
        cls.out = root / "qa"
        subprocess.run([sys.executable, "-I", str(SCRIPT), str(cls.video), "--out", str(cls.out)],
                       check=True, capture_output=True, text=True)
        cls.report = json.loads((cls.out / "report.json").read_text(encoding="utf-8"))
        cls.text = " ".join(f["what"] for f in cls.report["findings"])

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_late_start_tail_and_pause(self):
        self.assertIn("Звук начинается только через", self.text)
        self.assertIn("Хвост без звука", self.text)
        self.assertTrue(any(4.6 < p["start"] < 5.6 and 6.4 < p["end"] < 7.4 for p in self.report["pauses"]))

    def test_frozen_silent_picture_is_a_dead_moment(self):
        self.assertTrue(any(f["start"] < 4.5 and f["end"] > 5.5 for f in self.report["frozen"]))
        self.assertIn("мёртвый момент", self.text)

    def test_cuts_and_soft_subtitles(self):
        self.assertTrue(any(abs(t - 4) < 0.2 for t in self.report["cuts_seconds"]))
        self.assertTrue(any(abs(t - 6) < 0.2 for t in self.report["cuts_seconds"]))
        self.assertIn("Субтитры только дорожкой", self.text)

    def test_sheets_exist_and_input_untouched(self):
        for name in self.report["sheets"]:
            self.assertTrue((self.out / name).stat().st_size > 0, name)
        self.assertTrue(any("transition_" in s for s in self.report["sheets"]))
        self.assertTrue(any("safezones_" in s for s in self.report["sheets"]))

    def test_refuses_non_empty_output(self):
        result = subprocess.run([sys.executable, "-I", str(SCRIPT), str(self.video), "--out", str(self.out)],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
