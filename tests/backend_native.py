import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("native_bridge", Path(__file__).resolve().parents[1] / "native/bridge.py")
bridge = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = bridge
SPEC.loader.exec_module(bridge)


class CapturedOutput:
    def __init__(self):
        self.messages = []
        self.ready = threading.Event()

    def write(self, data):
        self.messages.append(bridge.read_native(io.BytesIO(data)))
        self.ready.set()

    def flush(self):
        pass


TEST_TOKEN = "test-control-token-0123456789-abcdefghijk"
FIXTURE_HOSTS = []


def request(rid="req-1", op="operation-1", session="session-1", method="type_text", token=TEST_TOKEN):
    return {"v": bridge.LOCAL_PROTOCOL, "client": bridge.HOST_RUNTIME, "type": "request", "id": rid, "method": method, "controlToken": token,
            "sessionId": session, "operation_id": op,
            "params": {"snapshotId": "snapshot-1", "text": "Привет, мир 🌍"}}


def control_request(method, token=None, session="session-1", owner="Test task"):
    return {"v": bridge.LOCAL_PROTOCOL, "client": bridge.HOST_RUNTIME, "type": "request", "id": f"{method}-{time.monotonic_ns()}",
            "method": method, "sessionId": session, "controlToken": token,
            "params": {"ownerLabel": owner} if method == "acquire_control" else {}}


def extension_status(session="session-1"):
    return {"attached": session is not None, "sessionId": session,
            "documentId": "fixture" if session else None,
            "runtime": {"extension": {**bridge.HOST_RUNTIME, "protocol": bridge.EXTENSION_PROTOCOL}}}


def scroll_timeout_response(settled, rid="req-1", session="session-1"):
    return {"v": bridge.EXTENSION_PROTOCOL, "type": "response", "id": rid, "sessionId": session,
            "ok": False, "settled": settled,
            "error": {"code": "BROWSER_TIMEOUT", "message": "Wheel acknowledgement is delayed", "outcome": "unknown"}}


def attached_host(path="/unused", stdout=None, timeout=0.5, controlled=True):
    temporary = tempfile.TemporaryDirectory()
    host = bridge.Bridge(path, stdout or CapturedOutput(), timeout=timeout,
                         registry_path=Path(temporary.name) / "registry")
    host.fixture_directory = temporary
    FIXTURE_HOSTS.append(host)
    host.receive({"v": bridge.EXTENSION_PROTOCOL, "type": "hello", "status": extension_status()})
    if controlled:
        result = host.request(control_request("acquire_control", owner="Fixture owner"))
        assert result["ok"], result
        host.control.token = TEST_TOKEN
    return host


class FixtureCase(unittest.TestCase):
    def tearDown(self):
        while FIXTURE_HOSTS:
            host = FIXTURE_HOSTS.pop()
            host.close()
            host.fixture_directory.cleanup()


