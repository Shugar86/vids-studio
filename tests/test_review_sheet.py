"""Contact-sheet integration tests: source PTS, guide geometry, and write safety."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
PROFILE = json.loads((ROOT / 'profile.json').read_text())
SCRIPT = ROOT / 'skill' / PROFILE['skillName'] / 'scripts/review_sheet.py'
spec = importlib.util.spec_from_file_location("review_sheet", SCRIPT)
review_sheet = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review_sheet)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "Existing ffmpeg/ffprobe required")
class ReviewSheetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            review_sheet.font_path(None)
        except ValueError as error:
            raise unittest.SkipTest(str(error)) from error

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="vids-review-sheet-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-v", "error", "-n",
                        "-f", "lavfi", "-i", "color=c=0x202020:s=160x120:r=7:d=2.1",
                        "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", str(self.source)], check=True)
        self.original_hash = hashlib.sha256(self.source.read_bytes()).hexdigest()

    def args(self, **overrides):
        values = dict(input=self.source, output_dir=self.root / "review", cuts="1.45",
                      safe_area="0.10,0.20,0.30,0.10", safe_area_label="Explicit test geometry", font=None)
        values.update(overrides)
        return argparse.Namespace(**values)

    def test_actual_pts_coverage_and_safe_area_pixels(self):
        report = review_sheet.build(self.args())
        self.assertEqual(report["status"], "complete")
        # 7 fps source: the first frame after target 0.5 s is 4/7 s, not 0.5 s.
        selected = next(frame for frame in report["frames"] if frame["source_frame_index"] == 4)
        self.assertAlmostEqual(selected["time_seconds"], 4 / 7, places=6)
        self.assertEqual(selected["label"], "00:00.571")
        self.assertNotEqual(selected["label"], "00:00.500")
        self.assertTrue(report["coverage"]["extraction_pts_verified"])
        self.assertEqual(report["coverage"]["last_time_seconds"], 2.0)
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), self.original_hash)
        saved = json.loads((self.root / "review/manifest.json").read_text())
        self.assertEqual(saved, report)
        self.assertTrue((self.root / "review/index.html").is_file())
        overview = next(group for group in report["groups"] if group["id"] == "overview")
        self.assertEqual(overview["frames"], [0, 4, 7, 11, 14])
        cut = next(group for group in report["groups"] if group["id"] == "cut-01")
        self.assertEqual(cut["requested_range"], [.95, 1.95])
        self.assertGreater(len(cut["frames"]), 2)
        opening = next(page for page in report["pages"] if page["group"] == "opening")
        page = next(page for page in report["pages"] if page["group"] == "overview")
        self.assertGreater(opening["image_size"][0], page["image_size"][0])
        # Verify guide coordinates in rendered pixels, independent of stored rectangle.
        image = self.root / "review" / page["file"]
        metadata = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(image)]))["streams"][0]
        pixels = subprocess.check_output(["ffmpeg", "-nostdin", "-v", "error", "-threads", "2", "-i", str(image),
                                          "-threads", "2", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
        def pixel(x, y):
            start = (y * metadata["width"] + x) * 3
            return tuple(pixels[start:start + 3])
        origin_x, origin_y = page["margin"], page["header_height"] + page["margin"]
        # Overview image 240x180: left .1 ->24, top .2 ->36, right .3 ->168, bottom .1 ->162.
        for x, y in ((24, 70), (100, 36), (167, 70), (100, 161)):
            r, g, b = pixel(origin_x + x, origin_y + y)
            self.assertGreater(r, 220)
            self.assertGreater(g, 220)
            self.assertLess(b, 35)
        for x, y in ((20, 70), (100, 32), (172, 70), (100, 166)):
            r, g, b = pixel(origin_x + x, origin_y + y)
            self.assertLess(max(r, g, b), 55)

    def test_existing_output_and_source_are_preserved(self):
        output = self.root / "review"
        output.mkdir()
        sentinel = output / "keep.txt"
        sentinel.write_text("user file")
        with self.assertRaisesRegex(ValueError, "already exists"):
            review_sheet.build(self.args())
        self.assertEqual(sentinel.read_text(), "user file")
        with self.assertRaisesRegex(ValueError, "already exists"):
            review_sheet.build(self.args(output_dir=self.source))
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), self.original_hash)

    def test_nonzero_source_pts_are_preserved_but_labels_are_video_relative(self):
        shifted = self.root / "shifted.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-v", "error", "-n", "-i", str(self.source),
                        "-c", "copy", "-output_ts_offset", "5", str(shifted)], check=True)
        report = review_sheet.build(self.args(input=shifted, cuts="", safe_area=None, safe_area_label=None))
        self.assertEqual(report["source_first_pts_seconds"], 5.0)
        self.assertEqual(report["frames"][0]["source_pts_seconds"], 5.0)
        self.assertEqual(report["frames"][0]["label"], "00:00.000")
        self.assertTrue(report["coverage"]["extraction_pts_verified"])

    def test_symlink_paths_are_refused_before_writing(self):
        alias = self.root / "alias.mp4"
        alias.symlink_to(self.source)
        with self.assertRaisesRegex(ValueError, "Symlink"):
            review_sheet.build(self.args(input=alias))
        real = self.root / "real"
        real.mkdir()
        linked_parent = self.root / "linked"
        linked_parent.symlink_to(real, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Symlink"):
            review_sheet.build(self.args(output_dir=linked_parent / "review"))
        self.assertEqual(list(real.iterdir()), [])

    def test_invalid_guides_cuts_and_resource_limits_make_no_output(self):
        for overrides in ({"safe_area_label": None}, {"safe_area": "0.6,0.1,0.6,0.1"},
                          {"safe_area": "nan,0,0,0"}, {"cuts": "nan"}, {"cuts": "3"}):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                review_sheet.build(self.args(**overrides))
            self.assertFalse((self.root / "review").exists())
        with mock.patch.object(review_sheet, "MAX_DURATION", 1), self.assertRaisesRegex(ValueError, "at most 1"):
            review_sheet.build(self.args())
        self.assertFalse((self.root / "review").exists())

    def test_local_playlist_cannot_fetch_network_segments(self):
        playlist = self.root / "network.m3u8"
        playlist.write_text("#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttps://127.0.0.1:1/segment.ts\n#EXT-X-ENDLIST\n")
        with self.assertRaisesRegex(ValueError, "not on whitelist"):
            review_sheet.build(self.args(input=playlist))
        self.assertFalse((self.root / "review").exists())


if __name__ == "__main__":
    unittest.main()
