import base64
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(os.environ.get("VIDS_TAKE_SCRIPT", str(Path(__file__).resolve().parents[1] / "scripts/take_manifest.py"))).resolve()
SPEC = importlib.util.spec_from_file_location("take_manifest", SCRIPT)
manifest = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(manifest)


class TakeManifestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            raise RuntimeError("Existing ffmpeg and ffprobe are required for the real media acceptance test")
        cls.media = tempfile.TemporaryDirectory()
        cls.eight = Path(cls.media.name) / "eight.mp4"
        cls.five = Path(cls.media.name) / "five.mp4"
        for path, duration, color in ((cls.eight, 8, "blue"), (cls.five, 5, "red")):
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"color=c={color}:s=32x32:r=1", "-t", str(duration), "-c:v", "mpeg4", "-an", str(path)], check=True, timeout=30)

    @classmethod
    def tearDownClass(cls):
        cls.media.cleanup()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.path = self.directory / "takes.json"
        self.evidence = self.directory / "проверка.txt"
        self.evidence.write_text("Observed source action and reviewed the exported clip.", encoding="utf-8")
        manifest.run(self.path, {"op": "init", "project_id": "episode-1"})

    def tearDown(self):
        self.temporary.cleanup()

    def read(self):
        return json.loads(self.path.read_text())

    def add_video(self, take_id, source, **extra):
        return manifest.run(self.path, {"op": "add_take", "take_id": take_id, "asset_id": "opening", "kind": "video", "source": str(source), "prompt_id": "prompt-v1", "reference_ids": ["hero-v2"], "action": {"start": "Герой смотрит в камеру", "end": "Герой отворачивается"}, "verdict": {"status": "accepted", "reason": "Action reviewed in the source clip", "evidence": [str(self.evidence)]}, **extra})

    def review(self, change, dependency, revision, status="verified", **extra):
        return manifest.run(self.path, {"op": "review", "change_id": change, "dependency": dependency, "timeline_revision": revision, "review": {"status": status, "reason": "Checked current export and actual Vids timing", "evidence": [str(self.evidence)], **extra}})

    def test_real_eight_to_five_second_replacement_keeps_old_source_and_invalidates_dependencies(self):
        original = self.directory / "mutable-source.mp4"
        shutil.copyfile(self.eight, original)
        self.add_video("old", original)
        self.add_video("new", self.five)
        manifest.run(self.path, {"op": "assign", "scene_id": "opening", "take_id": "old", "reason": "Initial scene"})
        manifest.run(self.path, {"op": "assign", "scene_id": "next", "take_id": "new", "reason": "Following scene"})
        before = self.read()
        archived_old = Path(before["takes"]["old"]["archive_path"])
        self.assertEqual(before["takes"]["old"]["duration_seconds"], 8.0)
        self.assertEqual(before["scenes"][1]["planned_start_seconds"], 8.0)
        # Replacing the original file cannot destroy the retained old take.
        shutil.copyfile(self.five, original)
        outcome = manifest.run(self.path, {"op": "replace", "scene_id": "opening", "take_id": "new", "reason": "Use the tighter 5-second action"})
        after = self.read()
        self.assertEqual(manifest.digest(archived_old), before["takes"]["old"]["sha256"])
        self.assertEqual(after["takes"]["old"], before["takes"]["old"])
        self.assertEqual(after["scenes"][0]["duration_seconds"], 5.0)
        self.assertEqual(after["scenes"][1]["planned_start_seconds"], 5.0)
        self.assertEqual(after["changes"][-1]["from"]["take_id"], "old")
        self.assertEqual(after["changes"][-1]["duration_delta_seconds"], -3.0)
        current = outcome["current_changes"]["opening"]
        opening_checks = [item for item in outcome["unresolved_reviews"] if item["change_id"] == current]
        self.assertEqual({item["dependency"] for item in opening_checks}, set(manifest.DEPENDENCIES))
        self.assertTrue(all(item["status"] == "unresolved" for item in opening_checks))
        self.assertFalse(outcome["dependency_review_complete"])
        self.assertFalse(outcome["vids_timeline_modified_by_helper"])
        # Restore the old take without touching the overwritten original.
        restored = manifest.run(self.path, {"op": "replace", "scene_id": "opening", "take_id": "old", "reason": "Restore retained old take"})
        self.assertEqual(restored["planned_timeline"][0]["duration_seconds"], 8.0)

    def test_checks_require_evidence_or_explicit_not_applicable_reason(self):
        self.add_video("old", self.eight)
        assigned = manifest.run(self.path, {"op": "assign", "scene_id": "opening", "take_id": "old", "reason": "Initial scene"})
        change, revision = assigned["current_changes"]["opening"], assigned["timeline_revision"]
        before = self.path.read_bytes()
        for review in ({"status": "verified", "reason": "Looks right", "evidence": []}, {"status": "not_applicable", "reason": "", "evidence": []}):
            with self.assertRaises(ValueError):
                manifest.run(self.path, {"op": "review", "change_id": change, "dependency": "voice", "timeline_revision": revision, "review": review})
        self.assertEqual(self.path.read_bytes(), before)
        for dependency in manifest.DEPENDENCIES:
            if dependency in ("timing", "neighbors"):
                outcome = self.review(change, dependency, revision)
            else:
                outcome = self.review(change, dependency, revision, status="not_applicable", reason=f"This silent test project has no {dependency} track", evidence=[])
        self.assertTrue(outcome["dependency_review_complete"])
        self.assertFalse(outcome["vids_timeline_modified_by_helper"])

    def test_new_timeline_revision_invalidates_old_checks_and_carries_open_issue(self):
        self.add_video("old", self.eight)
        self.add_video("new", self.five)
        assigned = manifest.run(self.path, {"op": "assign", "scene_id": "opening", "take_id": "old", "reason": "Initial scene"})
        old_change = assigned["current_changes"]["opening"]
        self.review(old_change, "voice", 1, status="failed", reason="The first word is clipped")
        self.review(old_change, "timing", 1)
        replaced = manifest.run(self.path, {"op": "replace", "scene_id": "opening", "take_id": "new", "reason": "Shorter source"})
        voice = next(item for item in replaced["unresolved_reviews"] if item["dependency"] == "voice")
        self.assertEqual(voice["reason"], "The first word is clipped")
        self.assertEqual(voice["status"], "unresolved")
        with self.assertRaisesRegex(ValueError, "superseded"):
            self.review(old_change, "voice", 2)
        with self.assertRaisesRegex(ValueError, "stale"):
            self.review(replaced["current_changes"]["opening"], "voice", 1)
        current = self.read()["changes"][-1]
        self.assertEqual(current["reviews"]["voice"]["carried_from_change"], old_change)
        self.assertEqual(self.read()["changes"][0]["reviews"]["voice"]["status"], "failed")

    def test_invalid_range_duplicate_take_and_changed_archive_do_not_modify_manifest(self):
        self.add_video("old", self.eight)
        before = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, "immutable"):
            self.add_video("old", self.five)
        with self.assertRaises(ValueError):
            self.add_video("bad", self.five, source_range={"start": 0, "end": 8})
        self.assertEqual(self.path.read_bytes(), before)
        archived = Path(self.read()["takes"]["old"]["archive_path"])
        archived.write_bytes(b"corrupted")
        with self.assertRaisesRegex(ValueError, "missing or changed"):
            manifest.run(self.path, {"op": "assign", "scene_id": "opening", "take_id": "old", "reason": "Initial scene"})
        self.assertEqual(self.path.read_bytes(), before)

    def test_atomic_write_failure_preserves_the_previous_manifest(self):
        before = self.path.read_bytes()
        self.add_video("unassigned", self.eight)
        before = self.path.read_bytes()
        with patch.object(manifest.os, "replace", side_effect=OSError("simulated failure")):
            with self.assertRaises(OSError):
                manifest.run(self.path, {"op": "assign", "scene_id": "opening", "take_id": "unassigned", "reason": "Initial scene"})
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(list(self.directory.glob(".manifest-*")), [])

    def test_concurrent_cli_additions_do_not_lose_a_take(self):
        image = self.directory / "pixel.png"
        image.write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl9Wm0AAAAASUVORK5CYII="))
        processes = []
        for index in range(2):
            request = {"op": "add_take", "take_id": f"image-{index}", "asset_id": "hero", "kind": "image", "source": str(image), "reference_version": f"v{index}"}
            process = subprocess.Popen([sys.executable, str(SCRIPT), str(self.path)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            process.stdin.write(json.dumps(request))
            process.stdin.close()
            processes.append(process)
        for process in processes:
            self.assertEqual(process.wait(timeout=10), 0, process.stderr.read())
            self.assertTrue(json.loads(process.stdout.read())["ok"])
            process.stdout.close()
            process.stderr.close()
        self.assertEqual(set(self.read()["takes"]), {"image-0", "image-1"})
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_nonfinite_duplicate_json_and_unreviewed_assignments_are_rejected(self):
        for raw in ('{"op":"status","op":"init"}', '{"number": NaN}'):
            with self.assertRaises(ValueError):
                manifest.parse_json(raw)
        self.add_video("unreviewed", self.eight, verdict={"status": "unreviewed", "reason": "Awaiting motion review", "evidence": []})
        with self.assertRaisesRegex(ValueError, "accepted"):
            manifest.run(self.path, {"op": "assign", "scene_id": "opening", "take_id": "unreviewed", "reason": "Initial scene"})

    def test_selected_source_range_defines_duration_without_reencoding(self):
        self.add_video("trimmed", self.eight, source_range={"start": 1.5, "end": 6.5})
        assigned = manifest.run(self.path, {"op": "assign", "scene_id": "opening", "take_id": "trimmed", "reason": "Use the complete action range"})
        self.assertEqual(assigned["planned_timeline"][0]["duration_seconds"], 5.0)
        self.assertEqual(self.read()["takes"]["trimmed"]["duration_seconds"], 8.0)
        self.assertEqual(manifest.digest(Path(self.read()["takes"]["trimmed"]["archive_path"])), manifest.digest(self.eight))


if __name__ == "__main__":
    unittest.main()
