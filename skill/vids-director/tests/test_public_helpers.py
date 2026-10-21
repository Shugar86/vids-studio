"""Portable helper boundaries; uses no network or user browser."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("vendor_fonts", ROOT / "scripts/vendor_fonts.py")
fonts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fonts)


class PublicHelpers(unittest.TestCase):
    def test_font_provenance_and_license_are_retained_without_network(self):
        css = b"/* latin */ @font-face {font-family: 'Demo'; src: url(https://fonts.gstatic.com/demo.woff2);}"
        data = b"wOF2fixture"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            license_file = root / "license.txt"
            license_file.write_text("Fixture license text")
            out = root / "fonts"
            with patch.object(fonts, "get", side_effect=lambda url: css if "googleapis" in url else data), patch.object(sys, "argv", ["vendor_fonts.py", "Demo:wght@400", "--out", str(out), "--license-file", str(license_file), "--license-source", "https://example.com/license"]):
                self.assertEqual(fonts.main(), 0)
            manifest = json.loads((out / "fonts.provenance.json").read_text())
            self.assertEqual(manifest["files"][0]["sha256"], hashlib.sha256(data).hexdigest())
            self.assertEqual((out / manifest["license_file"]).read_text(), license_file.read_text())
            self.assertNotIn("https://", (out / "fonts.css").read_text())

    def test_font_url_and_redirect_allowlist_reject_other_hosts(self):
        for url in ["http://fonts.gstatic.com/a", "https://example.com/a", "https://fonts.gstatic.com:444/a", "file:///tmp/a", "https://user@fonts.gstatic.com/a"]:
            with self.assertRaises(ValueError):
                fonts.checked_url(url)
        self.assertEqual(fonts.checked_url("https://fonts.gstatic.com/a"), "https://fonts.gstatic.com/a")
        with self.assertRaises(ValueError):
            fonts.FontRedirect().redirect_request(None, None, 302, "", {}, "https://example.com/file")

    def test_wrong_client_profile_cannot_launch_mcp(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "profile.json").write_text('{"id":"codex"}')
            result = subprocess.run(["node", str(ROOT / "scripts/vids_call.mjs"), "vids_status"], env={**os.environ, "VIDS_CLAUDE_BRIDGE": tmp}, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 2)
            self.assertIn('No fallback profile', result.stderr)
            self.assertNotIn(tmp, result.stderr)

if __name__ == "__main__":
    unittest.main()
