"""render_layer.mjs on the layers skeleton: python3 -m unittest discover -s tests"""
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/render_layer.mjs"
NODE = shutil.which("node") or "/usr/bin/node"


def render(page, out, *args):
    return subprocess.run([NODE, str(SCRIPT), str(page), str(out), *args], capture_output=True, text=True, timeout=120)


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

    def test_unknown_layer_and_overwrite_are_refused(self):
        self.assertNotEqual(render(self.page, self.dir / "x.png", "--show", "nope").returncode, 0)
        out = self.dir / "twice.png"
        self.assertEqual(render(self.page, out, "--show", "object").returncode, 0)
        self.assertNotEqual(render(self.page, out, "--show", "object").returncode, 0)


if __name__ == "__main__":
    unittest.main()
