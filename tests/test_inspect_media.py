"""Real FFmpeg fixtures verify measurements, warnings and source protection."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
PROFILE = json.loads((ROOT / 'profile.json').read_text())
SCRIPT = ROOT / 'skill' / PROFILE['skillName'] / 'scripts/inspect_media.py'
SPEC = importlib.util.spec_from_file_location("inspect_media", SCRIPT)
media = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(media)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "existing ffmpeg/ffprobe required")
class MediaInspectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        cls.root = Path(cls.temp.name)
        cls.fixture = cls.root / "pauses-and-cuts.mkv"
        # Known physical signal: 997 Hz tone, two windows; exact black/white cut at 2 s.
        cls.ffmpeg("-f", "lavfi", "-i", r"color=c=white:s=160x90:r=10:d=4,drawbox=color=black:t=fill:enable=lt(t\,2)",
                   "-f", "lavfi", "-i", r"aevalsrc=if(between(t\,0.5\,1.3)+between(t\,2.2\,3.1)\,0.05*sin(2*PI*997*t)\,0):d=4:s=48000",
                   "-c:v", "ffv1", "-c:a", "pcm_f32le", str(cls.fixture))
        cls.original = hashlib.sha256(cls.fixture.read_bytes()).hexdigest()
        cls.silence = cls.root / "silence.wav"
        cls.ffmpeg("-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=1", "-c:a", "pcm_f32le", str(cls.silence))
        cls.intersample = cls.root / "intersample.wav"
        cls.ffmpeg("-f", "lavfi", "-i", "aevalsrc=0.8*sin(2*PI*12000*t+PI/4):s=48000:d=1", "-c:a", "pcm_f32le", str(cls.intersample))

    @staticmethod
    def ffmpeg(*args):
        subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-filter_threads", "1", "-threads", "2", *args[:-1],
                        "-threads", "2", args[-1]], check=True, capture_output=True, text=True)

    def inspect(self, source=None, *args):
        output = self.root / (self.id().rsplit(".", 1)[-1] + ".json")
        result = subprocess.run([sys.executable, str(SCRIPT), str(source or self.fixture), "--output", str(output), *args], text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        # strict parser rejects JSON NaN/Infinity even for a completely silent file.
        report = json.loads(output.read_text(), parse_constant=lambda value: self.fail(f"Invalid JSON number: {value}"))
        self.assertEqual(json.loads(result.stdout), report)
        return report

    def test_flags_timed_silence_low_loudness_freezes_and_cut(self):
        report = self.inspect(None, "--target-lufs", "-14", "--pause-windows", "0:0.4,0.6:1.1")
        self.assertTrue(report["decode_ok"])
        self.assertTrue(report["signal_analysis_ok"])
        self.assertLess(report["loudness"]["integrated_lufs"], -25)
        self.assertAlmostEqual(float(report["sample_levels"]["Overall"]["Peak level dB"]), -26.02, delta=0.03)
        # The abrupt tone edges may overshoot after true-peak reconstruction.
        self.assertGreater(report["loudness"]["true_peak_dbtp"], -27)
        self.assertLess(report["loudness"]["true_peak_dbtp"], -24)
        observations = {item["code"]: item for item in report["observations"]}
        self.assertIn("loudness_below_target", observations)
        for code, start, end in [("opening_amplitude_silence", 0, 0.5),
                                 ("internal_amplitude_silence", 1.3, 2.2),
                                 ("tail_amplitude_silence", 3.1, 4)]:
            self.assertAlmostEqual(observations[code]["start_seconds"], start, delta=0.002)
            self.assertAlmostEqual(observations[code]["end_seconds"], end, delta=0.002)
        visual = report["visual_analysis"]
        self.assertTrue(visual["analysis_ok"])
        self.assertEqual([item["time_seconds"] for item in visual["cut_candidates"]], [2.0])
        self.assertEqual([item["duration_seconds"] for item in visual["segment_lengths"]], [2.0, 2.0])
        self.assertEqual([item["duration_seconds"] for item in visual["low_change_intervals"]], [2.0, 2.0])
        self.assertIsNone(report["pause_window_mix_levels"][0]["mix_rms_dbfs"])
        self.assertAlmostEqual(report["pause_window_mix_levels"][1]["mix_rms_dbfs"], -29.03, delta=0.03)
        self.assertNotIn("music_level", report)
        self.assertEqual(report["sha256"], self.original)
        self.assertEqual(hashlib.sha256(self.fixture.read_bytes()).hexdigest(), self.original)

    def test_no_implicit_loudness_target_and_configurable_thresholds(self):
        report = self.inspect(None, "--start-silence", "0.6", "--internal-silence", "1", "--tail-silence", "1",
                              "--freeze-minimum", "3", "--cut-threshold", "99")
        self.assertIsNone(report["loudness"]["target_lufs"])
        codes = {item["code"] for item in report["observations"]}
        self.assertEqual(codes, {"subtitle_visibility_unverified"})
        self.assertEqual(report["visual_analysis"]["cut_candidates"], [])

    def test_true_peak_is_not_the_sample_peak(self):
        report = self.inspect(self.intersample)
        sample_peak = float(report["sample_levels"]["Overall"]["Peak level dB"])
        true_peak = report["loudness"]["true_peak_dbtp"]
        self.assertAlmostEqual(sample_peak, -4.9485, delta=0.03)
        self.assertGreater(true_peak - sample_peak, 1.5)
        self.assertFalse(report["visual_analysis"]["available"])

    def test_silence_produces_valid_json_and_unknown_burned_in_captions(self):
        report = self.inspect(self.silence)
        self.assertIsNone(report["loudness"]["true_peak_dbtp"])
        self.assertTrue(report["loudness"]["integrated_at_meter_floor"])
        self.assertEqual(report["sample_levels"]["Overall"]["Peak level dB"], "-inf")
        self.assertFalse(report["subtitles"]["soft_streams_present"])
        self.assertEqual(report["subtitles"]["burned_in"], "unknown")

    def test_explicit_cuts_override_segment_boundaries_not_detection(self):
        report = self.inspect(None, "--cuts", "1,3")
        visual = report["visual_analysis"]
        self.assertEqual(visual["segment_boundary_source"], "caller_supplied_edit_times")
        self.assertEqual([item["duration_seconds"] for item in visual["segment_lengths"]], [1.0, 2.0, 1.0])
        self.assertEqual([item["time_seconds"] for item in visual["cut_candidates"]], [2.0])

    def test_soft_subtitles_do_not_establish_absence_of_burned_in_captions(self):
        captions = self.root / "captions.srt"
        captions.write_text("1\n00:00:00,000 --> 00:00:02,000\nExample caption\n", encoding="utf-8")
        subtitled = self.root / "subtitled.mkv"
        self.ffmpeg("-i", str(self.fixture), "-i", str(captions), "-map", "0", "-map", "1", "-c", "copy", str(subtitled))
        report = self.inspect(subtitled)
        self.assertTrue(report["subtitles"]["soft_streams_present"])
        self.assertEqual(report["subtitles"]["burned_in"], "unknown")
        notice = next(item for item in report["observations"] if item["code"] == "subtitle_visibility_unverified")
        self.assertIn("burned-in captions are unknown", notice["note"])
        self.assertNotIn("only soft", notice["note"])

    def test_guards_sources_existing_files_and_nonfinite_arguments(self):
        link = self.root / "source-hardlink.mkv"
        os.link(self.fixture, link)
        symbolic = self.root / "source-symlink.mkv"
        symbolic.symlink_to(self.fixture)
        existing = self.root / "keep.json"
        existing.write_text("keep me", encoding="utf-8")
        for output in [self.fixture, link, symbolic, existing]:
            with self.subTest(output=output):
                result = subprocess.run([sys.executable, str(SCRIPT), str(self.fixture), "--output", str(output)], text=True, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
        for flags in [("--target-lufs", "nan"), ("--freeze-noise", "2"), ("--cuts", "3,2"),
                      ("--cuts", "4"), ("--pause-windows", "3:5"), ("--pause-windows", "0:2,1:3")]:
            with self.subTest(flags=flags):
                destination = self.root / "invalid.json"
                result = subprocess.run([sys.executable, str(SCRIPT), str(self.fixture), "--output", str(destination), *flags], text=True, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(destination.exists())
        self.assertEqual(existing.read_text(), "keep me")
        self.assertEqual(hashlib.sha256(self.fixture.read_bytes()).hexdigest(), self.original)

    def test_decode_error_is_reported_and_causes_nonzero_exit(self):
        # Inject only a failed decoder receipt; all analysis runs use the real fixture.
        # This isolates exit handling from container-specific corruption recovery.
        output = self.root / "failed-decode.json"
        original_run = media.run_ffmpeg
        def decoder_error(executable, source, *options, level="info"):
            if level == "error":
                return subprocess.CompletedProcess([], 1, "", "Error while decoding stream #0:0")
            return original_run(executable, source, *options, level=level)
        with mock.patch.object(sys, "argv", [str(SCRIPT), str(self.fixture), "--output", str(output)]), \
                mock.patch.object(media, "run_ffmpeg", side_effect=decoder_error), \
                mock.patch("builtins.print"):
            self.assertEqual(media.main(), 1)
        report = json.loads(output.read_text())
        self.assertFalse(report["decode_ok"])
        self.assertIn("Error while decoding", report["decode_diagnostics"])


if __name__ == "__main__":
    unittest.main()
