"""QA and blind ASR share admission for each workflow and never bypass a rejected lease."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def load(name):
    spec = importlib.util.spec_from_file_location("media_test_" + name, SCRIPTS / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


qa = load("qa_export")
asr = load("asr_blind")


class RecordingGuard:
    def __init__(self, callback, admission_error=None):
        self.callback, self.admission_error = callback, admission_error
        self.active, self.entries, self.exits, self.calls = False, 0, [], []

    def __enter__(self):
        self.entries += 1
        if self.admission_error:
            raise self.admission_error
        self.active = True
        return self

    def __exit__(self, kind, value, traceback):
        self.active = False
        self.exits.append(kind)

    def run(self, argv, **kwargs):
        if not self.active:
            raise AssertionError("media child escaped the admission lifetime")
        self.calls.append((argv, kwargs))
        return self.callback(argv, kwargs)


class BudgetedHelpers(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source.mp4"
        self.source.write_bytes(b"synthetic input")
        self.output = self.root / "new-output"
        self.ffmpeg = str(self.root / "pinned decoder.exe")
        self.ffprobe = str(self.root / "pinned inspector.exe")
        self.whisper = self.root / "recognizer"; self.whisper.write_text("fixture")
        self.model = self.root / "model.bin"; self.model.write_bytes(b"fixture")
        self.stack = contextlib.ExitStack(); self.addCleanup(self.stack.close)
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))

    def qa_response(self, argv, kwargs):
        if argv[0] == self.ffprobe:
            stdout = json.dumps({"format": {"duration": "2"}, "streams": [
                {"codec_type": "video", "width": 64, "height": 48, "r_frame_rate": "10/1"}]})
        else:
            stdout = ""
            if argv[-1].endswith(".png"):
                Path(argv[-1]).write_bytes(b"fixture sheet")
        return subprocess.CompletedProcess(argv, 0, stdout, "")

    def run_qa(self, guard):
        with patch.object(qa.sys, "argv", ["qa_export.py", str(self.source), "--out", str(self.output)]), \
                patch.object(qa, "media_budget", return_value=guard) as budget, \
                patch.object(qa, "media_tool", side_effect=lambda tool: self.ffmpeg if tool == "ffmpeg" else self.ffprobe), \
                patch.object(qa.subprocess, "run", side_effect=AssertionError("unbudgeted subprocess.run")):
            result = qa.main()
        budget.assert_called_once_with("qa-export")
        return result

    def run_asr(self, guard, extra=()):
        argv = ["asr_blind.py", str(self.source), "--out", str(self.output), "--model", str(self.model),
                "--whisper-cli", str(self.whisper), *extra]
        with patch.object(asr.sys, "argv", argv), patch.object(asr, "media_budget", return_value=guard) as budget, \
                patch.object(asr, "media_tool", return_value=self.ffmpeg), \
                patch.object(asr.subprocess, "run", side_effect=AssertionError("unbudgeted subprocess.run")):
            result = asr.main()
        budget.assert_called_once_with("asr-blind")
        return result

    def asr_response(self, argv, kwargs):
        if argv[0] == self.ffmpeg:
            Path(argv[-1]).write_bytes(b"fixture audio")
        else:
            prefix = Path(argv[argv.index("-of") + 1])
            data = {"transcription": [{"text": " hello", "offsets": {"from": 0, "to": 500},
                                      "tokens": [{"text": " hello", "offsets": {"from": 0, "to": 500}}]}]}
            Path(str(prefix) + ".json").write_text(json.dumps(data))
        return subprocess.CompletedProcess(argv, 0, b"", b"")

    def test_qa_all_analysis_and_sheets_share_one_lease_with_pinned_tool_guards(self):
        guard = RecordingGuard(self.qa_response)
        self.assertEqual(self.run_qa(guard), 0)
        self.assertEqual(guard.entries, 1)
        self.assertEqual(guard.exits, [None])
        self.assertEqual(len(guard.calls), 6)  # probe, two metrics passes, three contact sheets
        for argv, kwargs in guard.calls:
            self.assertEqual(argv[argv.index("-protocol_whitelist") + 1], "file,pipe")
            self.assertTrue(kwargs["check"])
            self.assertGreater(kwargs["timeout"], 0)
            if argv[0] == self.ffmpeg:
                self.assertEqual(argv[argv.index("-threads") + 1], "2")
                self.assertEqual(argv[argv.index("-filter_threads") + 1], "2")
        report = json.loads((self.output / "report.json").read_text())
        self.assertEqual(len(report["sheets"]), 3)
        self.assertTrue(all((self.output / name).is_file() for name in report["sheets"]))

    def test_qa_admission_failure_starts_no_child_and_creates_no_output(self):
        guard = RecordingGuard(self.qa_response, RuntimeError("MEDIA_CAPACITY_TIMEOUT"))
        with self.assertRaisesRegex(RuntimeError, "MEDIA_CAPACITY_TIMEOUT"):
            self.run_qa(guard)
        self.assertEqual(guard.calls, [])
        self.assertFalse(self.output.exists())

    def test_qa_probe_failure_stops_before_analysis_or_report(self):
        def failure(argv, kwargs):
            raise subprocess.CalledProcessError(9, argv)
        guard = RecordingGuard(failure)
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_qa(guard)
        self.assertEqual(len(guard.calls), 1)
        self.assertEqual(guard.exits, [subprocess.CalledProcessError])
        self.assertFalse((self.output / "report.json").exists())

    def test_asr_conversion_and_recognition_share_one_lease_without_script_prompt(self):
        expected = self.root / "expected.txt"; expected.write_text("hello")
        guard = RecordingGuard(self.asr_response)
        self.assertEqual(self.run_asr(guard, ["--language", "en", "--offset", "2", "--compare", str(expected)]), 0)
        self.assertEqual((guard.entries, guard.exits, len(guard.calls)), (1, [None], 2))
        first, recognition = guard.calls[0][0], guard.calls[1][0]
        self.assertEqual(first[0], self.ffmpeg)
        self.assertEqual(first[first.index("-protocol_whitelist") + 1], "file,pipe")
        self.assertEqual(recognition[0], str(self.whisper))
        self.assertEqual(recognition[recognition.index("-l") + 1], "en")
        self.assertNotIn(str(expected), recognition)
        self.assertNotIn("hello", recognition)
        self.assertNotIn("--prompt", recognition)
        self.assertIn("00:00:02,000 --> 00:00:02,500", Path(str(self.output) + ".srt").read_text())

    def test_asr_conversion_failure_cannot_run_recognizer_or_write_report(self):
        def failure(argv, kwargs):
            raise subprocess.CalledProcessError(9, argv)
        guard = RecordingGuard(failure)
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_asr(guard)
        self.assertEqual(len(guard.calls), 1)
        self.assertEqual(guard.exits, [subprocess.CalledProcessError])
        self.assertFalse(Path(str(self.output) + ".report.json").exists())

    def test_asr_preflight_rejects_existing_output_before_admission(self):
        Path(str(self.output) + ".wav").write_bytes(b"keep existing audio")
        with patch.object(asr, "media_budget") as budget, patch.object(asr, "media_tool", return_value=self.ffmpeg), \
                patch.object(asr.sys, "argv", ["asr_blind.py", str(self.source), "--out", str(self.output),
                                              "--model", str(self.model), "--whisper-cli", str(self.whisper)]):
            with self.assertRaisesRegex(ValueError, "already exist"):
                asr.main()
        budget.assert_not_called()


@unittest.skipIf(os.name == "nt", "Offline recognizer executable fixture uses a POSIX shebang")
class RealAsrAdmission(unittest.TestCase):
    def test_real_conversion_and_offline_recognizer_hold_same_native_permit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "sample.wav"
            with wave.open(str(source), "wb") as stream:
                stream.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                stream.writeframes(b"\0\0" * 3200)
            decoder = root / "pinned decoder"
            decoder.symlink_to(shutil.which("ffmpeg"))
            model = root / "model.bin"; model.write_bytes(b"offline fixture")
            recognizer = root / "offline recognizer"
            recognizer.write_text(
                "#!" + sys.executable + "\nimport json,os,sys\nfrom pathlib import Path\n"
                "prefix=Path(sys.argv[sys.argv.index('-of')+1])\n"
                "markers=list(Path(os.environ['VIDS_STUDIO_MEDIA_BUDGET_DIR']).glob('slot-*.json'))\n"
                "assert len(markers)==1, 'recognizer must run inside one native permit'\n"
                "record=json.loads(markers[0].read_text())\n"
                "assert record['jobId'].startswith('asr-blind-')\n"
                "assert '-l' in sys.argv and '--prompt' not in sys.argv\n"
                "data={'transcription':[{'text':' hello','offsets':{'from':0,'to':100},'tokens':[]}]}\n"
                "Path(str(prefix)+'.json').write_text(json.dumps(data))\n"
                "Path(str(prefix)+'.permit-check.json').write_text(json.dumps({'jobId':record['jobId'],'language':sys.argv[sys.argv.index('-l')+1]}))\n"
            )
            recognizer.chmod(0o700)
            prefix = root / "result"
            env = {**os.environ, "VIDS_STUDIO_FFMPEG": str(decoder),
                   "VIDS_STUDIO_MEDIA_BUDGET_DIR": str(root / "budget"), "VIDS_STUDIO_FLEET_DIR": str(root / "fleet"),
                   "VIDS_STUDIO_REGISTRY_DIR": str(root / "registry")}
            process = subprocess.run([sys.executable, "-I", str(SCRIPTS / "asr_blind.py"), str(source),
                                      "--out", str(prefix), "--whisper-cli", str(recognizer), "--model", str(model),
                                      "--language", "en"], env=env, capture_output=True, text=True, timeout=20)
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertEqual(json.loads(Path(str(prefix) + ".permit-check.json").read_text())["language"], "en")
            self.assertTrue(Path(str(prefix) + ".report.json").is_file())
            self.assertEqual(list((root / "budget").glob("slot-*.json")), [], "settled workflow must release its permit")


if __name__ == "__main__":
    unittest.main()