class NativeTests(FixtureCase):
    def test_diagnostic_log_is_private_bounded_and_redacts_payloads(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "bridge.log"
            log = bridge.DiagnosticLog(path)
            for _ in range(1000):
                log.write("cdp", phase="read_quarantined", method="Page.captureScreenshot", elapsedMs=10000,
                          params={"text": "private script"}, controlToken="secret", files=["/private/photo.png"],
                          reason="raw Chrome error with private path")
            self.assertLessEqual(path.stat().st_size, bridge.DIAG_LIMIT)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            rows = [json.loads(line) for line in path.read_text().splitlines()]
            self.assertTrue(rows)
            self.assertTrue(all(row["phase"] == "read_quarantined" for row in rows))
            self.assertTrue(all(set(row) == {"t", "pid", "event", "phase", "method", "elapsedMs"} for row in rows))
            log.write("cdp", phase="read_cleanup_failed", method="Page.stopScreencast", elapsedMs=10001,
                      params={"data": "private pixels"})
            cleanup = json.loads(path.read_text().splitlines()[-1])
            self.assertEqual(cleanup["phase"], "read_cleanup_failed")
            self.assertEqual(cleanup["method"], "Page.stopScreencast")
            self.assertNotIn("params", cleanup)
            log.write("cdp", phase={}, method="/private/path", elapsedMs=-1)
            log.write({}, reason={})
            self.assertEqual(json.loads(path.read_text().splitlines()[-1])["event"], "cdp")

    def test_diagnostic_log_does_not_follow_links_or_break_host(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "keep"
            target.write_text("untouched")
            linked = Path(root) / "bridge.log"
            linked.symlink_to(target)
            bridge.DiagnosticLog(linked).write("start")
            self.assertEqual(target.read_text(), "untouched")
            linked.unlink()
            os.link(target, linked)
            bridge.DiagnosticLog(linked).write("start")
            self.assertEqual(target.read_text(), "untouched")
            bridge.DiagnosticLog(Path(root) / "missing" / "bridge.log").write("start")

    def test_screenshot_diagnostics_do_not_release_or_rebind_control(self):
        host = attached_host()
        lease = host.control
        host.receive({"v": bridge.EXTENSION_PROTOCOL, "type": "diagnostic", "phase": "read_quarantined", "method": "Page.captureScreenshot", "elapsedMs": 10000,
                      "status": extension_status(None)})
        self.assertIs(host.control, lease)
        self.assertEqual(host.session_id, "session-1")
        self.assertEqual(host.request(control_request("acquire_control", owner="Another agent"))["error"]["code"], "CONTROL_BUSY")

    def test_signal_handler_does_not_reenter_a_diagnostic_write(self):
        callbacks = {}
        calls = []
        lock = threading.Lock()

        class LockedLog:
            def write(self, event, **fields):
                # Raising avoids hanging the test on the baseline's reentrant lock.
                self_test.assertFalse(lock.locked(), "signal handler reentered log lock")
                calls.append((event, fields))

        self_test = self
        def bind(host):
            host.diagnostics = LockedLog()

        def interrupted_read(_):
            with lock:
                callbacks[bridge.signal.SIGTERM](bridge.signal.SIGTERM, None)

        with patch.object(sys, "argv", ["bridge"]), patch.object(bridge.Bridge, "bind", bind), \
             patch.object(bridge.Bridge, "serve"), patch.object(bridge, "read_native", interrupted_read), \
             patch.object(bridge.signal, "signal", lambda signum, callback: callbacks.update({signum: callback})):
            with self.assertRaises(SystemExit) as stopped:
                bridge.main()
        self.assertEqual(stopped.exception.code, 0)
        self.assertEqual(calls, [("exit", {"reason": "sigterm"})])

    def test_runtime_path_matches_with_and_without_xdg_environment(self):
        canonical = f"/run/user/{os.getuid()}"
        expected = Path(canonical) / bridge.PROFILE["socketNamespace"] / "bridge.sock" if bridge.private_runtime_directory(canonical) else Path(f"/tmp/{bridge.PROFILE['socketNamespace']}-{os.getuid()}/bridge.sock")
        self.assertEqual(bridge.default_socket_path({}), expected)
        self.assertEqual(bridge.default_socket_path({"XDG_RUNTIME_DIR": canonical}), expected)

    def test_runtime_selection_rejects_untrusted_directories(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = Path(root) / "runtime"
            runtime.mkdir(mode=0o700)
            self.assertTrue(bridge.private_runtime_directory(runtime))
            self.assertFalse(bridge.private_runtime_directory(runtime, os.getuid() + 1))
            self.assertEqual(bridge.default_socket_path({"XDG_RUNTIME_DIR": str(runtime)}), runtime / bridge.PROFILE["socketNamespace"] / "bridge.sock")
            linked = Path(root) / "linked"
            linked.symlink_to(runtime, target_is_directory=True)
            self.assertFalse(bridge.private_runtime_directory(linked))
            runtime.chmod(0o770)
            self.assertFalse(bridge.private_runtime_directory(runtime))
            self.assertEqual(bridge.default_socket_path({"XDG_RUNTIME_DIR": str(runtime)}), bridge.default_socket_path({}))
            self.assertFalse(bridge.private_runtime_directory("relative"))

    def test_missing_linux_runtime_keeps_private_tmp_fallback(self):
        with patch.object(bridge, "private_runtime_directory", return_value=False):
            self.assertEqual(bridge.default_socket_path({}), Path(f"/tmp/{bridge.PROFILE['socketNamespace']}-{os.getuid()}/bridge.sock"))
        self.assertEqual(bridge.default_socket_path({"VIDS_STUDIO_SOCKET": "/private/custom.sock"}), Path("/private/custom.sock"))

    def test_registry_default_is_persistent_and_ignores_runtime_location(self):
        with patch.object(bridge.Path, "home", return_value=Path("/fixture-home")):
            self.assertEqual(bridge.default_registry_path({}), Path("/fixture-home/.local/state/vids-studio/coordinator"))
            self.assertEqual(bridge.default_registry_path({"XDG_RUNTIME_DIR": "/temporary/runtime"}), Path("/fixture-home/.local/state/vids-studio/coordinator"))
        self.assertEqual(bridge.default_registry_path({"XDG_STATE_HOME": "/private/state"}), Path("/private/state/vids-studio/coordinator"))
        self.assertEqual(bridge.default_registry_path({"VIDS_STUDIO_REGISTRY_DIR": "/isolated/registry", "XDG_STATE_HOME": "/private/state"}), Path("/isolated/registry"))

    def test_relative_state_home_is_not_replaced_with_empty_volatile_registry(self):
        registry = bridge.Coordinator(bridge.default_registry_path({"XDG_STATE_HOME": "relative"}))
        with self.assertRaises(bridge.CoordinationError) as caught:
            registry.status("fixture")
        self.assertEqual(caught.exception.code, "COORDINATOR_UNAVAILABLE")

    def test_native_framing_preserves_utf8_and_reads_multiple_messages(self):
        payload = {"text": "Русский язык 🎥"}
        data = bridge.encode_native(payload)
        self.assertEqual(struct.unpack("=I", data[:4])[0], len(data) - 4)
        stream = io.BytesIO(data + data)
        self.assertEqual(bridge.read_native(stream), payload)
        self.assertEqual(bridge.read_native(stream), payload)
        with self.assertRaises(EOFError):
            bridge.read_native(stream)

    def test_malformed_truncated_and_oversized_frames_rejected(self):
        for raw in (struct.pack("=I", 0), struct.pack("=I", bridge.MAX_NATIVE + 1),
                    struct.pack("=I", 5), struct.pack("=I", 5) + b"{", struct.pack("=I", 2) + b"[]",
                    struct.pack("=I", 1) + b"\xff"):
            with self.assertRaises((ValueError, UnicodeError)):
                bridge.read_native(io.BytesIO(raw))

    def test_mutations_deduplicate_and_bind_session_method_payload(self):
        output = CapturedOutput()
        host = attached_host(stdout=output)
        results = []
        thread = threading.Thread(target=lambda: results.append(host.request(request())))
        thread.start()
        self.assertTrue(output.ready.wait(0.3))
        retry = threading.Thread(target=lambda: results.append(host.request(request(rid="req-2"))))
        retry.start()
        self.assertEqual(host.request(request(rid="req-3", session="another-session"))["error"]["code"], "SESSION_MISMATCH")
        changed = request(rid="req-4")
        changed["params"]["text"] = "Другой текст"
        self.assertEqual(host.request(changed)["error"]["code"], "OPERATION_ID_CONFLICT")
        self.assertEqual(host.request(request(rid="req-5", method="click"))["error"]["code"], "OPERATION_ID_CONFLICT")
        host.receive({"v": bridge.EXTENSION_PROTOCOL, "type": "response", "id": "req-1", "ok": True, "result": {"performed": True}})
        thread.join()
        retry.join()
        self.assertEqual(len(output.messages), 1)
        self.assertTrue(all(r["ok"] for r in results))
        self.assertEqual(sorted(r["receipt"]["replayed"] for r in results), [False, True])
        self.assertTrue(host.request(request(rid="req-6"))["receipt"]["replayed"])

    def test_timeout_unknown_is_cached_and_not_replayed(self):
        output = CapturedOutput()
        host = attached_host(stdout=output, timeout=0.02)
        response = host.request(request())
        self.assertEqual(response["error"]["outcome"], "unknown")
        self.assertEqual(response["error"]["code"], "TIMEOUT")
        retry = host.request(request(rid="req-2"))
        self.assertEqual(retry["error"]["outcome"], "unknown")
        self.assertEqual(len(output.messages), 1)
        # A late response cannot silently replace an already-delivered unknown receipt.
        host.receive({"v": bridge.EXTENSION_PROTOCOL, "type": "response", "id": "req-1", "ok": True, "result": {"performed": True}})
        self.assertEqual(host.request(request(rid="req-3"))["error"]["outcome"], "unknown")

    def test_picker_upload_is_a_leased_mutation_and_preserves_uncertain_receipt(self):
        host = attached_host()
        command = request(method="upload_via_picker")
        command["params"] = {"snapshotId": "snapshot-1", "nodeRef": "n-upload", "files": ["/media/русский.png"]}
        results = []
        thread = threading.Thread(target=lambda: results.append(host.request(command)))
        thread.start()
        self.assertTrue(host.stdout.ready.wait(0.3))
        self.assertEqual(host.stdout.messages[0]["method"], "upload_via_picker")
        self.assertEqual(host.control.inflight, 1)
        host.receive({"v": bridge.EXTENSION_PROTOCOL, "type": "response", "id": "req-1", "ok": False,
                      "error": {"code": "FILE_CHOOSER_TIMEOUT", "message": "Chooser did not complete", "outcome": "unknown"}})
        thread.join()
        self.assertEqual(results[0]["error"]["code"], "FILE_CHOOSER_TIMEOUT")
        self.assertEqual(results[0]["error"]["outcome"], "unknown")
        retry = host.request({**command, "id": "req-2"})
        self.assertTrue(retry["receipt"]["replayed"])
        self.assertEqual(len(host.stdout.messages), 1)
        self.assertEqual(host.control.inflight, 0)
        self.assertEqual(host.request({**command, "id": "req-3", "controlToken": None})["error"]["code"], "CONTROL_BUSY")

    def test_disconnect_completes_pending_with_unknown(self):
        output = CapturedOutput()
        host = attached_host(stdout=output)
        results = []
        thread = threading.Thread(target=lambda: results.append(host.request(request())))
        thread.start()
        output.ready.wait(0.3)
        host.close()
        thread.join()
        self.assertEqual(results[0]["error"]["code"], "DISCONNECTED")
        self.assertEqual(results[0]["error"]["outcome"], "unknown")

    def test_request_limits_and_session_validation(self):
        host = attached_host(timeout=0.01)
        for req in ([1], {**request(), "method": "execute"}, {**request(), "sessionId": None}, {**request(), "operation_id": ""}):
            with self.assertRaises(ValueError):
                host.request(req)

    def test_receipt_cache_is_bounded_without_evicting_known_operations(self):
        host = attached_host(timeout=0.001)
        host.receipts = {f"old-{i}": bridge.Pending(f"req-{i}", "fingerprint", True) for i in range(bridge.CACHE_LIMIT)}
        response = host.request(request())
        self.assertEqual(response["error"]["code"], "RECEIPT_CACHE_FULL")
        self.assertEqual(response["error"]["outcome"], "not_performed")
        self.assertEqual(len(host.receipts), bridge.CACHE_LIMIT)

    def test_private_socket_refuses_second_owner_and_symlink(self):
        with tempfile.TemporaryDirectory() as root:
            endpoint = Path(root) / "bridge" / "bridge.sock"
            host = bridge.Bridge(endpoint)
            host.bind()
            self.assertEqual(endpoint.stat().st_mode & 0o777, 0o600)
            self.assertEqual(endpoint.parent.stat().st_mode & 0o777, 0o700)
            with self.assertRaises(FileExistsError):
                bridge.Bridge(endpoint).bind()
            host.close()
            self.assertFalse(endpoint.exists())
            victim = Path(root) / "victim"
            victim.write_text("keep")
            endpoint.symlink_to(victim)
            with self.assertRaises(FileExistsError):
                bridge.Bridge(endpoint).bind()
            self.assertEqual(victim.read_text(), "keep")
            self.assertTrue(endpoint.is_symlink())

    def test_cleanup_does_not_unlink_replaced_inode(self):
        with tempfile.TemporaryDirectory() as root:
            endpoint = Path(root) / "bridge" / "bridge.sock"
            host = bridge.Bridge(endpoint)
            host.bind()
            endpoint.unlink()
            endpoint.write_text("replacement")
            host.close()
            self.assertEqual(endpoint.read_text(), "replacement")

    def test_socket_unicode_roundtrip(self):
        with tempfile.TemporaryDirectory() as root:
            endpoint = Path(root) / "bridge" / "bridge.sock"
            output = CapturedOutput()
            host = attached_host(endpoint, output)
            host.bind()
            server = threading.Thread(target=host.serve)
            server.start()
            client = socket.socket(socket.AF_UNIX)
            client.settimeout(1)
            client.connect(str(endpoint))
            client.sendall(json.dumps(request(), ensure_ascii=False).encode() + b"\n")
            self.assertTrue(output.ready.wait(0.3))
            self.assertEqual(output.messages[0]["params"]["text"], "Привет, мир 🌍")
            host.receive({"v": bridge.EXTENSION_PROTOCOL, "type": "response", "id": "req-1", "ok": True, "result": {"title": "Видео"}})
            response = json.loads(client.makefile("rb").readline())
            self.assertEqual(response["result"]["title"], "Видео")
            self.assertEqual(response["id"], "req-1")
            client.close()
            host.close()
            server.join()

    def test_actual_native_host_process_connects_and_cleans_socket_on_eof(self):
        with tempfile.TemporaryDirectory() as root:
            endpoint = Path(root) / "bridge" / "bridge.sock"
            process = subprocess.Popen([sys.executable, str(Path(bridge.__file__)), "--socket", str(endpoint), "--registry", str(Path(root) / "registry"), "chrome-extension://fixture/"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            client = socket.socket(socket.AF_UNIX)
            client.settimeout(2)
            try:
                deadline = time.monotonic() + 2
                while not endpoint.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                process.stdin.write(bridge.encode_native({"v": bridge.EXTENSION_PROTOCOL, "type": "hello", "status": extension_status()}))
                process.stdin.flush()
                time.sleep(0.02)
                acquire = socket.socket(socket.AF_UNIX)
                acquire.settimeout(2)
                acquire.connect(str(endpoint))
                acquire.sendall(json.dumps(control_request("acquire_control")).encode() + b"\n")
                reader = acquire.makefile("rb")
                try:
                    control = json.loads(reader.readline())
                finally:
                    reader.close()
                    acquire.close()
                self.assertTrue(control["ok"], control)
                client.connect(str(endpoint))
                client.sendall(json.dumps(request(token=control["result"]["controlToken"]), ensure_ascii=False).encode() + b"\n")
                forwarded = bridge.read_native(process.stdout)
                self.assertEqual(forwarded["params"]["text"], "Привет, мир 🌍")
                process.stdin.write(bridge.encode_native({"v": bridge.EXTENSION_PROTOCOL, "type": "response", "id": forwarded["id"], "ok": True, "result": {"performed": True}}))
                process.stdin.flush()
                reader = client.makefile("rb")
                try:
                    receipt = json.loads(reader.readline())
                finally:
                    reader.close()
                self.assertTrue(receipt["ok"])
                process.stdin.close()
                self.assertEqual(process.wait(timeout=2), 0)
                self.assertFalse(endpoint.exists())
            finally:
                client.close()
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=2)
                process.stdout.close()
                process.stderr.close()
                if not process.stdin.closed:
                    process.stdin.close()


class ControlTests(FixtureCase):
    def test_concurrent_acquire_has_one_owner_and_no_browser_commands(self):
        host = attached_host(controlled=False)
        gate = threading.Barrier(3)
        results = []
        def acquire(owner):
            gate.wait()
            results.append(host.request(control_request("acquire_control", owner=owner)))
        threads = [threading.Thread(target=acquire, args=(owner,)) for owner in ("Task A", "Task B")]
        for thread in threads:
            thread.start()
        gate.wait()
        for thread in threads:
            thread.join()
        self.assertEqual(sum(result["ok"] for result in results), 1)
        self.assertEqual(next(result for result in results if not result["ok"])["error"]["code"], "CONTROL_BUSY")
        token = next(result for result in results if result["ok"])["result"]["controlToken"]
        self.assertGreaterEqual(len(token), 32)
        self.assertEqual(host.stdout.messages, [])

    def test_observation_and_mutation_require_current_owner_before_replay(self):
        host = attached_host(controlled=False)
        for method in ("observe", "screenshot", "type_text", "upload_via_picker"):
            self.assertEqual(host.request(request(method=method, token=None))["error"]["code"], "CONTROL_REQUIRED")
        token = host.request(control_request("acquire_control"))["result"]["controlToken"]
        for method in ("observe", "screenshot", "type_text", "upload_via_picker"):
            self.assertEqual(host.request(request(method=method, token=TEST_TOKEN))["error"]["code"], "CONTROL_BUSY")
        self.assertEqual(host.request(request(token=token, session="other-session"))["error"]["code"], "SESSION_MISMATCH")
        self.assertEqual(host.stdout.messages, [])
        # Even knowing a prior operation id must not reveal its cached receipt.
        cached = bridge.Pending("prior", "irrelevant", True)
        cached.response = {"ok": True, "result": {"performed": True}}
        cached.done.set()
        host.receipts["operation-1"] = cached
        self.assertEqual(host.request(request(token=None))["error"]["code"], "CONTROL_BUSY")

    def test_unknown_inflight_prevents_release_and_expiry_takeover_until_settled(self):
        host = attached_host(timeout=0.01)
        result = host.request(request())
        self.assertEqual(result["error"]["outcome"], "unknown")
        self.assertEqual(host.control.inflight, 1)
        self.assertEqual(host.request(control_request("release_control", TEST_TOKEN))["error"]["code"], "CONTROL_IN_FLIGHT")
        host.control.renewed -= bridge.CONTROL_TTL + 1
        self.assertEqual(host.request(control_request("acquire_control", owner="Task B"))["error"]["code"], "CONTROL_BUSY")
        host.receive({"v": bridge.EXTENSION_PROTOCOL, "type": "response", "id": "req-1", "ok": True, "result": {"performed": True}})
        self.assertEqual(host.control.inflight, 0)
        self.assertEqual(host.receipts["operation-1"].response["error"]["outcome"], "unknown")
        host.control.renewed -= bridge.CONTROL_TTL + 1
        next_owner = host.request(control_request("acquire_control", owner="Task B"))
        self.assertTrue(next_owner["ok"])
        self.assertNotEqual(next_owner["result"]["controlToken"], TEST_TOKEN)
        self.assertEqual(host.request(request())["error"]["code"], "CONTROL_BUSY")

    def test_scroll_timeout_keeps_control_and_blocks_mutations_until_late_settlement_and_reconciliation(self):
        host = attached_host(timeout=1)
        lease = host.control
        results = []
        thread = threading.Thread(target=lambda: results.append(host.request(request(method="scroll"))))
        thread.start()
        self.assertTrue(host.stdout.ready.wait(0.3))
        host.receive(scroll_timeout_response(False))
        thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(results[0]["error"]["code"], "BROWSER_TIMEOUT")
        self.assertEqual(results[0]["error"]["outcome"], "unknown")
        self.assertIs(host.control, lease)
        self.assertEqual((host.session_id, lease.token, lease.inflight), ("session-1", TEST_TOKEN, 1))
        self.assertEqual(host.coordinator.status("fixture")["unknownOperations"][0]["state"], "pending")
        self.assertTrue(host.request(control_request("renew_control", TEST_TOKEN))["ok"])
        for method in ("reconcile_control", "release_control"):
            self.assertEqual(host.request(control_request(method, TEST_TOKEN))["error"]["code"], "CONTROL_IN_FLIGHT")
        self.assertEqual(host.request(request(rid="next", op="next-operation"))["error"]["code"], "CONTROL_IN_FLIGHT")
        replay = host.request(request(rid="retry", method="scroll"))
        self.assertTrue(replay["receipt"]["replayed"])
        self.assertEqual(replay["error"]["outcome"], "unknown")
        self.assertEqual(len(host.stdout.messages), 1, "no second wheel or mutation reaches Chrome")

        # Read-only inspection can proceed while the original wheel is pending.
        host.stdout.ready.clear()
        observed = []
        reader = threading.Thread(target=lambda: observed.append(host.request(request(rid="read", method="observe"))))
        reader.start()
        self.assertTrue(host.stdout.ready.wait(0.3))
        host.receive({"v": bridge.EXTENSION_PROTOCOL, "type": "response", "id": "read", "ok": True,
                      "result": {"snapshotId": "new-observation"}})
        reader.join(1)
        self.assertFalse(reader.is_alive())
        self.assertTrue(observed[0]["ok"])
        self.assertEqual(lease.inflight, 1)

        host.receive(scroll_timeout_response(True))
        self.assertIs(host.control, lease)
        self.assertEqual(lease.inflight, 0)
        self.assertNotIn("req-1", host.pending)
        state = host.coordinator.status("fixture")
        self.assertEqual(state["state"], "reconcile")
        operation = state["unknownOperations"][0]
        self.assertEqual((operation["state"], operation["initial_outcome"], operation["latest_outcome"]),
                         ("unknown", "unknown", "unknown"))
        self.assertEqual(host.request(request(rid="after", op="after-operation"))["error"]["code"], "RECONCILIATION_REQUIRED")
        reconcile = control_request("reconcile_control", TEST_TOKEN)
        self.assertEqual(host.request(reconcile)["error"]["code"], "RECONCILIATION_EVIDENCE_REQUIRED")
        reconcile["params"] = {"acknowledgeUnknown": True, "evidence": "Inspected the current timeline; retaining the uncertain prior scroll outcome"}
        self.assertTrue(host.request(reconcile)["ok"])
        self.assertEqual(lease.coordinator_lease.mode, "write")
        replay = host.request(request(rid="retry-after", method="scroll"))
        self.assertTrue(replay["receipt"]["replayed"])
        self.assertEqual(replay["error"]["outcome"], "unknown")
        self.assertEqual(len(host.stdout.messages), 2, "inspection is the only additional browser request")
        self.assertTrue(host.request(control_request("release_control", TEST_TOKEN))["ok"])

    def test_invalid_or_stale_scroll_settlements_cannot_release_quarantine(self):
        host = attached_host(timeout=1)
        result = []
        thread = threading.Thread(target=lambda: result.append(host.request(request(method="scroll"))))
        thread.start()
        self.assertTrue(host.stdout.ready.wait(0.3))
        host.receive(scroll_timeout_response(False))
        thread.join(1)
        self.assertFalse(thread.is_alive())
        pending = host.pending["req-1"]
        valid = scroll_timeout_response(True)
        invalid = [
            {**valid, "settled": "true"}, {**valid, "settled": 1}, {**valid, "settled": None},
            {key: value for key, value in valid.items() if key != "settled"},
            {**valid, "sessionId": "another-session"},
            {key: value for key, value in valid.items() if key != "sessionId"},
            {**valid, "ok": True, "result": {"performed": True}},
            {**valid, "error": {**valid["error"], "code": "OTHER_ERROR"}},
            {**valid, "error": {**valid["error"], "outcome": "not_performed"}},
            {**valid, "error": None}, {**valid, "id": "another-request"},
        ]
        for message in invalid:
            with self.subTest(message=message):
                host.receive(message)
                self.assertIs(host.pending["req-1"], pending)
                self.assertEqual(host.control.inflight, 1)
                self.assertEqual(host.coordinator.status("fixture")["unknownOperations"][0]["state"], "pending")
        # A stale binding's late result cannot authorize the current generation.
        host.binding_generation += 1
        host.receive(valid)
        self.assertIs(host.pending["req-1"], pending)
        self.assertEqual(host.control.inflight, 1)
        self.assertEqual(host.request(control_request("reconcile_control", TEST_TOKEN))["error"]["code"], "CONTROL_IN_FLIGHT")

    def test_scroll_settlement_before_timeout_receipt_preserves_unknown_without_resurrecting_pending(self):
        host = attached_host(timeout=1)
        results = []
        thread = threading.Thread(target=lambda: results.append(host.request(request(method="scroll"))))
        thread.start()
        self.assertTrue(host.stdout.ready.wait(0.3))
        # Chrome can settle between the timer firing and the first receipt being posted.
        host.receive(scroll_timeout_response(True))
        thread.join(1)
        self.assertFalse(thread.is_alive())
        host.receive(scroll_timeout_response(False))
        host.receive(scroll_timeout_response(True))
        self.assertEqual(host.pending, {})
        self.assertEqual(host.control.inflight, 0)
        self.assertEqual(results[0]["error"]["outcome"], "unknown")
        self.assertEqual(host.coordinator.status("fixture")["state"], "reconcile")
        self.assertEqual(host.request(request(rid="retry", method="scroll"))["error"]["outcome"], "unknown")
        self.assertEqual(len(host.stdout.messages), 1)

    def test_explicit_scroll_settlement_cannot_complete_another_method_or_unsent_request(self):
        for method in ("type_text", "observe", "scroll"):
            with self.subTest(method=method):
                host = attached_host(timeout=1)
                results = []
                thread = threading.Thread(target=lambda: results.append(host.request(request(method=method))))
                thread.start()
                self.assertTrue(host.stdout.ready.wait(0.3))
                pending = host.pending["req-1"]
                if method == "scroll":
                    pending.sent = False
                host.receive(scroll_timeout_response(True))
                self.assertFalse(pending.done.is_set())
                self.assertEqual(host.control.inflight, 1)
                pending.sent = True
                # Legacy responses retain their existing completion semantics.
                host.receive({"v": bridge.EXTENSION_PROTOCOL, "type": "response", "id": "req-1", "ok": True, "result": {}})
                thread.join(1)
                self.assertFalse(thread.is_alive())
                self.assertTrue(results[0]["ok"])
                self.assertEqual(host.control.inflight, 0)

    def test_owner_renew_and_release_cannot_be_used_by_other_task(self):
        host = attached_host()
        host.control.renewed -= 100
        self.assertEqual(host.request(control_request("renew_control", "wrong-token"))["error"]["code"], "CONTROL_BUSY")
        self.assertGreater(time.monotonic() - host.control.renewed, 99)
        self.assertTrue(host.request(control_request("renew_control", TEST_TOKEN))["ok"])
        self.assertLess(time.monotonic() - host.control.renewed, 1)
        self.assertEqual(host.request(control_request("release_control", "wrong-token"))["error"]["code"], "CONTROL_BUSY")
        self.assertTrue(host.request(control_request("release_control", TEST_TOKEN))["ok"])
        self.assertEqual(host.request(request())["error"]["code"], "CONTROL_REQUIRED")
        next_owner = host.request(control_request("acquire_control", owner="Task B"))
        self.assertTrue(next_owner["ok"])
        self.assertEqual(host.request(control_request("renew_control", TEST_TOKEN))["error"]["code"], "CONTROL_BUSY")

    def test_status_is_public_and_never_discloses_token(self):
        host = attached_host()
        result = []
        thread = threading.Thread(target=lambda: result.append(host.request({"v": bridge.LOCAL_PROTOCOL, "client": bridge.HOST_RUNTIME, "type": "request", "id": "status-1", "method": "status", "params": {}})))
        thread.start()
        self.assertTrue(host.stdout.ready.wait(0.3))
        host.receive({"v": bridge.EXTENSION_PROTOCOL, "type": "response", "id": "status-1", "ok": True,
                      "result": extension_status()})
        thread.join()
        self.assertTrue(result[0]["ok"])
        self.assertTrue(result[0]["result"]["control"]["held"])
        self.assertEqual(result[0]["result"]["control"]["ownerLabel"], "Fixture owner")
        self.assertNotIn(TEST_TOKEN, json.dumps(result))
        self.assertEqual(host.control.inflight, 0)

    def test_session_change_clears_control_and_unsettled_old_requests(self):
        host = attached_host(timeout=0.01)
        host.request(request())
        host.receive({"v": bridge.EXTENSION_PROTOCOL, "type": "event", "event": "attached", "status": extension_status("session-2"), "fenceReceipts": [{"fenced": True, "profileId": bridge.PROFILE["id"], "sessionId": "session-1", "documentId": "fixture"}]})
        self.assertIsNone(host.control)
        self.assertEqual(len(host.pending), 0)
        self.assertEqual(host.request(request())["error"]["code"], "SESSION_MISMATCH")
        self.assertTrue(host.request(control_request("acquire_control", session="session-2"))["ok"])
        host.receive({"v": bridge.EXTENSION_PROTOCOL, "type": "event", "event": "detached", "status": extension_status(None)})
        self.assertIsNone(host.control)
        self.assertIsNone(host.session_id)

    def test_legacy_protocol_and_missing_owner_token_fail_before_forwarding(self):
        host = attached_host()
        self.assertEqual(host.request({**request(), "v": 1})["error"]["code"], "RECONNECT_REQUIRED")
        missing = request()
        del missing["controlToken"]
        self.assertEqual(host.request(missing)["error"]["code"], "CONTROL_BUSY")
        self.assertEqual(host.stdout.messages, [])


if __name__ == "__main__":
    unittest.main()
