"""Isolated fleet tests. No Chrome/user profiles or installed runtime endpoints."""
import concurrent.futures
import importlib.util
import io
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("fleet_bridge_fixture", ROOT / "native/bridge.py")
bridge = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = bridge
SPEC.loader.exec_module(bridge)
from fleet import FleetRegistry, adaptive_limit, governor_view
from coordinator import CoordinationError


class FixedResources:
    def __init__(self, **values):
        self.values = {"cpuPercent": 10, "memoryAvailableBytes": 8 * 1024**3,
                       "memoryTotalBytes": 16 * 1024**3, "pressure": {}, "gpu": None, **values}

    def sample(self):
        return self.values


class Output:
    def __init__(self):
        self.messages = []

    def write(self, data):
        self.messages.append(bridge.read_native(io.BytesIO(data)))

    def flush(self):
        pass


class FleetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.fleet = FleetRegistry(self.root / "fleet", resources=FixedResources())
        self.hosts = []

    def tearDown(self):
        for host in self.hosts:
            host.close()
        self.tmp.cleanup()

    def register(self, document=None, profile="codex"):
        session, browser = str(uuid.uuid4()), str(uuid.uuid4())
        ticket = secrets.token_hex(32)
        instance = self.fleet.register(session, profile, document or "document-" + session,
            browser, self.root / "sessions" / (session + ".sock"), ticket, {"host": {"profileId": profile}})
        self.fleet.heartbeat(session, instance)
        return session, ticket, instance

    def claim_params(self, session, ticket):
        doc = next(s["documentId"] for s in self.fleet.snapshot()["sessions"] if s["sessionId"] == session)
        return {"bindingId": str(uuid.uuid4()), "bindingToken": secrets.token_urlsafe(32),
                "intentId": str(uuid.uuid4()), "pairingTicket": ticket, "expectedDocumentId": doc,
                "ownerLabel": "Independent test task"}

    def host(self):
        session = str(uuid.uuid4())
        output = Output()
        host = bridge.Bridge(self.root / "sessions" / (session + ".sock"), output,
                             timeout=.1, registry_path=self.root / "coordinator")
        hello = {"v": bridge.EXTENSION_PROTOCOL, "type": "hello", "fleet": {
            "browserInstanceId": str(uuid.uuid4()), "pairingTicket": secrets.token_hex(32)}, "status": {
            "attached": True, "sessionId": session, "documentId": "document-" + session,
            "runtime": {"extension": {**bridge.HOST_RUNTIME, "protocol": bridge.EXTENSION_PROTOCOL}}, "capabilities": ["observe", "screenshot"]}}
        host.receive(hello)
        host.enable_fleet(hello, self.fleet)
        self.hosts.append(host)
        params = self.claim_params(session, hello["fleet"]["pairingTicket"])
        self.assertTrue(host.request(self.request(host, "claim_attachment", params))["ok"])
        acquired = host.request(self.request(host, "acquire_control", params))
        self.assertTrue(acquired["ok"], acquired)
        return host, acquired["result"]["controlToken"], params

    def request(self, host, method, params=None, token=None):
        return {"v": bridge.LOCAL_PROTOCOL, "client": bridge.HOST_RUNTIME,
                "type": "request", "id": str(uuid.uuid4()), "sessionId": host.session_id,
                "method": method, "params": params or {}, "controlToken": token,
                "operation_id": str(uuid.uuid4())}

    def test_ten_independent_workers_dispatch_concurrently_and_preserve_tokens(self):
        fleet = [self.host() for _ in range(10)]
        # Warm the shared controller with measured healthy samples; attaching
        # ten workers must not itself bypass the conservative startup ramp.
        now = time.time()
        for step in range(1, 9):
            self.fleet.clock = lambda step=step: now + step * 11
            self.fleet.heartbeat(fleet[0][0].fleet_session, fleet[0][0].fleet_instance)
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
            futures = []
            for host, token, _ in fleet:
                host.timeout = 2
                request = self.request(host, "observe", token=token)
                futures.append((host, request, executor.submit(host.request, request)))
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline and self.fleet.snapshot()["summary"]["pending"] < 10:
                time.sleep(.01)
            self.assertEqual(self.fleet.snapshot()["summary"]["pending"], 10)
            for host, request, future in reversed(futures):
                host.receive({"v": bridge.EXTENSION_PROTOCOL, "type": "response", "id": request["id"], "ok": True,
                              "result": {"snapshotId": host.session_id + "-snapshot"}})
                self.assertEqual(future.result()["result"]["snapshotId"], host.session_id + "-snapshot")
        host, _, _ = fleet[0]
        denied = host.request(self.request(host, "observe", token=fleet[1][1]))
        self.assertEqual(denied["error"]["code"], "CONTROL_BUSY")
        self.assertEqual(self.fleet.snapshot()["summary"]["pending"], 0)
        self.assertEqual(len({h.control.token for h, _, _ in fleet}), 10)

    def test_claim_is_idempotent_without_persisting_or_disclosing_secrets(self):
        session, ticket, _ = self.register()
        params = self.claim_params(session, ticket)
        self.assertEqual(self.fleet.claim(session, params), self.fleet.claim(session, params))
        snapshot = json.dumps(self.fleet.snapshot())
        disk = self.fleet.path.read_bytes()
        for secret in (ticket, params["bindingToken"]):
            self.assertNotIn(secret, snapshot)
            self.assertNotIn(secret.encode(), disk)
        self.assertNotIn("endpoint", snapshot)
        self.assertNotIn(str(self.root), snapshot)

    def test_duplicate_document_claim_is_exclusive_across_profiles(self):
        first, ticket1, _ = self.register("shared-document", "codex")
        second, ticket2, _ = self.register("shared-document", "claude")
        self.fleet.claim(first, self.claim_params(first, ticket1))
        with self.assertRaises(CoordinationError) as denied:
            self.fleet.claim(second, self.claim_params(second, ticket2))
        self.assertEqual(denied.exception.code, "DOCUMENT_ALREADY_BOUND")

    def test_writer_expiry_does_not_transfer_task_binding(self):
        host, token, params = self.host()
        host.control.renewed -= bridge.CONTROL_TTL + 1
        self.assertFalse(host.request(self.request(host, "status"))["result"]["control"]["held"])
        self.assertEqual(self.fleet.authorize(host.session_id, params)["bindingId"], params["bindingId"])
        acquire = host.request(self.request(host, "acquire_control", {"ownerLabel": "other", "expectedDocumentId": host.document_id,
            "bindingId": str(uuid.uuid4()), "bindingToken": secrets.token_urlsafe(32)}))
        self.assertEqual(acquire["error"]["code"], "BINDING_REQUIRED")

    def test_dead_heartbeat_does_not_release_document_or_unsettled_capture(self):
        session, ticket, instance = self.register()
        params = self.claim_params(session, ticket)
        self.fleet.claim(session, params)
        self.fleet.admit(session, "capture", "screenshot")
        self.fleet.clock = lambda: time.time() + 10000
        row = self.fleet.snapshot()["sessions"][0]
        self.assertEqual(row["state"], "stale")
        self.assertEqual(row["pending"], 1)
        self.fleet.detached(session, instance)
        self.assertEqual(self.fleet.snapshot()["summary"]["pending"], 1)
        self.assertEqual(self.fleet.authorize(session, params)["bindingId"], params["bindingId"])

    def test_resume_requires_same_document_owner_new_ticket_and_confirmed_fence(self):
        old, ticket, _ = self.register("resumed-document")
        params = self.claim_params(old, ticket)
        self.fleet.claim(old, params)
        new, next_ticket, _ = self.register("resumed-document")
        with self.assertRaises(CoordinationError) as denied:
            self.fleet.resume(new, {**params, "pairingTicket": next_ticket})
        self.assertEqual(denied.exception.code, "COORDINATOR_FENCE_REQUIRED")
        self.fleet.record_fences("codex", [{"fenced": True, "profileId": "codex", "sessionId": old, "documentId": "resumed-document"}])
        with self.assertRaises(CoordinationError):
            self.fleet.resume(new, params)
        result = self.fleet.resume(new, {**params, "pairingTicket": next_ticket})
        self.assertEqual(result["sessionId"], new)
        with self.assertRaises(CoordinationError):
            self.fleet.authorize(old, params)

    def test_pause_preserves_inflight_and_keeps_status_and_observe_available(self):
        host, token, _ = self.host()
        self.fleet.admit(host.session_id, "inflight", "screenshot")
        self.fleet.control({"action": "pause", "sessionId": host.session_id})
        self.assertTrue(host.request(self.request(host, "status"))["ok"])
        with self.assertRaises(CoordinationError) as denied:
            self.fleet.admit(host.session_id, "next", "click")
        self.assertEqual(denied.exception.code, "FLEET_PAUSED")
        self.fleet.admit(host.session_id, "observe", "observe")
        self.assertEqual(self.fleet.snapshot()["summary"]["pending"], 2)
        self.fleet.control({"action": "resume", "sessionId": host.session_id})
        self.assertEqual(self.fleet.snapshot()["summary"]["pending"], 2)

    def test_real_measurements_drive_admission_without_invented_gpu_or_cpu(self):
        session, _, _ = self.register()
        self.fleet.control({"action": "set_limits", "maxConcurrency": 1})
        self.fleet.admit(session, "first", "screenshot")
        with self.assertRaises(CoordinationError) as denied:
            self.fleet.admit(session, "second", "observe")
        self.assertEqual(denied.exception.code, "FLEET_BUSY")
        self.fleet.diagnostic(session, "read_quarantined", "Page.startScreencast")
        self.assertEqual(self.fleet.snapshot()["summary"]["pending"], 1)
        self.fleet.diagnostic(session, "read_resolved", "Page.startScreencast")
        self.assertEqual(self.fleet.snapshot()["summary"]["pending"], 0)

    def test_adaptive_governor_ramps_slowly_and_reduces_without_fake_telemetry(self):
        policy = {"maxConcurrency": 10, "paused": False}
        sample = {**FixedResources().sample(), "measuredAt": 100}
        state = adaptive_limit(policy, sample, {}, 100)
        self.assertEqual(state["effectiveConcurrency"], 2)
        for now in (101, 102, 109):
            state = adaptive_limit(policy, {**sample, "measuredAt": now}, state, now)
            self.assertEqual(state["effectiveConcurrency"], 2)
        state = adaptive_limit(policy, {**sample, "measuredAt": 110}, state, 110)
        self.assertEqual(state["effectiveConcurrency"], 3)
        state = adaptive_limit(policy, {**sample, "measuredAt": 120}, state, 120)
        self.assertEqual(state["effectiveConcurrency"], 4)
        state = adaptive_limit(policy, {**sample, "cpuPercent": 97, "measuredAt": 121}, state, 121)
        self.assertEqual(state["effectiveConcurrency"], 2)
        for _ in range(3):
            self.assertEqual(governor_view(policy, {**sample, "cpuPercent": 97, "measuredAt": 121}, state, 121)["effectiveConcurrency"], 2,
                "read-only status must not repeatedly halve capacity")
        state = adaptive_limit(policy, {**sample, "measuredAt": 122}, state, 122)
        self.assertEqual(state["effectiveConcurrency"], 2, "one healthy sample must not erase a pressure cooldown")
        unknown = adaptive_limit(policy, {"measuredAt": 122, "cpuPercent": None}, {**state, "effectiveConcurrency": 8}, 122)
        self.assertEqual(unknown["effectiveConcurrency"], 2)
        self.assertFalse(unknown["telemetryAvailable"])
        stale = adaptive_limit(policy, sample, {**state, "effectiveConcurrency": 8}, 200)
        self.assertEqual(stale["effectiveConcurrency"], 2)
        self.assertEqual(stale["reason"], "telemetry_stale")

    def test_screenshot_timeout_keeps_permit_until_actual_read_settlement(self):
        host, token, _ = self.host()
        request = self.request(host, "screenshot", token=token)
        with concurrent.futures.ThreadPoolExecutor() as executor:
            pending = executor.submit(host.request, request)
            deadline = time.monotonic() + 1
            while request["id"] not in host.pending and time.monotonic() < deadline:
                time.sleep(.005)
            host.receive({"v": bridge.EXTENSION_PROTOCOL, "type": "diagnostic", "phase": "read_quarantined", "method": "Page.startScreencast"})
            host.receive({"v": bridge.EXTENSION_PROTOCOL, "type": "response", "id": request["id"], "ok": False,
                "error": {"code": "BROWSER_TIMEOUT", "message": "fixture timeout"}})
            self.assertEqual(pending.result()["error"]["code"], "BROWSER_TIMEOUT")
        self.assertEqual(self.fleet.snapshot()["summary"]["pending"], 1)
        host.receive({"v": bridge.EXTENSION_PROTOCOL, "type": "diagnostic", "phase": "read_cleanup_failed", "method": "Page.stopScreencast"})
        self.assertEqual(self.fleet.snapshot()["summary"]["pending"], 1)
        host.receive({"v": bridge.EXTENSION_PROTOCOL, "type": "diagnostic", "phase": "read_resolved", "method": "Page.startScreencast"})
        self.assertEqual(self.fleet.snapshot()["summary"]["pending"], 1)
        status = host.request(self.request(host, "status"))["result"]
        self.assertEqual(status["recovery"]["state"], "screenshot_cleanup_failed")
        self.fleet.record_fences(bridge.PROFILE["id"], [{"fenced": True, "profileId": bridge.PROFILE["id"],
            "sessionId": host.session_id, "documentId": host.document_id}])
        self.assertEqual(self.fleet.snapshot()["summary"]["pending"], 0)

    def test_scroll_settlement_preserves_independent_screenshot_recovery(self):
        host, token, _ = self.host()
        request = self.request(host, "scroll", token=token)
        with concurrent.futures.ThreadPoolExecutor() as executor:
            pending = executor.submit(host.request, request)
            deadline = time.monotonic() + 1
            while request["id"] not in host.pending and time.monotonic() < deadline:
                time.sleep(.005)
            self.fleet.admit(host.session_id, "capture", "screenshot")
            for phase, method in (("read_quarantined", "Page.startScreencast"), ("cdp_timeout", "Input.dispatchMouseEvent")):
                host.receive({"v": bridge.EXTENSION_PROTOCOL, "type": "diagnostic", "phase": phase, "method": method})
            response = {"v": bridge.EXTENSION_PROTOCOL, "type": "response", "id": request["id"],
                "sessionId": host.session_id, "ok": False,
                "error": {"code": "BROWSER_TIMEOUT", "outcome": "unknown", "message": "fixture"}}
            host.receive({**response, "settled": False})
            self.assertEqual(pending.result()["error"]["outcome"], "unknown")
            self.assertEqual(host.request(self.request(host, "status"))["result"]["recovery"]["blocks"], ["mutations", "screenshot"])
            host.receive({**response, "settled": True})
        status = host.request(self.request(host, "status"))["result"]
        self.assertEqual(status["recovery"]["state"], "screenshot_read_pending")
        self.assertEqual(status["recovery"]["blocks"], ["screenshot"])
        self.assertEqual(self.fleet.snapshot()["summary"]["pending"], 1)
        host.receive({"v": bridge.EXTENSION_PROTOCOL, "type": "diagnostic", "phase": "read_resolved", "method": "Page.startScreencast"})
        self.assertIsNone(host.request(self.request(host, "status"))["result"]["recovery"])
        self.assertEqual(self.fleet.snapshot()["summary"]["pending"], 0)

    def test_detach_without_fence_keeps_admitted_capture_capacity(self):
        host, token, _ = self.host()
        request = self.request(host, "screenshot", token=token)
        with concurrent.futures.ThreadPoolExecutor() as executor:
            pending = executor.submit(host.request, request)
            deadline = time.monotonic() + 1
            while request["id"] not in host.pending and time.monotonic() < deadline:
                time.sleep(.005)
            host.receive({"v": bridge.EXTENSION_PROTOCOL, "type": "event", "event": "detached", "status": {
                "attached": False, "runtime": {"extension": {**bridge.HOST_RUNTIME, "protocol": bridge.EXTENSION_PROTOCOL}}}})
            self.assertEqual(pending.result()["error"]["code"], "DISCONNECTED")
        self.assertEqual(self.fleet.snapshot()["summary"]["pending"], 1)
        self.assertEqual(self.fleet.snapshot()["sessions"][0]["state"], "disconnected")

    def test_worker_never_repoints_existing_endpoint_at_new_session(self):
        host, _, _ = self.host()
        old_session = host.session_id
        host.receive({"v": bridge.EXTENSION_PROTOCOL, "type": "hello", "status": {
            "attached": True, "sessionId": str(uuid.uuid4()), "documentId": "foreign-document",
            "runtime": {"extension": {**bridge.HOST_RUNTIME, "protocol": bridge.EXTENSION_PROTOCOL}}}})
        self.assertTrue(host.stopped.is_set())
        self.assertIsNone(host.session_id)
        self.assertEqual(self.fleet.snapshot()["sessions"][0]["sessionId"], old_session)

    def test_snapshot_of_missing_registry_creates_nothing(self):
        self.assertEqual(self.fleet.snapshot()["sessions"], [])
        self.assertFalse(self.fleet.directory.exists())

    @unittest.skipIf(os.name == "nt", "Unix socket integration; Windows descriptor is covered by platform smoke")
    def test_main_first_hello_publishes_isolated_endpoint_and_rejects_stale_route(self):
        session = str(uuid.uuid4())
        base = self.root / "runtime/bridge.sock"
        endpoint = base.parent / "sessions" / (session + ".sock")
        env = {**os.environ, "VIDS_STUDIO_SOCKET": str(base), "VIDS_STUDIO_FLEET_DIR": str(self.fleet.directory),
               "VIDS_STUDIO_REGISTRY_DIR": str(self.root / "coordinator")}
        child = subprocess.Popen([sys.executable, str(ROOT / "native/bridge.py")], env=env,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            hello = {"v": bridge.EXTENSION_PROTOCOL, "type": "hello", "fleet": {"browserInstanceId": str(uuid.uuid4()), "pairingTicket": secrets.token_hex(32)},
                     "status": {"attached": True, "sessionId": session, "documentId": "process-fixture",
                                "runtime": {"extension": {**bridge.HOST_RUNTIME, "protocol": bridge.EXTENSION_PROTOCOL}}}}
            child.stdin.write(bridge.encode_native(hello)); child.stdin.flush()
            deadline = time.monotonic() + 5
            while not endpoint.exists() and child.poll() is None and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertTrue(endpoint.exists(), child.stderr.read().decode() if child.poll() is not None else "endpoint missing")
            with socket.socket(socket.AF_UNIX) as client:
                client.settimeout(3); client.connect(str(endpoint))
                client.sendall(json.dumps({"v": bridge.LOCAL_PROTOCOL, "type": "request", "id": "status", "method": "status", "params": {}}).encode() + b"\n")
                response = json.loads(client.makefile("rb").readline())
                self.assertEqual(response["result"]["sessionId"], session)
                self.assertTrue(response["result"]["fleet"])
            child.stdin.close()
            self.assertEqual(child.wait(timeout=5), 0)
            self.assertFalse(endpoint.exists())
            self.assertEqual(self.fleet.snapshot()["sessions"][0]["state"], "disconnected")
            self.assertFalse(base.exists(), "fleet workers never occupy the legacy singleton endpoint")
        finally:
            if child.poll() is None:
                child.kill(); child.wait(timeout=5)
            if not child.stdin.closed:
                child.stdin.close()
            child.stdout.close(); child.stderr.close()


if __name__ == "__main__":
    unittest.main()
