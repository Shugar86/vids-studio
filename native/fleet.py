"""Private attachment discovery, task reservations and bounded shared admission.

An expired heartbeat is diagnostic evidence, never a fence or permission to reuse
another task's document. Only hashes of pairing/binding secrets are persisted.
"""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
import sys
import time
import uuid

from coordinator import CoordinationError, private_directory
from platform_support import WINDOWS, assert_private_file, secure_open


def default_directory():
    if os.environ.get("VIDS_STUDIO_FLEET_DIR"):
        return Path(os.environ["VIDS_STUDIO_FLEET_DIR"])
    if os.environ.get("VIDS_STUDIO_REGISTRY_DIR"):
        return Path(os.environ["VIDS_STUDIO_REGISTRY_DIR"]).parent / "fleet"
    if WINDOWS:
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData/Local") / "VidsStudio/fleet"
    if sys.platform == "darwin" and not os.environ.get("XDG_STATE_HOME"):
        return Path.home() / "Library/Application Support/VidsStudio/fleet"
    return Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local/state") / "vids-studio/fleet"


def identifier(value):
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value:
            raise ValueError()
    except (ValueError, AttributeError):
        raise CoordinationError("INVALID_ARGUMENT", "A canonical UUID is required")
    return value


def secret_hash(value):
    if not isinstance(value, str) or not 32 <= len(value) <= 128 or not all(c.isalnum() or c in "_-" for c in value) or not value.isascii():
        raise CoordinationError("INVALID_ARGUMENT", "Use an opaque random capability of at least 32 characters")
    return hashlib.sha256(value.encode()).hexdigest()


class Resources:
    """Measured OS data; unsupported readings remain null, including GPU data."""
    def __init__(self):
        self.previous_cpu = None

    def sample(self):
        result = {"measuredAt": time.time(), "cpuPercent": None, "logicalCpuCount": os.cpu_count(),
                  "loadAverage": None, "memoryAvailableBytes": None, "memoryTotalBytes": None,
                  "pressure": {}, "gpu": None}
        try:
            result["loadAverage"] = list(os.getloadavg())
        except (OSError, AttributeError):
            pass
        if sys.platform.startswith("linux"):
            try:
                cpu = [int(v) for v in Path("/proc/stat").read_text().splitlines()[0].split()[1:9]]
                total, idle = sum(cpu), cpu[3] + cpu[4]
                if self.previous_cpu and total > self.previous_cpu[0]:
                    result["cpuPercent"] = round(max(0, min(100, 100 * (1 - (idle - self.previous_cpu[1]) / (total - self.previous_cpu[0])))), 1)
                self.previous_cpu = (total, idle)
                memory = {line.split(":")[0]: int(line.split()[1]) * 1024 for line in Path("/proc/meminfo").read_text().splitlines()}
                result["memoryAvailableBytes"] = memory.get("MemAvailable")
                result["memoryTotalBytes"] = memory.get("MemTotal")
            except (OSError, ValueError, IndexError):
                pass
            for kind in ("cpu", "memory", "io"):
                try:
                    parts = Path(f"/proc/pressure/{kind}").read_text().splitlines()[0].split()
                    result["pressure"][kind] = {k: float(v) for k, v in (part.split("=") for part in parts[1:]) if k.startswith("avg")}
                except (OSError, ValueError, IndexError):
                    pass
        return result


