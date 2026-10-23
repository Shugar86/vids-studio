"""render_layer.mjs on the layers skeleton: python3 -m unittest discover -s tests"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/render_layer.mjs"
NODE = shutil.which("node") or "/usr/bin/node"


def render(page, out, *args):
    return subprocess.run([NODE, str(SCRIPT), str(page), str(out), *args], capture_output=True, text=True, timeout=120,
                          env={**os.environ, "VIDS_STUDIO_MEDIA_BUDGET_DIR": str(out.parent / "budget"),
                               "VIDS_STUDIO_FLEET_DIR": str(out.parent / "fleet")})


class RenderLayer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.tmp.name)
        cls.page = cls.dir / "layers.html"
        shutil.copy(ROOT / "assets/layers.html", cls.page)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_show_one_layer_is_transparent_full_frame(self):
        out = self.dir / "headline.png"
        result = render(self.page, out, "--show", "headline")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["overflow"], [])
        header = out.read_bytes()[:26]
        self.assertEqual(int.from_bytes(header[16:20], "big"), 1080)
        self.assertEqual(int.from_bytes(header[20:24], "big"), 1920)
        self.assertEqual(header[25], 6, "expected RGBA (colour type 6)")

    def test_text_that_does_not_fit_fails_with_code_3(self):
        page = self.dir / "long.html"
        page.write_text(self.page.read_text().replace("Одна мысль бита", "Очень длинная мысль бита, которая никак не помещается в две строки заголовка"))
        result = render(page, self.dir / "long.png", "--show", "headline")
        self.assertEqual(result.returncode, 3, result.stderr)

    def test_static_render_cannot_open_network_or_websockets(self):
        received = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                received.append(self.path)
                self.send_response(403)
                self.end_headers()
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            origin = f"127.0.0.1:{server.server_port}"
            page = self.dir / "network.html"
            page.write_text(f'''<!doctype html><html><body><div class="layer" id="fixture" data-fit="1">Static text</div>
                <img src="http://{origin}/image"><script>
                document.getElementById('fixture').textContent='PAGE JAVASCRIPT EXECUTED '.repeat(100);
                fetch('http://{origin}/fetch'); new WebSocket('ws://{origin}/socket');
                </script></body></html>''', encoding="utf-8")
            result = render(page, self.dir / "offline.png", "--show", "fixture", "--width", "300", "--height", "100")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["overflow"], [], "Page scripts must not mutate static content")
            self.assertEqual(received, [], "Static layer documents must not send HTTP or WebSocket traffic")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_invalid_or_excessive_dimensions_are_rejected_before_admission(self):
        for width, height in (("NaN", "100"), ("Infinity", "100"), ("0", "100"),
                              ("10.5", "100"), ("9000", "100"), ("8192", "8192")):
            result = render(self.page, self.dir / "invalid.png", "--width", width, "--height", height)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn("Dimensions", result.stderr)
            self.assertFalse((self.dir / "invalid.png").exists())

    def test_oversized_selected_element_is_rejected_before_screenshot(self):
        page = self.dir / "giant.html"
        page.write_text('<!doctype html><div id="giant" style="width:8000px;height:8000px;background:red"></div>', encoding="utf-8")
        result = render(page, self.dir / "giant.png", "--selector", "#giant", "--width", "100", "--height", "100")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Selected layer dimensions", result.stderr)
        self.assertFalse((self.dir / "giant.png").exists())

    def test_guides_and_selector_work_with_page_scripts_disabled(self):
        result = render(self.page, self.dir / "guides.png", "--show", "object", "--selector", "#object", "--guides", "--opaque")
        self.assertEqual(result.returncode, 0, result.stderr)
        header = (self.dir / "guides.png").read_bytes()[:24]
        self.assertEqual(int.from_bytes(header[16:20], "big"), 600)
        self.assertEqual(int.from_bytes(header[20:24], "big"), 360)

    @unittest.skipIf(os.name == "nt", "POSIX executable fixture")
    def test_render_and_capture_stop_when_shared_admission_is_unavailable(self):
        keeper = self.dir / "unavailable-keeper"
        keeper.write_text('#!/usr/bin/env python3\nimport json\nprint(json.dumps({"event":"error","code":"MEDIA_CAPACITY_TIMEOUT","message":"fixture admission denied"}),flush=True)\n')
        keeper.chmod(0o700)
        for script, args in (
            ("render_layer.mjs", [str(self.page), str(self.dir / "denied.png")]),
            ("capture_site.mjs", ["file:///nonexistent-vids-fixture", "--out", str(self.dir / "denied-site")]),
        ):
            result = subprocess.run([NODE, str(ROOT / "scripts" / script), *args],
                                    capture_output=True, text=True, timeout=15,
                                    env={**os.environ, "VIDS_STUDIO_PYTHON": str(keeper)})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("fixture admission denied", result.stderr)
        self.assertFalse((self.dir / "denied.png").exists())
        self.assertFalse(list((self.dir / "denied-site").glob("*.png")))

    def test_unknown_layer_and_overwrite_are_refused(self):
        self.assertNotEqual(render(self.page, self.dir / "x.png", "--show", "nope").returncode, 0)
        out = self.dir / "twice.png"
        self.assertEqual(render(self.page, out, "--show", "object").returncode, 0)
        self.assertNotEqual(render(self.page, out, "--show", "object").returncode, 0)


if __name__ == "__main__":
    unittest.main()
