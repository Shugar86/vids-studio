"""CLI language routing using real WAV conversion and a fake offline recognizer."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import wave

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/transcribe_local.py"


class LanguageRouting(unittest.TestCase):
    def test_selected_language_reaches_cli_without_an_expected_prompt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.wav"
            with wave.open(str(source), "wb") as audio:
                audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                audio.writeframes(b"\0\0" * 1600)
            cli = root / "recognizer"
            cli.write_text("#!/usr/bin/env python3\nimport sys,json\nfrom pathlib import Path\np=Path(sys.argv[sys.argv.index('-of')+1])\nfor x in ['txt','srt','json']: Path(str(p)+'.'+x).write_text('{}')\nPath(str(p)+'.args.json').write_text(json.dumps(sys.argv[1:]))\n")
            cli.chmod(0o700)
            model = root / "model.bin"
            model.write_bytes(b"fixture")
            for language in ["en", "ru"]:
                prefix = root / language
                result = subprocess.run(["python3", str(SCRIPT), str(source), "--output", str(prefix), "--language", language, "--whisper-cli", str(cli), "--model-path", str(model)], capture_output=True, text=True, timeout=20)
                self.assertEqual(result.returncode, 0, result.stderr)
                args = json.loads(Path(str(prefix)+".args.json").read_text())
                self.assertEqual(args[args.index("-l")+1], language)
                self.assertNotIn("--prompt", args)
                self.assertEqual(json.loads(Path(str(prefix)+".run.json").read_text())["language"], language)

if __name__ == "__main__":
    unittest.main()
