"""Shared fleet migration regressions with isolated real-MCP fixtures for both profiles.

All endpoints/media/capabilities here are temporary synthetic fixtures; never use live Chrome.
"""
import base64
import contextlib
import io
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import vids_ui


@unittest.skipUnless(os.name == "posix", "Python capability files require POSIX ownership checks")
class FleetAcquisition(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="vids-helper-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.control = self.root / "control.json"
        self.recovery = self.root / "control.json.binding.json"
        self.ticket = self.root / "ticket"
        self.ticket.write_text("a" * 64)
        self.ticket.chmod(0o600)
        self.session = str(uuid.uuid4())
        self.document = "fixture-explicit-document"
        self.token = "fixture_own_control_" + "z" * 32
        self.calls = []
        self.stdout, self.stderr = io.StringIO(), io.StringIO()
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(contextlib.redirect_stdout(self.stdout))
        self.stack.enter_context(contextlib.redirect_stderr(self.stderr))
        self.stack.enter_context(patch.object(vids_ui, "CTL", {}))

    def run_acquire(self, **override):
        return vids_ui.acquire(**{"control_path": self.control, "session": self.session,
                                  "document": self.document, "ticket_file": str(self.ticket), **override})

    def reply(self, tool, params=None, **kwargs):
        self.calls.append((tool, params))
        recovered = json.loads(self.recovery.read_text())
        self.assertEqual(self.recovery.stat().st_mode & 0o777, 0o600)
        self.assertEqual(params["sessionId"], self.session)
        self.assertEqual(params["bindingToken"], recovered["bindingToken"])
        self.assertEqual(params["expectedDocumentId"], self.document)
        if tool == "vids_claim_attachment":
            self.assertEqual(recovered["state"], "claim_pending", "capability must be durable BEFORE claim")
            self.assertEqual(params["intentId"], recovered["intentId"])
            result = {"bindingId": params["bindingId"], "documentId": self.document, "sessionId": self.session}
        elif tool == "vids_acquire_control":
            self.assertEqual(recovered["state"], "acquire_pending")
            self.assertNotIn("pairingTicket", recovered)
            result = {"sessionId": self.session, "controlToken": self.token, "mode": "write"}
        else:
            self.fail("Unexpected routing/authority tool " + tool)
        return {"result": result}, []

    def test_explicit_claim_then_own_control_and_private_durable_recovery(self):
        with patch.object(vids_ui, "call", side_effect=self.reply):
            self.run_acquire()
        self.assertEqual([tool for tool, _ in self.calls], ["vids_claim_attachment", "vids_acquire_control"])
        self.assertEqual(self.control.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(self.recovery.read_text())["state"], "active")
        self.assertNotIn(self.token, self.stdout.getvalue() + self.stderr.getvalue())
        self.assertEqual(vids_ui.use(self.control), {"sessionId": self.session, "controlToken": self.token})

    def test_legacy_acquire_fails_before_discovery_or_control(self):
        with patch.object(vids_ui, "call") as call, self.assertRaises(SystemExit):
            self.run_acquire(session=None, document=None)
        call.assert_not_called()
        self.assertIn("--session", self.stderr.getvalue())
        self.assertFalse(self.recovery.exists())

    def test_legacy_cli_cannot_silently_claim_the_current_tab(self):
        def old_route(tool, params=None):
            if tool == "vids_status":
                return {"attached": True, "sessionId": self.session, "title": "fixture-current-tab"}, []
            return {"result": {"sessionId": self.session, "controlToken": self.token}}, []
        with patch.object(vids_ui.sys, "argv", ["vids_ui.py", "acquire", str(self.control)]), \
                patch.object(vids_ui, "call", side_effect=old_route) as call, self.assertRaises(SystemExit):
            vids_ui.main()
        call.assert_not_called()
        self.assertFalse(self.control.exists())

    def test_concurrent_acquisition_cannot_read_or_replace_recovery(self):
        with vids_ui._acquisition_lock(self.control), patch.object(vids_ui, "call") as call, self.assertRaises(SystemExit):
            self.run_acquire()
        call.assert_not_called()
        self.assertFalse(self.recovery.exists())

    def test_claim_receipt_loss_reuses_only_identical_saved_intent(self):
        first = []
        def lost(tool, params, **kwargs):
            first.append((tool, params))
            self.assertTrue(self.recovery.exists())
            raise SystemExit(1)
        with patch.object(vids_ui, "call", side_effect=lost), self.assertRaises(SystemExit):
            self.run_acquire()
        self.ticket.unlink()
        with patch.object(vids_ui, "call", side_effect=self.reply):
            self.run_acquire(ticket_file=None)
        self.assertEqual(self.calls[0], first[0])

    def test_lost_acquire_receipt_is_not_retried_even_on_next_invocation(self):
        def lost(tool, params, **kwargs):
            result = self.reply(tool, params)
            if tool == "vids_acquire_control":
                raise SystemExit(1)
            return result
        with patch.object(vids_ui, "call", side_effect=lost), self.assertRaises(SystemExit):
            self.run_acquire()
        self.assertEqual(json.loads(self.recovery.read_text())["state"], "acquire_pending")
        self.assertFalse(self.control.exists())
        with patch.object(vids_ui, "call") as call, self.assertRaises(SystemExit):
            self.run_acquire()
        call.assert_not_called()
        self.assertIn("was not retried", self.stderr.getvalue())

    def test_mismatched_claim_receipt_cannot_acquire_control(self):
        result = {"result": {"sessionId": str(uuid.uuid4()), "documentId": self.document}}
        with patch.object(vids_ui, "call", return_value=(result, [])) as call, self.assertRaises(SystemExit):
            self.run_acquire()
        self.assertEqual(call.call_count, 1)
        self.assertFalse(self.control.exists())

    def test_new_document_cannot_reuse_recovery(self):
        with patch.object(vids_ui, "call", side_effect=SystemExit(1)), self.assertRaises(SystemExit):
            self.run_acquire()
        with patch.object(vids_ui, "call") as call, self.assertRaises(SystemExit):
            self.run_acquire(document="fixture-other-document")
        call.assert_not_called()

    def test_ticket_stdin_is_supported_without_exposing_it(self):
        self.ticket.unlink()
        with patch.object(vids_ui.sys, "stdin", io.StringIO("b" * 64 + "\n")), patch.object(vids_ui, "call", side_effect=self.reply):
            self.run_acquire(ticket_file="-")
        self.assertEqual(self.calls[0][1]["pairingTicket"], "b" * 64)
        self.assertNotIn("b" * 64, self.stdout.getvalue() + self.stderr.getvalue())

    def test_world_readable_ticket_rejected_before_any_call(self):
        self.ticket.chmod(0o644)
        with patch.object(vids_ui, "call") as call, self.assertRaises(SystemExit):
            self.run_acquire()
        call.assert_not_called()

    def test_existing_control_cannot_be_overwritten(self):
        self.control.write_text("owned-by-existing-task")
        with patch.object(vids_ui, "call") as call, self.assertRaises(SystemExit):
            self.run_acquire()
        call.assert_not_called()
        self.assertEqual(self.control.read_text(), "owned-by-existing-task")

    def test_shared_directory_and_symlink_are_rejected(self):
        self.root.chmod(0o755)
        with patch.object(vids_ui, "call") as call, self.assertRaises(SystemExit):
            self.run_acquire()
        call.assert_not_called()
        self.root.chmod(0o700)
        linked = self.root / "linked-ticket"
        linked.symlink_to(self.ticket)
        with patch.object(vids_ui, "call") as call, self.assertRaises(SystemExit):
            self.run_acquire(ticket_file=str(linked))
        call.assert_not_called()

    def test_control_input_filters_recovery_fields_and_rejects_wrong_profile(self):
        data = {"schemaVersion": 1, "profileId": vids_ui.PROFILE_ID, "sessionId": self.session,
                "documentId": self.document, "bindingId": str(uuid.uuid4()), "controlToken": self.token,
                "bindingToken": "private-binding", "pairingTicket": "private-ticket"}
        self.control.write_text(json.dumps(data)); self.control.chmod(0o600)
        self.assertEqual(vids_ui.use(self.control), {"sessionId": self.session, "controlToken": self.token})
        self.control.write_text(json.dumps({**data, "profileId": "claude" if vids_ui.PROFILE_ID == "codex" else "codex"}))
        with self.assertRaises(SystemExit):
            vids_ui.use(self.control)

    def test_missing_profile_or_binding_in_control_is_rejected_without_legacy_fallback(self):
        data = {"schemaVersion": 1, "profileId": vids_ui.PROFILE_ID, "sessionId": self.session,
                "documentId": self.document, "bindingId": str(uuid.uuid4()), "controlToken": self.token}
        for missing in ("profileId", "documentId", "bindingId", "schemaVersion"):
            incomplete = {key: value for key, value in data.items() if key != missing}
            self.control.write_text(json.dumps(incomplete)); self.control.chmod(0o600)
            with self.subTest(missing=missing), self.assertRaises(SystemExit):
                vids_ui.use(self.control)

    def test_unsupported_private_file_platform_fails_before_claim_with_direct_mcp_guidance(self):
        with patch.object(vids_ui, "fcntl", None), patch.object(vids_ui, "call") as call, self.assertRaises(SystemExit):
            self.run_acquire()
        call.assert_not_called()
        self.assertIn("direct MCP", self.stderr.getvalue())
        self.assertFalse(self.recovery.exists())

    def test_capabilities_go_to_stdin_never_argv(self):
        vids_ui.CTL = {"sessionId": self.session, "controlToken": self.token}
        completed = subprocess.CompletedProcess([], 0, '{"result":{"snapshotId":"fixture","nodes":[]}}', '')
        with patch.object(vids_ui.subprocess, "run", return_value=completed) as run:
            vids_ui.call("vids_observe")
        args, kwargs = run.call_args
        self.assertEqual(args[0][-1], "-")
        self.assertNotIn(self.token, " ".join(args[0]))
        self.assertEqual(json.loads(kwargs["input"])["controlToken"], self.token)

    def test_unleased_call_does_not_leak_old_control_capability(self):
        vids_ui.CTL = {"sessionId": "old", "controlToken": self.token}
        completed = subprocess.CompletedProcess([], 0, '{"result":{}}', '')
        with patch.object(vids_ui.subprocess, "run", return_value=completed) as run:
            vids_ui.call("vids_binding_status", {"sessionId": self.session, "bindingToken": "b" * 32})
        self.assertNotIn("controlToken", json.loads(run.call_args.kwargs["input"]))

    def test_filename_export_fails_before_browser_or_filesystem_lookup(self):
        with patch.object(vids_ui, "call") as call, self.assertRaises(SystemExit):
            vids_ui.export_mp4(self.root / "out.mp4", "fixture-title")
        call.assert_not_called()
        self.assertIn("vids_job_start", self.stderr.getvalue())


class WrapperBoundaries(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="vids-cli-boundary-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.wrapper = Path(__file__).resolve().parents[1] / "scripts/vids_call.mjs"
        self.profile = "codex" if self.wrapper.parents[1].name == "google-vids" else "claude"
        self.key = "VIDS_CODEX_BRIDGE" if self.profile == "codex" else "VIDS_CLAUDE_BRIDGE"

    def invoke(self, argument="-", payload="{}", **environment):
        return subprocess.run(["node", str(self.wrapper), "vids_status", argument],
                              input=payload, capture_output=True, text=True, timeout=10,
                              env={**os.environ, self.key: str(self.root), **environment})

    def test_missing_or_foreign_profile_cannot_fall_back(self):
        for profile in (None, "claude" if self.profile == "codex" else "codex"):
            if profile is not None:
                (self.root / "profile.json").write_text(json.dumps({"id": profile}))
            result = self.invoke()
            self.assertEqual(result.returncode, 2)
            self.assertIn("No fallback profile", result.stderr)
            self.assertNotIn(str(self.root), result.stderr)

    def test_other_client_or_generic_environment_cannot_select_this_profile(self):
        other = self.root / "other"; other.mkdir()
        (other / "profile.json").write_text(json.dumps({"id": "claude" if self.profile == "codex" else "codex"}))
        key = "VIDS_CLAUDE_BRIDGE" if self.profile == "codex" else "VIDS_CODEX_BRIDGE"
        result = self.invoke(**{key: str(other), "VIDS_BRIDGE": str(other)})
        self.assertEqual(result.returncode, 2)
        self.assertIn(self.key, result.stderr)
        self.assertIn("No fallback profile", result.stderr)

    def test_argv_payload_and_malformed_stdin_are_rejected_without_echoing_capabilities(self):
        (self.root / "profile.json").write_text(json.dumps({"id": self.profile}))
        secret = "synthetic_private_capability_" + "s" * 32
        for argument, payload in ((json.dumps({"controlToken": secret}), ""), ("-", '{"controlToken":"' + secret)):
            result = self.invoke(argument, payload)
            self.assertEqual(result.returncode, 2)
            self.assertNotIn(secret, result.stdout + result.stderr)


@unittest.skipUnless(os.name == "posix", "Isolated Unix socket fixture; direct MCP remains available on Windows")
class PublicWrapperIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = Path(os.environ.get("VIDS_STUDIO_CANONICAL_SOURCE", Path(__file__).resolve().parents[3])).resolve()
        if json.loads((cls.source / "profile.json").read_text()).get("id") != "codex":
            raise unittest.SkipTest("Set VIDS_STUDIO_CANONICAL_SOURCE to test both profiles from an installed Claude archive")
        cls.temporary = tempfile.TemporaryDirectory(prefix="vui-")
        cls.root = Path(cls.temporary.name)
        cls.profiles = {}
        try:
            for profile in ("codex", "claude"):
                target = cls.root / profile
                build = subprocess.run([sys.executable, str(cls.source / "scripts/build_profiles.py"),
                                        "--profile", profile, "--target", str(target), "--write"],
                                       capture_output=True, text=True)
                if build.returncode:
                    raise RuntimeError("isolated profile fixture build failed: " + build.stderr)
                (target / "node_modules").symlink_to(cls.source / "node_modules", target_is_directory=True)
                cls.profiles[profile] = target
        except BaseException:
            cls.temporary.cleanup()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_public_wrapper_real_mcp_acquire_observe_fresh_screenshot_and_reject_unknown(self):
        for profile_id, profile in self.profiles.items():
            with self.subTest(profile=profile_id):
                self.check_profile(profile_id, profile)

    def check_profile(self, profile_id, profile):
        wrapper = "google-vids" if profile_id == "codex" else "vids-director"
        spec = importlib.util.spec_from_file_location("vids_ui_" + profile_id, profile / "skill" / wrapper / "scripts/vids_ui.py")
        helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
        local = self.root / (profile_id + "-fixture"); local.mkdir(mode=0o700)
        directory = local / "runtime"
        directory.mkdir(mode=0o700)
        sessions = directory / "sessions"; sessions.mkdir(mode=0o700)
        private = local / "task"; private.mkdir(mode=0o700)
        control = private / "control.json"
        ticket = private / "ticket"; ticket.write_text("c" * 64); ticket.chmod(0o600)
        session, document = str(uuid.uuid4()), "fixture-public-mcp-document"
        token = "fixture_own_lease_" + "x" * 32
        calls, pending_claim = [], {}
        image_bytes = io.BytesIO(); Image.new("RGB", (40, 20), "blue").save(image_bytes, format="PNG")
        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                request = json.loads(self.rfile.readline())
                calls.append(request)
                method, params = request["method"], request["params"]
                error, result = None, None
                if request.get("sessionId") != session:
                    error = {"code": "SESSION_MISMATCH", "message": "fixture wrong session"}
                elif method == "claim_attachment":
                    pending_claim.update(params)
                    result = {"sessionId": session, "documentId": document, "bindingId": params["bindingId"]}
                elif method == "acquire_control" and params.get("bindingToken") == pending_claim.get("bindingToken"):
                    result = {"sessionId": session, "controlToken": token, "mode": "write"}
                elif request.get("controlToken") != token:
                    error = {"code": "CONTROL_BUSY", "message": "fixture requires own lease"}
                elif method == "observe":
                    result = {"snapshotId": "fixture-observe", "nodes": []}
                elif method == "screenshot":
                    result = {"snapshotId": "fixture-fresh-screenshot", "coordinateSpace": "css-viewport",
                              "image": {"width": 40, "height": 20, "scaleX": 2, "scaleY": 2},
                              "mimeType": "image/png", "data": base64.b64encode(image_bytes.getvalue()).decode()}
                elif method == "scroll":
                    error = {"code": "BROWSER_TIMEOUT", "message": "fixture unsettled input", "outcome": "unknown"}
                else:
                    error = {"code": "FIXTURE_UNEXPECTED", "message": method}
                self.wfile.write((json.dumps({"v": 3, "type": "response", "id": request["id"], "ok": not error,
                                             **({"error": error} if error else {"result": result})}) + "\n").encode())
        endpoint = sessions / (session + ".sock")
        server = socketserver.UnixStreamServer(str(endpoint), Handler)
        endpoint.chmod(0o600)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        # Refuse to launch any MCP child if the wrapper silently drops isolation overrides.
        # SDK default environments are intentionally small; no accidental fallback to a user's host.
        guard = local / "fixture-spawn-guard.mjs"
        bridge_key = "VIDS_CODEX_BRIDGE" if profile_id == "codex" else "VIDS_CLAUDE_BRIDGE"
        environment = {bridge_key: str(profile), "VIDS_STUDIO_SOCKET": str(directory / "bridge.sock"),
                       "VIDS_STUDIO_FLEET_DIR": str(local / "fleet"), "VIDS_STUDIO_REGISTRY_DIR": str(local / "registry"),
                       "VIDS_STUDIO_MEDIA_BUDGET_DIR": str(local / "media"),
                       "VIDS_STUDIO_PYTHON": sys.executable, "XDG_STATE_HOME": str(local / "state")}
        expected = {key: value for key, value in environment.items() if key != bridge_key}
        guard.write_text("import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';\n"
                         "const expected = " + json.dumps(expected) + ";\n"
                         "const spawn = cp.spawn; cp.spawn = function(command, args, options) {\n"
                         "  if (args?.some(arg => String(arg).endsWith('/server/index.mjs')) &&\n"
                         "      Object.entries(expected).some(([key, value]) => options?.env?.[key] !== value))\n"
                         "    throw Error('Fixture isolation missing: MCP child was not launched');\n"
                         "  return spawn.call(this, command, args, options); }; syncBuiltinESMExports();\n")
        environment["NODE_OPTIONS"] = "--import=" + str(guard)
        output = io.StringIO()
        try:
            with patch.dict(os.environ, environment), contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                helper.acquire(control, session, document, str(ticket), "Synthetic integration")
                helper.use(control)
                self.assertEqual(helper.obs()["snapshotId"], "fixture-observe")
                shot = private / "shot.png"; Image.new("RGB", (8, 8), "red").save(shot)
                result, scale = helper.shot(shot)
                self.assertEqual((result.size, result.getpixel((0, 0)), scale), ((40, 20), (0, 0, 255), 2))
                with self.assertRaises(SystemExit):
                    helper.act("vids_scroll", {"snapshotId": "fixture-observe"}, wait=0, x=2, y=2, deltaY=5)
            self.assertEqual([call["method"] for call in calls], ["claim_attachment", "acquire_control", "observe", "screenshot", "scroll"])
            self.assertNotIn(token, output.getvalue())
            self.assertNotIn(pending_claim["bindingToken"], output.getvalue())
            self.assertIn("BROWSER_TIMEOUT", output.getvalue())
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
