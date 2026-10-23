"""Real private native permits; no user's registry, browser or media is used."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "skill" / Path(__file__).resolve().parents[1].name / "scripts/media_guard.py"
if "vids_media_guard" not in sys.modules:
    SPEC = importlib.util.spec_from_file_location("vids_media_guard", SCRIPT)
    MODULE = importlib.util.module_from_spec(SPEC)
    sys.modules[SPEC.name] = MODULE
    SPEC.loader.exec_module(MODULE)
guard_module = sys.modules["vids_media_guard"]
PLATFORM_SPEC = importlib.util.spec_from_file_location("vids_media_guard_platform_fixture", ROOT / "tests/platform_smoke.py")
platform_fixture = importlib.util.module_from_spec(PLATFORM_SPEC)
PLATFORM_SPEC.loader.exec_module(platform_fixture)


class MediaGuardTests(unittest.TestCase):
    def setUp(self):
        # Match the native platform suite: canonical paths avoid macOS /var
        # aliases, and Windows fixtures need an explicit owner SID/private ACL
        # rather than the elevated runner's inherited tempfile permissions.
        self.path = self.enterContext(platform_fixture.private_temporary_directory(Path.home().resolve()))
        self.env = {**os.environ, "VIDS_STUDIO_FLEET_DIR": str(self.path / "fleet"),
                    "VIDS_STUDIO_MEDIA_BUDGET_DIR": str(self.path / "media")}
        policy = subprocess.run([sys.executable, str(ROOT / "native/fleet.py"), "policy", "--max-concurrency", "1", "--json"],
                                env=self.env, text=True, encoding="utf-8", errors="replace", capture_output=True)
        self.assertEqual(policy.returncode, 0, f"Private fleet fixture initialization failed.\nstdout:\n{policy.stdout}\nstderr:\n{policy.stderr}")

    def markers(self):
        return list((self.path / "media").glob("slot-*.json"))

    def test_five_independent_helpers_share_one_native_permit(self):
        log = self.path / "events.jsonl"
        work = "import json,sys,time; from pathlib import Path; p=Path(sys.argv[1]); p.open('a').write(json.dumps(['start',time.time()])+'\\n'); time.sleep(.08); p.open('a').write(json.dumps(['end',time.time()])+'\\n')"
        owner = ("import sys; sys.path.insert(0,sys.argv[1]); from media_guard import media_budget; "
                 "g=media_budget('fixture',wait_seconds=10); "
                 "\nwith g as guard: guard.run([sys.executable,'-c',sys.argv[2],sys.argv[3]],check=True)\n")
        children = [subprocess.Popen([sys.executable, "-I", "-c", owner, str(SCRIPT.parent), work, str(log)],
                                     env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(5)]
        try:
            for child in children:
                _, err = child.communicate(timeout=20)
                self.assertEqual(child.returncode, 0, err)
        finally:
            for child in children:
                if child.poll() is None:
                    child.kill()
                    child.wait()
        active = maximum = 0
        for event, _ in sorted((json.loads(line) for line in log.read_text().splitlines()), key=lambda row: row[1]):
            active += 1 if event == "start" else -1
            maximum = max(maximum, active)
        self.assertEqual(maximum, 1)
        self.assertEqual(active, 0)
        self.assertEqual(self.markers(), [])

    def test_timeout_confirms_child_exit_before_releasing_permit(self):
        original = subprocess.Popen
        children = []
        def spawn(*args, **kwargs):
            child = original(*args, **kwargs)
            children.append(child)
            return child
        with mock.patch.object(guard_module.subprocess, "Popen", side_effect=spawn):
            with guard_module.media_budget("timeout", env=self.env) as guard:
                with self.assertRaises(subprocess.TimeoutExpired):
                    guard.run([sys.executable, "-c", "import time;time.sleep(30)"], timeout=.1, capture_output=True)
                self.assertIsNotNone(children[-1].poll())
                self.assertEqual(len(self.markers()), 1)
        self.assertEqual(self.markers(), [])

    def test_keyboard_interrupt_confirms_child_exit_before_release(self):
        original = subprocess.Popen
        children = []
        def spawn(args, **kwargs):
            child = original(args, **kwargs)
            if "-c" in args:
                child.communicate = mock.Mock(side_effect=KeyboardInterrupt)
                children.append(child)
            return child
        with mock.patch.object(guard_module.subprocess, "Popen", side_effect=spawn):
            with guard_module.media_budget("interrupt", env=self.env) as guard:
                with self.assertRaises(KeyboardInterrupt):
                    guard.run([sys.executable, "-c", "import time;time.sleep(30)"], capture_output=True)
                self.assertIsNotNone(children[-1].poll())
                self.assertEqual(len(self.markers()), 1)
        self.assertEqual(self.markers(), [])

    def test_keeper_loss_during_work_stops_media_and_retains_marker(self):
        original = subprocess.Popen
        children = []
        def spawn(*args, **kwargs):
            child = original(*args, **kwargs)
            children.append(child)
            return child
        with mock.patch.object(guard_module.subprocess, "Popen", side_effect=spawn):
            with self.assertRaises(guard_module.MediaBudgetError) as caught:
                with guard_module.media_budget("keeper-loss", env=self.env) as guard:
                    timer = threading.Timer(.15, guard.keeper.kill)
                    timer.start()
                    try:
                        guard.run([sys.executable, "-c", "import time;time.sleep(30)"], capture_output=True)
                    finally:
                        timer.join()
        self.assertEqual(caught.exception.code, "MEDIA_BUDGET_LOST")
        self.assertIsNotNone(children[-1].poll())
        self.assertEqual(len(self.markers()), 1)

    def test_interrupted_process_creation_retains_unconfirmed_permit(self):
        with self.assertRaises(KeyboardInterrupt):
            with guard_module.media_budget("spawn-interrupt", env=self.env) as guard:
                with mock.patch.object(guard_module.subprocess, "Popen", side_effect=KeyboardInterrupt):
                    guard.run([sys.executable, "-c", "pass"])
        self.assertEqual(len(self.markers()), 1)

    def test_keeper_loss_after_last_command_cannot_report_success(self):
        with self.assertRaises(guard_module.MediaBudgetError) as caught:
            with guard_module.media_budget("late-loss", env=self.env) as guard:
                result = guard.run([sys.executable, "-c", "print('done')"], capture_output=True, text=True, check=True)
                self.assertEqual(result.stdout.strip(), "done")
                guard.keeper.kill()
                guard.keeper.wait()
        self.assertEqual(caught.exception.code, "MEDIA_BUDGET_LOST")
        self.assertEqual(len(self.markers()), 1)

    def test_nested_admission_is_rejected_without_leaking_outer_lease(self):
        with guard_module.media_budget("outer", env=self.env):
            with self.assertRaisesRegex(ValueError, "nested"):
                with guard_module.media_budget("inner", env=self.env):
                    self.fail("Nested work must not run")
            self.assertEqual(len(self.markers()), 1)
        self.assertEqual(self.markers(), [])

    def test_tool_override_requires_absolute_installed_executable(self):
        with mock.patch.dict(os.environ, {"VIDS_STUDIO_FFMPEG": "relative/ffmpeg"}):
            with self.assertRaisesRegex(ValueError, "absolute"):
                guard_module.media_tool("ffmpeg")
        with mock.patch.dict(os.environ, {"VIDS_STUDIO_FFMPEG": sys.executable}):
            self.assertEqual(guard_module.media_tool("ffmpeg"), sys.executable)


if __name__ == "__main__":
    unittest.main()