def adaptive_limit(policy, resources, previous, now):
    """Stored hysteresis: decrease promptly; add at most one slot per 10 s.

    Unknown/old measurements never justify a full configured concurrency. This
    also gives unsupported OS counters a conservative and explicit fallback.
    """
    maximum = policy.get("maxConcurrency", 10)
    current = max(1, min(maximum, previous.get("effectiveConcurrency", 2)))
    last_changed = previous.get("lastChangedAt", now)
    cpu, available = resources.get("cpuPercent"), resources.get("memoryAvailableBytes")
    measured = resources.get("measuredAt")
    fresh = isinstance(measured, (int, float)) and -5 <= now - measured <= 10
    known = fresh and isinstance(cpu, (int, float)) and isinstance(available, (int, float))
    pressure = resources.get("pressure", {}).get("memory", {}).get("avg10", 0)
    total = resources.get("memoryTotalBytes") or 0
    severe = fresh and ((available is not None and available < max(512 * 1024**2, total * .05)) or pressure > 10)
    if severe:
        target, reason = 1, "memory_pressure"
    elif not known:
        target, reason = min(current, 2), "telemetry_unavailable" if fresh else "telemetry_stale"
    elif cpu >= 90 or pressure > 2:
        target, reason = max(1, current // 2), "resource_pressure"
    elif policy.get("paused"):
        target, reason = current, "paused"
    elif cpu < 70 and pressure < 1 and available >= max(2 * 1024**3, total * .15):
        target = min(maximum, current + (1 if previous and now - last_changed >= 10 else 0))
        reason = "healthy_ramp" if target < maximum else "configured_limit"
    else:
        target, reason = current, "headroom_hold"
    return {"effectiveConcurrency": target, "lastChangedAt": now if target != current or not previous else last_changed,
            "reason": reason, "telemetryAvailable": known, "measuredAt": measured}


def governor_view(policy, resources, stored, now):
    """A read never advances or repeatedly decreases the stored controller."""
    measured = resources.get("measuredAt")
    fresh = isinstance(measured, (int, float)) and -5 <= now - measured <= 10
    known = fresh and isinstance(resources.get("cpuPercent"), (int, float)) and isinstance(resources.get("memoryAvailableBytes"), (int, float))
    limit = min(policy.get("maxConcurrency", 10), stored.get("effectiveConcurrency", 2))
    if not known:
        limit = min(limit, 2)
    return {"effectiveConcurrency": max(1, limit), "telemetryAvailable": known,
            "adaptationReason": stored.get("reason", "telemetry_unavailable") if known else
                "telemetry_unavailable" if fresh else "telemetry_stale"}


class FleetRegistry:
    def __init__(self, directory=None, *, clock=time.time, resources=None):
        self.directory = Path(directory or default_directory())
        self.path = self.directory / "fleet.sqlite3"
        self.clock = clock
        self.resources = resources or Resources()
        self.initialized = False

    def initialize(self):
        if self.initialized:
            return
        private_directory(self.directory)
        fd = secure_open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        assert_private_file(self.path)
        with contextlib.closing(sqlite3.connect(self.path, timeout=5)) as db, db:
            db.executescript("""
                PRAGMA synchronous=FULL;
                CREATE TABLE IF NOT EXISTS sessions (
                    session TEXT PRIMARY KEY, profile TEXT NOT NULL, document TEXT NOT NULL,
                    browser TEXT NOT NULL, endpoint TEXT NOT NULL, instance TEXT NOT NULL,
                    heartbeat REAL NOT NULL, state TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
                    runtime TEXT NOT NULL, ticket_hash TEXT, ticket_intent TEXT,
                    last_action TEXT, recovery TEXT, requests INTEGER NOT NULL DEFAULT 0,
                    errors INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS bindings (
                    binding TEXT PRIMARY KEY, document TEXT UNIQUE NOT NULL,
                    session TEXT NOT NULL, capability_hash TEXT NOT NULL, intent TEXT NOT NULL,
                    owner TEXT NOT NULL, created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS permits (
                    session TEXT NOT NULL, request TEXT NOT NULL, class TEXT NOT NULL,
                    started REAL NOT NULL, PRIMARY KEY(session, request));
                CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                INSERT OR IGNORE INTO settings VALUES ('policy','{"paused":false,"maxConcurrency":10}');
                INSERT OR IGNORE INTO settings VALUES ('resources','{}');
                INSERT OR IGNORE INTO settings VALUES ('governor','{}');
            """)
        self.initialized = True

    @contextlib.contextmanager
    def transaction(self):
        self.initialize()
        private_directory(self.directory)
        assert_private_file(self.path)
        with contextlib.closing(sqlite3.connect(self.path, timeout=5)) as db, db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA synchronous=FULL")
            db.execute("BEGIN IMMEDIATE")
            yield db

    def register(self, session, profile, document, browser, endpoint, ticket, runtime):
        identifier(session)
        identifier(browser)
        if not isinstance(document, str) or not 1 <= len(document) <= 256:
            raise CoordinationError("INVALID_ARGUMENT", "A verified document is required")
        ticket_hash = secret_hash(ticket)
        runtime = {role: {key: value for key, value in details.items() if key in ("profileId", "version", "buildId", "protocol")}
                   for role, details in runtime.items() if role in ("host", "extension") and isinstance(details, dict)}
        instance = str(uuid.uuid4())
        with self.transaction() as db:
            if db.execute("SELECT 1 FROM sessions WHERE session=?", (session,)).fetchone():
                raise CoordinationError("SESSION_EXISTS", "A session identifier cannot be reused")
            db.execute("INSERT INTO sessions(session,profile,document,browser,endpoint,instance,heartbeat,state,runtime,ticket_hash) VALUES (?,?,?,?,?,?,?,?,?,?)",
                       (session, profile, document, browser, str(endpoint), instance, self.clock(), "attached", json.dumps(runtime), ticket_hash))
        return instance

    def heartbeat(self, session, instance):
        sample = self.resources.sample()
        sample["measuredAt"] = self.clock()
        with self.transaction() as db:
            db.execute("UPDATE sessions SET heartbeat=? WHERE session=? AND instance=? AND state='attached'", (self.clock(), session, instance))
            db.execute("UPDATE settings SET value=? WHERE key='resources'", (json.dumps(sample),))
            policy = json.loads(db.execute("SELECT value FROM settings WHERE key='policy'").fetchone()[0])
            previous = json.loads(db.execute("SELECT value FROM settings WHERE key='governor'").fetchone()[0])
            governor = adaptive_limit(policy, sample, previous, self.clock())
            db.execute("UPDATE settings SET value=? WHERE key='governor'", (json.dumps(governor),))

    def detached(self, session, instance, *, fenced=False):
        with self.transaction() as db:
            db.execute("UPDATE sessions SET state=?,heartbeat=? WHERE session=? AND instance=? AND state!='fenced'", ("fenced" if fenced else "disconnected", self.clock(), session, instance))
            # Host death / stale heartbeat is NOT proof of Chrome cancellation.
            if fenced:
                db.execute("DELETE FROM permits WHERE session=?", (session,))

    def record_fences(self, profile, receipts):
        with self.transaction() as db:
            for receipt in receipts or []:
                if not isinstance(receipt, dict) or receipt.get("fenced") is not True or receipt.get("profileId") != profile:
                    continue
                row = db.execute("SELECT session FROM sessions WHERE session=? AND profile=? AND document=?",
                                 (receipt.get("sessionId"), profile, receipt.get("documentId"))).fetchone()
                if row:
                    db.execute("UPDATE sessions SET state='fenced',heartbeat=? WHERE session=?", (self.clock(), row[0]))
                    db.execute("DELETE FROM permits WHERE session=?", (row[0],))
            # Bound only resolved metadata. A reservation, pending permit or
            # missing fence is never discarded to make the dashboard smaller.
            db.execute("""DELETE FROM sessions WHERE state='fenced'
                AND session NOT IN (SELECT session FROM bindings)
                AND session NOT IN (SELECT session FROM permits)
                AND session NOT IN (SELECT session FROM sessions WHERE state='fenced'
                    ORDER BY heartbeat DESC,session LIMIT 256)""")

    def claim(self, session, params):
        binding = identifier(params.get("bindingId"))
        intent = identifier(params.get("intentId"))
        capability = secret_hash(params.get("bindingToken"))
        ticket = secret_hash(params.get("pairingTicket"))
        with self.transaction() as db:
            row = db.execute("SELECT * FROM sessions WHERE session=?", (session,)).fetchone()
            if not row or row["state"] != "attached" or row["document"] != params.get("expectedDocumentId"):
                raise CoordinationError("DOCUMENT_CHANGED", "Claim must identify this exact attached document")
            if not secrets.compare_digest(row["ticket_hash"] or "", ticket):
                raise CoordinationError("PAIRING_REQUIRED", "Use this attachment's private pairing ticket")
            prior = db.execute("SELECT * FROM bindings WHERE document=? OR binding=?", (row["document"], binding)).fetchone()
            if prior:
                if prior["binding"] == binding and prior["session"] == session and prior["intent"] == intent and secrets.compare_digest(prior["capability_hash"], capability):
                    return self._binding_result(prior)
                raise CoordinationError("DOCUMENT_ALREADY_BOUND", "This document is assigned to another task; expiry does not transfer it")
            if row["ticket_intent"] is not None:
                raise CoordinationError("PAIRING_CONSUMED", "This pairing ticket has already been consumed")
            owner = str(params.get("ownerLabel") or "Vids task")[:120]
            db.execute("INSERT INTO bindings VALUES (?,?,?,?,?,?,?)", (binding, row["document"], session, capability, intent, owner, self.clock()))
            db.execute("UPDATE sessions SET ticket_intent=? WHERE session=?", (intent, session))
            return {"bindingId": binding, "sessionId": session, "documentId": row["document"], "ownerLabel": owner}

    @staticmethod
    def _binding_result(row):
        return {"bindingId": row["binding"], "sessionId": row["session"], "documentId": row["document"], "ownerLabel": row["owner"]}

    def authorize(self, session, params):
        binding = identifier(params.get("bindingId"))
        capability = secret_hash(params.get("bindingToken"))
        with self.transaction() as db:
            row = db.execute("SELECT * FROM bindings WHERE binding=?", (binding,)).fetchone()
            if not row or not secrets.compare_digest(row["capability_hash"], capability):
                raise CoordinationError("BINDING_REQUIRED", "Use only this task's own binding capability")
            if row["session"] != session or (params.get("expectedDocumentId") is not None and row["document"] != params["expectedDocumentId"]):
                raise CoordinationError("BINDING_MISMATCH", "The task binding belongs to a different attachment/document")
            return self._binding_result(row)

    def resume(self, session, params):
        binding = identifier(params.get("bindingId"))
        capability = secret_hash(params.get("bindingToken"))
        with self.transaction() as db:
            owner = db.execute("SELECT * FROM bindings WHERE binding=?", (binding,)).fetchone()
            new = db.execute("SELECT * FROM sessions WHERE session=?", (session,)).fetchone()
            if not owner or not secrets.compare_digest(owner["capability_hash"], capability):
                raise CoordinationError("BINDING_REQUIRED", "The original task capability is required")
            old = db.execute("SELECT * FROM sessions WHERE session=?", (owner["session"],)).fetchone()
            if not new or new["state"] != "attached" or new["document"] != owner["document"] or params.get("expectedDocumentId") != owner["document"]:
                raise CoordinationError("DOCUMENT_CHANGED", "Resume must target the exact original document")
            if owner["session"] != session and (not old or old["state"] != "fenced"):
                raise CoordinationError("COORDINATOR_FENCE_REQUIRED", "The previous attachment must be explicitly fenced before resume")
            if owner["session"] != session and not secrets.compare_digest(new["ticket_hash"] or "", secret_hash(params.get("pairingTicket"))):
                raise CoordinationError("PAIRING_REQUIRED", "Resume needs the new attachment's private pairing ticket")
            db.execute("UPDATE bindings SET session=? WHERE binding=?", (session, binding))
            db.execute("UPDATE sessions SET ticket_intent=? WHERE session=?", (owner["intent"], session))
            return {**self._binding_result(owner), "sessionId": session}

    def release(self, session, params):
        self.authorize(session, params)
        with self.transaction() as db:
            if db.execute("SELECT 1 FROM permits WHERE session=?", (session,)).fetchone():
                raise CoordinationError("CONTROL_IN_FLIGHT", "Wait for all admitted requests to settle before releasing the binding")
            db.execute("DELETE FROM bindings WHERE binding=? AND session=?", (params["bindingId"], session))
        return {"released": True, "requiresNewPairing": True}

    def admit(self, session, request, method):
        category = "screenshot" if method == "screenshot" else "export" if method in ("upload", "upload_via_picker", "export_trigger") else "browser"
        with self.transaction() as db:
            row = db.execute("SELECT paused,state FROM sessions WHERE session=?", (session,)).fetchone()
            policy = json.loads(db.execute("SELECT value FROM settings WHERE key='policy'").fetchone()[0])
            resources = json.loads(db.execute("SELECT value FROM settings WHERE key='resources'").fetchone()[0])
            if not row or row["state"] != "attached":
                raise CoordinationError("NOT_CONNECTED", "This attachment is no longer connected")
            if (policy["paused"] or row["paused"]) and method not in ("observe", "export_download_status"):
                raise CoordinationError("FLEET_PAUSED", "New browser work is paused; existing requests are not canceled")
            governor = json.loads(db.execute("SELECT value FROM settings WHERE key='governor'").fetchone()[0])
            # Admission reads the stored ramp and may become more conservative
            # on stale telemetry, but never advances its clock or adds slots.
            limit = governor_view(policy, resources, governor, self.clock())["effectiveConcurrency"]
            total = db.execute("SELECT COUNT(*) FROM permits").fetchone()[0]
            same = db.execute("SELECT COUNT(*) FROM permits WHERE session=?", (session,)).fetchone()[0]
            heavy = db.execute("SELECT COUNT(*) FROM permits WHERE class=?", (category,)).fetchone()[0]
            own_capture = category == "screenshot" and db.execute("SELECT 1 FROM permits WHERE session=? AND class='screenshot'", (session,)).fetchone()
            class_limit = min(limit, 3 if category == "screenshot" else 2 if category == "export" else limit)
            if total >= limit or same >= 2 or heavy >= class_limit or own_capture:
                raise CoordinationError("FLEET_BUSY", "Shared browser capacity is occupied; no command was dispatched")
            db.execute("INSERT INTO permits VALUES (?,?,?,?)", (session, request, category, self.clock()))
            db.execute("UPDATE sessions SET last_action=?,requests=requests+1 WHERE session=?", (method, session))

    @staticmethod
    def _recoveries(value):
        recovery = json.loads(value) if value else {}
        # Accept the first fleet prototype's flat diagnostic format as well.
        if "phase" in recovery:
            lane = "read" if recovery["phase"].startswith("read_") else "input"
            return {lane: recovery}
        return recovery

    @staticmethod
    def _recovery_summary(recoveries):
        primary = recoveries.get("input") or recoveries.get("read")
        return {**primary, "blocks": (["mutations"] if "input" in recoveries else []) +
                (["screenshot"] if "read" in recoveries else [])} if primary else None

    def settle(self, session, request, *, method=None, code=None, sent=False):
        with self.transaction() as db:
            row = db.execute("SELECT recovery FROM sessions WHERE session=?", (session,)).fetchone()
            recoveries = self._recoveries(row[0]) if row else {}
            # Losing a port/session is not evidence that Chrome canceled work.
            # A failed stop must keep its slot even if a later read callback fires.
            retain = sent and (code == "DISCONNECTED" or (method == "screenshot" and
                (code in ("BROWSER_TIMEOUT", "TIMEOUT") or
                 recoveries.get("read", {}).get("phase") == "read_cleanup_failed")))
            if not retain:
                db.execute("DELETE FROM permits WHERE session=? AND request=?", (session, request))
                if method == "scroll":
                    recoveries.pop("input", None)
                    db.execute("UPDATE sessions SET recovery=? WHERE session=?", (json.dumps(recoveries) if recoveries else None, session))
            return self._recovery_summary(recoveries)

    def diagnostic(self, session, phase, method):
        with self.transaction() as db:
            row = db.execute("SELECT recovery FROM sessions WHERE session=?", (session,)).fetchone()
            recoveries = self._recoveries(row[0]) if row else {}
            cleanup_failed = recoveries.get("read", {}).get("phase") == "read_cleanup_failed"
            if phase in ("read_resolved", "read_rejected") and not cleanup_failed:
                db.execute("DELETE FROM permits WHERE session=? AND class='screenshot'", (session,))
                recoveries.pop("read", None)
            elif phase in ("read_quarantined", "read_cleanup_failed", "cdp_timeout"):
                lane = "input" if phase == "cdp_timeout" else "read"
                if lane != "read" or not cleanup_failed:
                    recoveries[lane] = {"phase": phase, "method": method}
                db.execute("UPDATE sessions SET errors=errors+1 WHERE session=?", (session,))
            db.execute("UPDATE sessions SET recovery=? WHERE session=?", (json.dumps(recoveries) if recoveries else None, session))
            return self._recovery_summary(recoveries)

    def control(self, params):
        action = params.get("action")
        if action not in ("pause", "resume", "set_limits"):
            raise CoordinationError("INVALID_ARGUMENT", "Expected pause, resume or set_limits")
        session = params.get("sessionId")
        if session is not None:
            identifier(session)
        with self.transaction() as db:
            policy = json.loads(db.execute("SELECT value FROM settings WHERE key='policy'").fetchone()[0])
            if action == "set_limits":
                value = params.get("maxConcurrency")
                if type(value) is not int or not 1 <= value <= 100 or session is not None:
                    raise CoordinationError("INVALID_ARGUMENT", "Global maxConcurrency must be an integer from 1 to 100")
                policy["maxConcurrency"] = value
            elif session is None:
                policy["paused"] = action == "pause"
            else:
                if not db.execute("UPDATE sessions SET paused=? WHERE session=?", (action == "pause", session)).rowcount:
                    raise CoordinationError("NOT_CONNECTED", "Unknown attachment")
            db.execute("UPDATE settings SET value=? WHERE key='policy'", (json.dumps(policy),))
        return self.snapshot()

    def snapshot(self):
        now = self.clock()
        output = {"schemaVersion": 1, "updatedAt": now, "generatedAt": now, "sessions": [],
                  "policy": {"paused": False, "maxConcurrency": 10, "effectiveConcurrency": 2,
                      "adaptationReason": "telemetry_unavailable", "telemetryAvailable": False}, "resources": {}, "summary": {"attached": 0, "pending": 0}}
        if not self.path.exists():
            return output
        private_directory(self.directory)
        assert_private_file(self.path)
        with contextlib.closing(sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True, timeout=2)) as db:
            db.row_factory = sqlite3.Row
            settings = {row[0]: json.loads(row[1]) for row in db.execute("SELECT key,value FROM settings")}
            output["policy"] = settings["policy"]
            output["resources"] = settings.get("resources", {})
            stored = settings.get("governor", {})
            output["policy"].update(governor_view(output["policy"], output["resources"], stored, now))
            for row in db.execute("SELECT s.*,b.owner,(SELECT COUNT(*) FROM permits p WHERE p.session=s.session) AS pending FROM sessions s LEFT JOIN bindings b ON b.session=s.session ORDER BY s.heartbeat DESC"):
                state = "stale" if row["state"] == "attached" and now - row["heartbeat"] > 15 else row["state"]
                output["sessions"].append({"id": row["session"], "sessionId": row["session"], "profileId": row["profile"],
                    "documentId": row["document"], "browserInstanceId": row["browser"], "ownerLabel": row["owner"],
                    "state": state, "updatedAt": row["heartbeat"], "pending": row["pending"], "paused": bool(row["paused"]),
                    "runtime": json.loads(row["runtime"]), "lastAction": row["last_action"], "recovery": self._recovery_summary(self._recoveries(row["recovery"])),
                    "metrics": {"requests": row["requests"], "errors": row["errors"]}})
            output["summary"] = {"attached": sum(s["state"] == "attached" for s in output["sessions"]), "pending": sum(s["pending"] for s in output["sessions"])}
        return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("snapshot", "control", "policy"))
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--paused", choices=("true", "false"))
    parser.add_argument("--max-concurrency", type=int)
    parser.add_argument("--session-id")
    args = parser.parse_args()
    fleet = FleetRegistry(args.directory)
    try:
        if args.command == "snapshot":
            result = fleet.snapshot()
        elif args.command == "control":
            result = fleet.control(json.loads(sys.stdin.read(4096)))
        else:
            if args.max_concurrency is not None:
                fleet.control({"action": "set_limits", "maxConcurrency": args.max_concurrency})
            if args.paused is not None:
                fleet.control({"action": "pause" if args.paused == "true" else "resume", "sessionId": args.session_id})
            result = fleet.snapshot()
        print(json.dumps({"ok": True, "result": result}, separators=(",", ":")))
        return 0
    except (CoordinationError, ValueError, OSError, sqlite3.Error) as exc:
        print(json.dumps({"ok": False, "error": {"code": getattr(exc, "code", "FLEET_UNAVAILABLE"), "message": str(exc)}}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
