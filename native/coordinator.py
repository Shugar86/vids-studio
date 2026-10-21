"""Private cross-profile document arbitration; a dead PID is never a fence."""
import contextlib
import hashlib
import os
from pathlib import Path
import secrets
import sqlite3
import stat
import time
from dataclasses import dataclass
from platform_support import WINDOWS, ensure_private_directory, assert_private_file, secure_open, lock_file


RESOLVED_RETENTION_SECONDS = 30 * 86400
RESOLVED_PER_DOCUMENT = 512
RESOLVED_TOTAL = 4096
IDLE_DOCUMENT_RETENTION_SECONDS = 90 * 86400
IDLE_DOCUMENT_LIMIT = 1024
UNNEEDED_FENCE_LIMIT = 2048


class CoordinationError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


@dataclass
class Lease:
    key: str
    capability: str
    generation: int
    fd: int
    mode: str


def private_directory(path):
    try:
        return ensure_private_directory(path)
    except (OSError, ValueError) as exc:
        raise CoordinationError("COORDINATOR_UNAVAILABLE", "Coordinator storage must remain private and owned") from exc


class Coordinator:
    """OS locks fence live hosts; durable generations fence hosts after a crash.

    Releasing an OS lock on death is not proof that Chrome stopped executing.
    Only a receipt from the old profile's extension makes a crashed generation
    recoverable. Unknown outcomes remain recorded after an explicit decision.
    """
    def __init__(self, directory):
        self.directory = Path(directory)
        self.leases = {}
        self._initialized = False

    def _initialize(self):
        if self._initialized:
            return
        private_directory(self.directory)
        path = self.directory / "registry.sqlite3"
        fd = secure_open(path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or (not WINDOWS and info.st_uid != os.getuid()) or info.st_nlink != 1:
                raise CoordinationError("COORDINATOR_UNAVAILABLE", "Unsafe coordinator registry")
            if not WINDOWS:
                os.fchmod(fd, 0o600)
        finally:
            os.close(fd)
        with contextlib.closing(sqlite3.connect(path, timeout=5)) as db, db:
            db.executescript("""
                PRAGMA synchronous=FULL;
                CREATE TABLE IF NOT EXISTS documents (
                    key TEXT PRIMARY KEY, generation INTEGER NOT NULL,
                    profile TEXT NOT NULL, session TEXT NOT NULL, capability TEXT,
                    mode TEXT NOT NULL, owner_label TEXT NOT NULL, updated REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS fences (
                    key TEXT NOT NULL, profile TEXT NOT NULL, session TEXT NOT NULL,
                    observed REAL NOT NULL, PRIMARY KEY(key, profile, session)
                );
                CREATE TABLE IF NOT EXISTS operations (
                    key TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
                    generation INTEGER NOT NULL, state TEXT NOT NULL,
                    initial_outcome TEXT, latest_outcome TEXT, evidence TEXT,
                    created REAL NOT NULL, updated REAL NOT NULL,
                    PRIMARY KEY(key, operation_id)
                );
            """)
        self._initialized = True

    @contextlib.contextmanager
    def _transaction(self):
        self._initialize()
        private_directory(self.directory)
        try:
            assert_private_file(self.directory / "registry.sqlite3")
        except OSError as exc:
            raise CoordinationError("COORDINATOR_UNAVAILABLE", "Persistent registry must remain private and owned") from exc
        with contextlib.closing(sqlite3.connect(self.directory / "registry.sqlite3", timeout=5)) as db, db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA synchronous=FULL")
            db.execute("BEGIN IMMEDIATE")
            yield db

    def _prune_resolved(self, db):
        """Bound resolved history without changing unresolved authority/evidence.

        Empty lock inodes intentionally remain: deleting an inode while another
        process is opening it could split the document's OS lock into two locks.
        """
        now = time.time()
        db.execute("""DELETE FROM operations WHERE state IN ('settled','acknowledged') AND
                      (updated < ? OR rowid NOT IN
                       (SELECT rowid FROM operations WHERE state IN ('settled','acknowledged')
                        ORDER BY updated DESC, rowid DESC LIMIT ?))""", (now - RESOLVED_RETENTION_SECONDS, RESOLVED_TOTAL))
        db.execute("""DELETE FROM operations WHERE rowid IN
                      (SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER
                       (PARTITION BY key ORDER BY updated DESC, rowid DESC) AS position
                       FROM operations WHERE state IN ('settled','acknowledged')) WHERE position > ?)""", (RESOLVED_PER_DOCUMENT,))
        # Available rows hold no input authority. Never evict pending/unknown
        # records, a fenced-but-unreconciled owner, or a potentially live owner.
        removable = db.execute("""SELECT key FROM
                    (SELECT key,updated,ROW_NUMBER() OVER (ORDER BY updated DESC,key) AS position
                     FROM documents d WHERE mode='available' AND NOT EXISTS
                     (SELECT 1 FROM operations o WHERE o.key=d.key AND o.state IN ('pending','unknown')))
                    WHERE updated < ? OR position > ?""", (now - IDLE_DOCUMENT_RETENTION_SECONDS, IDLE_DOCUMENT_LIMIT)).fetchall()
        for row in removable:
            key = row["key"]
            db.execute("DELETE FROM operations WHERE key=? AND state IN ('settled','acknowledged')", (key,))
            db.execute("DELETE FROM fences WHERE key=?", (key,))
            db.execute("DELETE FROM documents WHERE key=? AND mode='available'", (key,))
        # A matching fence for a generation that may still own input is never
        # expired. Other receipts are only bounded recovery history.
        db.execute("""DELETE FROM fences WHERE rowid IN
                    (SELECT rowid FROM
                     (SELECT f.rowid,f.observed,ROW_NUMBER() OVER (ORDER BY f.observed DESC,f.rowid DESC) AS position
                      FROM fences f WHERE NOT EXISTS
                      (SELECT 1 FROM documents d WHERE d.key=f.key AND d.profile=f.profile AND d.session=f.session
                       AND d.mode NOT IN ('available','available_reconcile')))
                     WHERE observed < ? OR position > ?)""", (now - RESOLVED_RETENTION_SECONDS, UNNEEDED_FENCE_LIMIT))

    @staticmethod
    def key(document_id):
        if not isinstance(document_id, str) or not document_id or len(document_id) > 256:
            raise CoordinationError("DOCUMENT_REQUIRED", "A verified document ID is required")
        return hashlib.sha256(document_id.encode()).hexdigest()

    @staticmethod
    def _capability(capability):
        return hashlib.sha256(capability.encode()).hexdigest()

    def _lock(self, key):
        self._initialize()
        private_directory(self.directory)
        fd = secure_open(self.directory / f"{key}.lock", os.O_CREAT | os.O_RDWR, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or (not WINDOWS and info.st_uid != os.getuid()) or info.st_nlink != 1:
                raise CoordinationError("COORDINATOR_UNAVAILABLE", "Unsafe coordinator lock")
            if not WINDOWS:
                os.fchmod(fd, 0o600)
            try:
                lock_file(fd)
            except BlockingIOError as exc:
                raise CoordinationError("CONTROL_BUSY", "Another managed profile owns this document") from exc
            return fd
        except BaseException:
            os.close(fd)
            raise

    def record_fences(self, profile, receipts):
        if not isinstance(receipts, list) or len(receipts) > 64:
            return
        with self._transaction() as db:
            for receipt in receipts:
                if not isinstance(receipt, dict) or receipt.get("fenced") is not True or receipt.get("profileId") != profile:
                    continue
                session, document = receipt.get("sessionId"), receipt.get("documentId")
                if not isinstance(session, str) or not 1 <= len(session) <= 128 or not isinstance(document, str) or not 1 <= len(document) <= 256:
                    continue
                db.execute("INSERT OR REPLACE INTO fences VALUES (?, ?, ?, ?)", (self.key(document), profile, session, time.time()))
            self._prune_resolved(db)

    def acquire(self, document, profile, session, owner_label):
        key = self.key(document)
        fd = self._lock(key)
        try:
            with self._transaction() as db:
                self._prune_resolved(db)
                old = db.execute("SELECT * FROM documents WHERE key=?", (key,)).fetchone()
                if old and old["mode"] not in ("available", "available_reconcile"):
                    fenced = db.execute("SELECT 1 FROM fences WHERE key=? AND profile=? AND session=?", (key, old["profile"], old["session"])).fetchone()
                    if not fenced:
                        raise CoordinationError("COORDINATOR_FENCE_REQUIRED", "The previous extension generation is not fenced. Explicitly reconnect its original profile to deliver a confirmed debugger-detach receipt; do not repeat its mutation")
                    db.execute("UPDATE operations SET state='unknown', initial_outcome=COALESCE(initial_outcome,'unknown'), latest_outcome='unknown', updated=? WHERE key=? AND state='pending'", (time.time(), key))
                unknown = db.execute("SELECT 1 FROM operations WHERE key=? AND state='unknown'", (key,)).fetchone()
                mode = "reconcile" if unknown else "write"
                generation = (old["generation"] if old else 0) + 1
                capability = secrets.token_urlsafe(32)
                db.execute("INSERT OR REPLACE INTO documents VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (key, generation, profile, session, self._capability(capability), mode, owner_label, time.time()))
            lease = Lease(key, capability, generation, fd, mode)
            self.leases[key] = lease
            return lease
        except BaseException:
            os.close(fd)
            raise

    def _verify(self, db, lease):
        if self.leases.get(lease.key) is not lease or lease.fd < 0:
            raise CoordinationError("CONTROL_REVOKED", "This document generation no longer owns input")
        row = db.execute("SELECT * FROM documents WHERE key=?", (lease.key,)).fetchone()
        if not row or row["generation"] != lease.generation or not secrets.compare_digest(row["capability"] or "", self._capability(lease.capability)):
            raise CoordinationError("CONTROL_REVOKED", "Coordinator capability or generation changed")
        lease.mode = row["mode"]
        return row

    def authorize(self, lease, mutating=False):
        with self._transaction() as db:
            row = self._verify(db, lease)
            if mutating and row["mode"] != "write":
                raise CoordinationError("RECONCILIATION_REQUIRED", "Inspect the document read-only and acknowledge the unknown outcome with evidence before new mutations")
        return lease.mode

    def begin(self, lease, operation_id, fingerprint):
        with self._transaction() as db:
            row = self._verify(db, lease)
            if row["mode"] != "write":
                raise CoordinationError("RECONCILIATION_REQUIRED", "Unknown outcomes require read-only reconciliation before new mutations")
            if db.execute("SELECT 1 FROM operations WHERE key=? AND operation_id=?", (lease.key, operation_id)).fetchone():
                raise CoordinationError("OPERATION_ALREADY_RECORDED", "This operation ID has durable history. Inspect its outcome; it cannot be sent again")
            if db.execute("SELECT 1 FROM operations WHERE key=? AND state='pending'", (lease.key,)).fetchone():
                raise CoordinationError("CONTROL_IN_FLIGHT", "A previous mutation is unsettled; inspect its outcome before new mutations")
            self._prune_resolved(db)
            if db.execute("SELECT COUNT(*) FROM operations WHERE key=?", (lease.key,)).fetchone()[0] >= 1024:
                raise CoordinationError("COORDINATOR_HISTORY_FULL", "Resolve outstanding operations before more mutations")
            now = time.time()
            db.execute("INSERT INTO operations VALUES (?,?,?,?,?,NULL,NULL,NULL,?,?)", (lease.key, operation_id, fingerprint, lease.generation, "pending", now, now))

    def finish(self, lease, operation_id, outcome, settled):
        with self._transaction() as db:
            self._verify(db, lease)
            state = "pending" if not settled else "unknown" if outcome == "unknown" else "settled"
            db.execute("UPDATE operations SET state=?, initial_outcome=COALESCE(initial_outcome,?), latest_outcome=?, updated=? WHERE key=? AND operation_id=? AND generation=?", (state, outcome, outcome, time.time(), lease.key, operation_id, lease.generation))
            if state == "unknown":
                db.execute("UPDATE documents SET mode='reconcile', updated=? WHERE key=?", (time.time(), lease.key))
                lease.mode = "reconcile"

    def reconcile(self, lease, evidence, acknowledge_unknown):
        if acknowledge_unknown is not True or not isinstance(evidence, str) or not 8 <= len(evidence.strip()) <= 2000:
            raise CoordinationError("RECONCILIATION_EVIDENCE_REQUIRED", "Explicit acknowledgement and 8–2000 characters of observation/recovery evidence are required")
        with self._transaction() as db:
            row = self._verify(db, lease)
            if row["mode"] != "reconcile":
                raise CoordinationError("NOT_RECONCILING", "This control lease does not require reconciliation")
            if db.execute("SELECT 1 FROM operations WHERE key=? AND state='pending'", (lease.key,)).fetchone():
                raise CoordinationError("CONTROL_IN_FLIGHT", "An unsettled operation still blocks reconciliation")
            # Preserve initial/latest unknown. This is a decision, not success.
            db.execute("UPDATE operations SET state='acknowledged', evidence=?, updated=? WHERE key=? AND state='unknown'", (evidence.strip(), time.time(), lease.key))
            db.execute("UPDATE documents SET mode='write', updated=? WHERE key=?", (time.time(), lease.key))
            lease.mode = "write"

    def release(self, lease, abandoned=False):
        try:
            with self._transaction() as db:
                self._verify(db, lease)
                pending = db.execute("SELECT 1 FROM operations WHERE key=? AND state='pending'", (lease.key,)).fetchone()
                if pending and not abandoned:
                    raise CoordinationError("CONTROL_IN_FLIGHT", "Unsettled mutations prevent transfer of control")
                unknown = db.execute("SELECT 1 FROM operations WHERE key=? AND state='unknown'", (lease.key,)).fetchone()
                mode = "needs_fencing" if abandoned else "available_reconcile" if unknown else "available"
                db.execute("UPDATE documents SET capability=NULL, mode=?, updated=? WHERE key=?", (mode, time.time(), lease.key))
        finally:
            # On a registry failure never permit local input with a released lock.
            # An unsettled clean release retains its lock and lease.
            if abandoned:
                self._unlock(lease)
        self._unlock(lease)

    def _unlock(self, lease):
        self.leases.pop(lease.key, None)
        if lease.fd >= 0:
            os.close(lease.fd)
            lease.fd = -1

    def status(self, document):
        if not document:
            return {"state": "no_document"}
        key = self.key(document)
        with self._transaction() as db:
            row = db.execute("SELECT profile,session,generation,mode,owner_label FROM documents WHERE key=?", (key,)).fetchone()
            if not row:
                return {"state": "available", "unknownOperations": []}
            unknown = db.execute("SELECT operation_id,initial_outcome,latest_outcome,state FROM operations WHERE key=? AND state IN ('pending','unknown') ORDER BY created LIMIT 32", (key,)).fetchall()
            result = {"state": row["mode"], "profileId": row["profile"], "sessionId": row["session"], "generation": row["generation"], "ownerLabel": row["owner_label"], "unknownOperations": [dict(item) for item in unknown]}
            # A crash releases flock without updating the row. Report this as
            # requiring a fence; availability of the lock never grants input.
            if row["mode"] in ("write", "reconcile") and key not in self.leases:
                try:
                    probe = self._lock(key)
                except CoordinationError as exc:
                    if exc.code != "CONTROL_BUSY":
                        raise
                else:
                    os.close(probe)
                    result["state"] = "needs_fencing"
            if result["state"] == "needs_fencing":
                result["nextStep"] = "Explicitly attach the original profile after its extension confirms the old debugger generation is detached; then inspect and reconcile unknown outcomes"
            elif row["mode"] in ("reconcile", "available_reconcile"):
                result["nextStep"] = "Acquire read-only reconciliation control, observe the document, then acknowledge unknown outcomes with evidence; never repeat old operations"
            return result
