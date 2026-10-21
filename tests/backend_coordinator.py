"""Cross-process arbitration and crash recovery, without Chrome or live sockets."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from backend_native import bridge, CapturedOutput, control_request, request, extension_status, attached_host, FixtureCase

Coordinator = bridge.Coordinator
CoordinationError = bridge.CoordinationError


class CoordinatorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name) / "registry"
        self.coordinator = Coordinator(self.directory)
        self.processes = []

    def tearDown(self):
        for process in self.processes:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=3)
            process.stdin.close()
            process.stdout.close()
            process.stderr.close()
        for lease in list(self.coordinator.leases.values()):
            self.coordinator.release(lease, abandoned=True)
        self.temporary.cleanup()

    def actor(self, document="same-document", mutate=False):
        script = """
import json,sys
sys.path.insert(0, sys.argv[1])
from coordinator import Coordinator
c=Coordinator(sys.argv[2])
l=c.acquire(sys.argv[3], 'old-profile', 'old-session', 'Old owner')
if sys.argv[4]=='yes': c.begin(l, 'old-operation', 'fingerprint')
print(json.dumps({'ready':True,'generation':l.generation}),flush=True)
sys.stdin.readline()
c.release(l)
"""
        process = subprocess.Popen([sys.executable, "-I", "-c", script, str(Path(bridge.__file__).parent), str(self.directory), document, "yes" if mutate else "no"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.processes.append(process)
        self.assertTrue(json.loads(process.stdout.readline())["ready"])
        return process

    def assert_code(self, code, operation):
        with self.assertRaises(CoordinationError) as caught:
            operation()
        self.assertEqual(caught.exception.code, code)

    def test_two_real_processes_conflict_only_on_the_same_document(self):
        process = self.actor()
        self.assert_code("CONTROL_BUSY", lambda: self.coordinator.acquire("same-document", "other-profile", "other-session", "Other owner"))
        independent = self.coordinator.acquire("different-document", "other-profile", "other-session", "Other owner")
        self.assertEqual(self.coordinator.authorize(independent, mutating=True), "write")
        self.coordinator.release(independent)
        process.stdin.write("release\n")
        process.stdin.flush()
        self.assertEqual(process.wait(timeout=3), 0)
        next_owner = self.coordinator.acquire("same-document", "other-profile", "other-session", "Other owner")
        self.assertEqual(next_owner.mode, "write")

    def test_real_crash_requires_extension_fence_then_read_only_reconciliation(self):
        process = self.actor(mutate=True)
        process.kill()
        process.wait(timeout=3)
        self.assertEqual(self.coordinator.status("same-document")["state"], "needs_fencing")
        acquire = lambda: self.coordinator.acquire("same-document", "new-profile", "new-session", "New owner")
        self.assert_code("COORDINATOR_FENCE_REQUIRED", acquire)
        # Neither another profile's claim, a different tab nor a false receipt fences it.
        self.coordinator.record_fences("new-profile", [{"profileId": "old-profile", "sessionId": "old-session", "documentId": "same-document", "fenced": True}])
        self.coordinator.record_fences("old-profile", [{"profileId": "old-profile", "sessionId": "old-session", "documentId": "other-document", "fenced": True}])
        self.assert_code("COORDINATOR_FENCE_REQUIRED", acquire)
        self.coordinator.record_fences("old-profile", [{"profileId": "old-profile", "sessionId": "old-session", "documentId": "same-document", "fenced": True}])
        lease = acquire()
        self.assertEqual(lease.mode, "reconcile")
        self.assertEqual(self.coordinator.authorize(lease), "reconcile")
        self.assert_code("RECONCILIATION_REQUIRED", lambda: self.coordinator.authorize(lease, mutating=True))
        self.assert_code("RECONCILIATION_REQUIRED", lambda: self.coordinator.begin(lease, "new-operation", "different"))
        self.assert_code("RECONCILIATION_EVIDENCE_REQUIRED", lambda: self.coordinator.reconcile(lease, "Observed current document", False))
        self.coordinator.reconcile(lease, "Observed current document; operator accepts the unresolved prior result", True)
        self.assertEqual(self.coordinator.authorize(lease, mutating=True), "write")
        self.assert_code("OPERATION_ALREADY_RECORDED", lambda: self.coordinator.begin(lease, "old-operation", "fingerprint"))
        with sqlite3.connect(self.directory / "registry.sqlite3") as db:
            initial, latest, state, evidence = db.execute("SELECT initial_outcome,latest_outcome,state,evidence FROM operations WHERE operation_id='old-operation'").fetchone()
        db.close()
        self.assertEqual((initial, latest, state), ("unknown", "unknown", "acknowledged"))
        self.assertIn("operator accepts", evidence)

    def test_fence_does_not_override_a_live_process_lock(self):
        self.actor(mutate=True)
        self.coordinator.record_fences("old-profile", [{"profileId": "old-profile", "sessionId": "old-session", "documentId": "same-document", "fenced": True}])
        self.assert_code("CONTROL_BUSY", lambda: self.coordinator.acquire("same-document", "new", "session", "New owner"))

    def test_stale_capabilities_and_old_generations_never_authorize(self):
        old = self.coordinator.acquire("document", "first", "first-session", "First")
        self.coordinator.release(old)
        new = self.coordinator.acquire("document", "second", "second-session", "Second")
        self.assertGreater(new.generation, old.generation)
        self.assert_code("CONTROL_REVOKED", lambda: self.coordinator.begin(old, "old-operation", "fingerprint"))
        self.assertNotIn(new.capability, json.dumps(self.coordinator.status("document")))

    def test_unknown_receipt_is_immutable_when_late_evidence_arrives(self):
        lease = self.coordinator.acquire("document", "profile", "session", "Owner")
        self.coordinator.begin(lease, "operation", "fingerprint")
        self.coordinator.finish(lease, "operation", "unknown", False)
        self.assert_code("CONTROL_IN_FLIGHT", lambda: self.coordinator.begin(lease, "next-operation", "different"))
        self.assert_code("CONTROL_IN_FLIGHT", lambda: self.coordinator.release(lease))
        self.coordinator.finish(lease, "operation", "succeeded", True)
        with sqlite3.connect(self.directory / "registry.sqlite3") as db:
            row = db.execute("SELECT initial_outcome,latest_outcome,state FROM operations").fetchone()
        db.close()
        self.assertEqual(row, ("unknown", "succeeded", "settled"))
        self.coordinator.release(lease)

    def test_private_registry_rejects_symlink_and_public_directory(self):
        self.directory.mkdir(mode=0o700)
        victim = Path(self.temporary.name) / "keep"
        victim.write_text("untouched")
        (self.directory / "registry.sqlite3").symlink_to(victim)
        with self.assertRaises(OSError):
            self.coordinator.acquire("document", "profile", "session", "Owner")
        self.assertEqual(victim.read_text(), "untouched")
        (self.directory / "registry.sqlite3").unlink()
        self.directory.chmod(0o770)
        self.assert_code("COORDINATOR_UNAVAILABLE", lambda: self.coordinator.acquire("document", "profile", "session", "Owner"))

    def test_persistent_parents_are_created_private_without_chmod_existing_parents(self):
        base = Path(self.temporary.name) / "state"
        base.mkdir(mode=0o755)
        nested = Coordinator(base / "vids-studio" / "coordinator")
        lease = nested.acquire("document", "profile", "session", "Owner")
        nested.release(lease)
        self.assertEqual(base.stat().st_mode & 0o777, 0o755)
        self.assertEqual((base / "vids-studio").stat().st_mode & 0o777, 0o700)
        self.assertEqual((base / "vids-studio/coordinator").stat().st_mode & 0o777, 0o700)
        self.assertEqual((base / "vids-studio/coordinator/registry.sqlite3").stat().st_mode & 0o777, 0o600)
        link = Path(self.temporary.name) / "state-link"
        link.symlink_to(base, target_is_directory=True)
        self.assert_code("COORDINATOR_UNAVAILABLE", lambda: Coordinator(link / "nested/coordinator").status("document"))
        self.assertFalse((base / "nested").exists())
        base.chmod(0o777)
        self.assert_code("COORDINATOR_UNAVAILABLE", lambda: Coordinator(base / "unsafe/coordinator").status("document"))
        self.assertFalse((base / "unsafe").exists())

    def test_existing_coordinator_fails_closed_if_persistent_permissions_change(self):
        lease = self.coordinator.acquire("document", "profile", "session", "Owner")
        self.directory.chmod(0o755)
        self.assert_code("COORDINATOR_UNAVAILABLE", lambda: self.coordinator.authorize(lease, mutating=True))
        self.directory.chmod(0o700)
        database = self.directory / "registry.sqlite3"
        database.chmod(0o644)
        self.assert_code("COORDINATOR_UNAVAILABLE", lambda: self.coordinator.begin(lease, "operation", "fingerprint"))
        database.chmod(0o600)

    def test_retention_prunes_only_resolved_history_and_keeps_old_unknown_and_needed_fence(self):
        lease = self.coordinator.acquire("unknown-document", "profile", "unknown-session", "Owner")
        self.coordinator.begin(lease, "unknown-operation", "fingerprint")
        self.coordinator.finish(lease, "unknown-operation", "unknown", True)
        self.coordinator.release(lease, abandoned=True)
        self.coordinator.record_fences("profile", [{"profileId": "profile", "sessionId": "unknown-session", "documentId": "unknown-document", "fenced": True}])
        resolved = self.coordinator.acquire("resolved-document", "profile", "resolved-session", "Owner")
        self.coordinator.begin(resolved, "resolved-operation", "fingerprint")
        self.coordinator.finish(resolved, "resolved-operation", "succeeded", True)
        self.coordinator.release(resolved)
        self.coordinator.record_fences("profile", [{"profileId": "profile", "sessionId": "unneeded-session", "documentId": "other-document", "fenced": True}])
        ancient = time.time() - 100 * 86400
        with self.coordinator._transaction() as db:
            db.execute("UPDATE documents SET updated=?", (ancient,))
            db.execute("UPDATE operations SET created=?,updated=?", (ancient, ancient))
            db.execute("UPDATE fences SET observed=?", (ancient,))
            before = tuple(db.execute("SELECT * FROM operations WHERE operation_id='unknown-operation'").fetchone())
        self.coordinator.record_fences("profile", [])
        with self.coordinator._transaction() as db:
            after = tuple(db.execute("SELECT * FROM operations WHERE operation_id='unknown-operation'").fetchone())
            self.assertEqual(before, after)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM documents").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM operations").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM fences").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT mode FROM documents").fetchone()[0], "needs_fencing")
        # A new Coordinator object represents a new process after volatile
        # runtime loss; unknown authority still comes from persistent state.
        restarted = Coordinator(self.directory)
        recovered = restarted.acquire("unknown-document", "new-profile", "new-session", "New owner")
        self.assertEqual(recovered.mode, "reconcile")
        restarted.release(recovered)

    def test_retention_count_limits_preserve_unresolved_records(self):
        with patch("coordinator.RESOLVED_PER_DOCUMENT", 2), patch("coordinator.RESOLVED_TOTAL", 3), \
             patch("coordinator.IDLE_DOCUMENT_LIMIT", 2), patch("coordinator.UNNEEDED_FENCE_LIMIT", 2):
            for index in range(5):
                lease = self.coordinator.acquire(f"document-{index}", "profile", f"session-{index}", "Owner")
                for operation in range(4):
                    operation_id = f"operation-{index}-{operation}"
                    self.coordinator.begin(lease, operation_id, "fingerprint")
                    self.coordinator.finish(lease, operation_id, "succeeded", True)
                self.coordinator.release(lease)
            self.coordinator.record_fences("profile", [{"profileId": "profile", "sessionId": f"unused-{index}", "documentId": f"unused-{index}", "fenced": True} for index in range(5)])
            with self.coordinator._transaction() as db:
                self.assertLessEqual(db.execute("SELECT COUNT(*) FROM documents").fetchone()[0], 2)
                self.assertLessEqual(db.execute("SELECT COUNT(*) FROM operations").fetchone()[0], 3)
                self.assertLessEqual(db.execute("SELECT COUNT(*) FROM fences").fetchone()[0], 2)
                self.assertTrue(all(row[0] <= 2 for row in db.execute("SELECT COUNT(*) FROM operations GROUP BY key")))


class HostCoordinatorTests(FixtureCase):
    def test_handshake_refuses_missing_stale_and_cross_profile_clients(self):
        host = attached_host(controlled=False)
        for client in (None, {**bridge.HOST_RUNTIME, "buildId": "stale"}, {**bridge.HOST_RUNTIME, "profileId": "other"}, {**bridge.HOST_RUNTIME, "protocol": 2}):
            response = host.request({**control_request("acquire_control"), "client": client})
            self.assertEqual(response["error"]["code"], "RECONNECT_REQUIRED")
        self.assertIsNone(host.control)
        self.assertEqual(host.stdout.messages, [])

    def test_diagnostics_never_takes_control_or_creates_snapshot(self):
        host = attached_host()
        response = host.request({"v": bridge.LOCAL_PROTOCOL, "type": "request", "id": "diagnostic", "method": "diagnostics", "params": {}})
        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["runtime"]["host"], bridge.HOST_RUNTIME)
        self.assertEqual(response["result"]["control"]["mode"], "write")
        self.assertNotIn(host.control.token, json.dumps(response))
        self.assertNotIn(host.control.coordinator_lease.capability, json.dumps(response))
        self.assertEqual(host.stdout.messages, [])

    def test_registry_failure_prevents_dispatch_even_after_local_authorization(self):
        host = attached_host()
        with patch.object(host.coordinator, "begin", side_effect=OSError("unavailable")):
            response = host.request(request())
        self.assertEqual(response["error"]["code"], "COORDINATOR_UNAVAILABLE")
        self.assertEqual(host.stdout.messages, [])
        self.assertEqual(host.control.inflight, 0)

    def test_registry_failure_during_hello_preserves_diagnostics(self):
        host = attached_host(controlled=False)
        with patch.object(host.coordinator, "record_fences", side_effect=sqlite3.OperationalError("unavailable")), \
             patch.object(host.coordinator, "status", side_effect=sqlite3.OperationalError("unavailable")), \
             patch.object(host.coordinator, "acquire", side_effect=sqlite3.OperationalError("unavailable")):
            host.receive({"v": bridge.EXTENSION_PROTOCOL, "type": "hello", "status": extension_status("new-session")})
            response = host.request({"v": bridge.LOCAL_PROTOCOL, "type": "request", "id": "diagnostic", "method": "diagnostics", "params": {}})
            self.assertTrue(response["ok"])
            self.assertEqual(response["result"]["sessionId"], "new-session")
            self.assertEqual(response["result"]["coordinator"]["state"], "unavailable")
            self.assertEqual(host.request(control_request("acquire_control", session="new-session"))["error"]["code"], "COORDINATOR_UNAVAILABLE")
        self.assertEqual(host.stdout.messages, [])

    def test_registry_failure_on_browser_reply_does_not_emit_false_success(self):
        host = attached_host(timeout=0.001)
        host.request(request())
        with patch.object(host.coordinator, "finish", side_effect=sqlite3.OperationalError("unavailable")):
            host.receive({"v": bridge.EXTENSION_PROTOCOL, "type": "response", "id": "req-1", "ok": True, "result": {"performed": True}})
        self.assertEqual(host.control.inflight, 1)
        self.assertEqual(host.request(control_request("release_control", host.control.token))["error"]["code"], "CONTROL_IN_FLIGHT")

    def test_persisted_intent_exists_before_native_send(self):
        host = attached_host(timeout=0.001)
        original_write = host.stdout.write
        observed = []
        def write(data):
            state = host.coordinator.status("fixture")
            observed.append(state["unknownOperations"][0]["state"])
            original_write(data)
        host.stdout.write = write
        self.assertEqual(host.request(request())["error"]["outcome"], "unknown")
        self.assertEqual(observed, ["pending"])

    def test_revocation_between_begin_and_send_cleans_unsent_intent(self):
        host = attached_host()
        authorize = host.coordinator.authorize
        calls = 0
        def deny_second(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise CoordinationError("CONTROL_REVOKED", "Revoked before send")
            return authorize(*args, **kwargs)
        with patch.object(host.coordinator, "authorize", side_effect=deny_second):
            response = host.request(request())
        self.assertEqual(response["error"]["outcome"], "not_performed")
        self.assertEqual(host.control.inflight, 0)
        self.assertEqual(host.stdout.messages, [])
        self.assertEqual(host.coordinator.status("fixture")["unknownOperations"], [])

    def test_late_status_cannot_roll_back_a_new_attachment(self):
        host = attached_host(controlled=False)
        results = []
        thread = threading.Thread(target=lambda: results.append(host.request({"v": bridge.LOCAL_PROTOCOL, "type": "request", "id": "old-status", "method": "status", "params": {}})))
        thread.start()
        self.assertTrue(host.stdout.ready.wait(0.3))
        host.receive({"v": bridge.EXTENSION_PROTOCOL, "type": "hello", "status": extension_status("new-session")})
        host.receive({"v": bridge.EXTENSION_PROTOCOL, "type": "response", "id": "old-status", "ok": True, "result": extension_status("session-1")})
        thread.join(timeout=1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(host.session_id, "new-session")
        self.assertEqual(results[0]["error"]["code"], "STALE_STATUS")


if __name__ == "__main__":
    unittest.main()
