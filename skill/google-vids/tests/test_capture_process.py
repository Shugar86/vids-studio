"""Bounded encoder processes and capture admission; synthetic local children only."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node") or "node"


class CaptureProcess(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="vids-capture-process-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.child = self.directory / "encoder.mjs"
        self.child.write_text("""
import fs from 'node:fs';
const root = process.env.VIDS_TEST_ROOT;
process.on('SIGTERM', () => {
  if (process.env.VIDS_TEST_IGNORE_TERM) return;
  setTimeout(() => { fs.writeFileSync(root+'/exited', 'yes'); process.exit(0); }, 100);
});
fs.writeFileSync(root+'/pid', String(process.pid));
setInterval(() => {}, 1000);
""")

    def run_node(self, body, **environment):
        prefix = f"""
import fs from 'node:fs';
import {{setTimeout as delay}} from 'node:timers/promises';
import {{runMediaProcess}} from {json.dumps((ROOT / 'scripts/media_process.mjs').as_uri())};
import {{withMediaBudget}} from {json.dumps((ROOT.parents[1] / 'server/media-budget.mjs').as_uri())};
const root = process.env.VIDS_TEST_ROOT;
const childFile = root + '/encoder.mjs';
const ready = async () => {{
  for(let i=0;i<200;i++){{if(fs.existsSync(root+'/pid'))return;await delay(10);}}
  throw Error('Synthetic encoder did not start');
}};
const alive = () => {{try{{process.kill(Number(fs.readFileSync(root+'/pid','utf8')),0);return true;}}catch{{return false;}}}};
"""
        result = subprocess.run([NODE, "--input-type=module", "-"], input=prefix + body,
                                text=True, capture_output=True, timeout=15,
                                env={**os.environ, "VIDS_TEST_ROOT": str(self.directory), **environment})
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def keeper(self, lose=False):
        path = self.directory / "keeper"
        path.write_text("""#!/usr/bin/env python3
import json, os, pathlib, sys, time
root = pathlib.Path(os.environ['VIDS_TEST_ROOT'])
json.loads(sys.stdin.readline())
print(json.dumps({'event':'acquired','leaseId':'fixture-lease','effectiveSlots':1}),flush=True)
if os.environ.get('VIDS_TEST_LOSE_KEEPER'):
    while not (root/'pid').exists(): time.sleep(.01)
    sys.exit(0)
message = json.loads(sys.stdin.readline())
alive = False
try:
    os.kill(int((root/'pid').read_text()), 0)
    alive = True
except ProcessLookupError: pass
(root/'release').write_text(json.dumps({'action':message.get('action'),'encoderAlive':alive}))
print(json.dumps({'event':'released'}),flush=True)
""")
        path.chmod(0o700)
        return {"VIDS_STUDIO_PYTHON": str(path), **({"VIDS_TEST_LOSE_KEEPER": "1"} if lose else {})}

    @unittest.skipIf(os.name == "nt", "POSIX executable/signals fixture")
    def test_abort_waits_for_encoder_close_before_keeper_releases_permit(self):
        result = self.run_node("""
const controller = new AbortController();
const task = withMediaBudget({jobId:'fixture-abort',signal:controller.signal},
  signal => runMediaProcess(process.execPath,[childFile],{signal,timeoutMs:5000})).catch(error=>error.code);
await ready(); controller.abort(); const code = await task;
console.log(JSON.stringify({code,alive:alive(),exited:fs.existsSync(root+'/exited'),release:JSON.parse(fs.readFileSync(root+'/release'))}));
""", **self.keeper())
        self.assertEqual(result, {"code": "MEDIA_CHECK_CANCELED", "alive": False, "exited": True,
                                  "release": {"action": "release", "encoderAlive": False}})

    @unittest.skipIf(os.name == "nt", "POSIX executable/signals fixture")
    def test_keeper_loss_aborts_encoder_and_waits_for_its_close(self):
        result = self.run_node("""
const code = await withMediaBudget({jobId:'fixture-keeper-loss'},
  signal=>runMediaProcess(process.execPath,[childFile],{signal,timeoutMs:5000})).catch(error=>error.code);
console.log(JSON.stringify({code,alive:alive(),exited:fs.existsSync(root+'/exited'),released:fs.existsSync(root+'/release')}));
""", **self.keeper(lose=True))
        self.assertEqual(result, {"code": "MEDIA_CHECK_CANCELED", "alive": False, "exited": True, "released": False})

    def test_timeout_stops_a_process_that_ignores_termination(self):
        result = self.run_node("""
const code = await runMediaProcess(process.execPath,[childFile],{timeoutMs:1000,killGraceMs:50}).catch(error=>error.code);
console.log(JSON.stringify({code,alive:alive()}));
""", VIDS_TEST_IGNORE_TERM="1")
        self.assertEqual(result, {"code": "MEDIA_PROCESS_TIMEOUT", "alive": False})

    def test_error_and_stderr_are_bounded_and_preabort_does_not_spawn(self):
        result = self.run_node("""
const missing = await runMediaProcess(root+'/missing-encoder',[],{timeoutMs:1000}).catch(error=>error.code);
const failed = await runMediaProcess(process.execPath,['-e',"process.stderr.write('x'.repeat(200000));process.exitCode=7"],
  {timeoutMs:5000,stderrLimit:1024}).catch(error=>({code:error.code,length:error.message.length}));
const success = await runMediaProcess(process.execPath,['-e',"process.stderr.write('y'.repeat(200000))"],{stderrLimit:1024});
const controller = new AbortController(); controller.abort();
const canceled = await runMediaProcess(process.execPath,[childFile],{signal:controller.signal}).catch(error=>error.code);
console.log(JSON.stringify({missing,failed,stderrLength:success.stderr.length,canceled,spawned:fs.existsSync(root+'/pid')}));
""")
        self.assertEqual(result["missing"], "MEDIA_PROCESS_FAILED")
        self.assertEqual(result["failed"]["code"], "MEDIA_PROCESS_FAILED")
        self.assertLessEqual(result["failed"]["length"], 450)
        self.assertEqual(result["stderrLength"], 1024)
        self.assertEqual(result["canceled"], "MEDIA_CHECK_CANCELED")
        self.assertFalse(result["spawned"])

    def test_invalid_capture_limits_stop_before_directory_admission_or_browser(self):
        cases = [("--width", "Infinity"), ("--height", "NaN"), ("--width", "63"), ("--width", "4097"),
                 ("--scale", "0"), ("--scale", "4.1"), ("--max-height", "8193"), ("--max-height", "639"),
                 ("--start", "Infinity"), ("--wait", "30001"), ("--scroll", "121"), ("--scroll", "0"),
                 ("--width", "4096", "--height", "4096", "--max-height", "4096", "--scale", "4"),
                 ("--width", "2048", "--height", "640", "--max-height", "8192", "--scale", "2")]
        for index, args in enumerate(cases):
            out = self.directory / str(index)
            result = subprocess.run([NODE, str(ROOT / "scripts/capture_site.mjs"), "file:///fixture-not-opened",
                                     "--out", str(out), *args], capture_output=True, text=True, timeout=10,
                                    env={**os.environ, "VIDS_STUDIO_PYTHON": str(self.directory / "must-not-launch")})
            with self.subTest(args=args):
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("Invalid capture limits", result.stderr)
                self.assertFalse(out.exists())


if __name__ == "__main__":
    unittest.main()
