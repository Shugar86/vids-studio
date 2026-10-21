#!/usr/bin/env python3
"""Chrome Native Messaging <-> private local IPC; no browser API or exec."""
import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import signal
import sqlite3
import socket
import stat
import struct
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from coordinator import Coordinator, CoordinationError
from platform_support import WINDOWS, ensure_private_directory, assert_private_file, secure_open

PROFILE = json.loads((Path(__file__).resolve().parents[1] / "profile.json").read_text(encoding="utf-8"))
HOST_RUNTIME = {"profileId": PROFILE["id"], "version": PROFILE["version"], "buildId": PROFILE["buildId"], "protocol": PROFILE["protocol"]}
EXTENSION_PROTOCOL = PROFILE["extensionProtocol"]

MAX_REQUEST = 256 * 1024
MAX_NATIVE = 24 * 1024 * 1024
TIMEOUT = 20.0
CACHE_TTL = 900.0
CACHE_LIMIT = 512
LOCAL_PROTOCOL = PROFILE["protocol"]
CONTROL_TTL = 900.0
MAX_PENDING = 128
MUTATIONS = frozenset(("click", "drag", "scroll", "type_text", "press_key", "upload", "upload_via_picker", "export_trigger"))
CONTROL_METHODS = frozenset(("acquire_control", "renew_control", "release_control", "reconcile_control"))
METHODS = MUTATIONS | CONTROL_METHODS | {"status", "diagnostics", "observe", "screenshot", "export_download_status"}


DIAG_LIMIT = 64 * 1024
DIAG_PHASES = frozenset(("read_quarantined", "read_resolved", "read_rejected", "read_recovery_expired", "cdp_timeout"))


class DiagnosticLog:
    """Bounded, private metadata only; no request payloads or raw error strings."""
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()

    def write(self, event, **fields):
        if not isinstance(event, str) or event not in ("start", "exit", "hello", "detached", "request", "cdp"):
            return
        safe = {}
        for key, value in fields.items():
            if key == "method" and isinstance(value, str) and (value in METHODS or re.fullmatch(r"[A-Za-z]{1,30}\.[A-Za-z]{1,50}", value)):
                safe[key] = value
            elif key == "phase" and isinstance(value, str) and value in DIAG_PHASES:
                safe[key] = value
            elif key == "code" and isinstance(value, str) and re.fullmatch(r"[A-Z_]{1,64}", value):
                safe[key] = value
            elif key in ("ok", "attached") and isinstance(value, bool):
                safe[key] = value
            elif key in ("ms", "elapsedMs") and isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 86400000:
                safe[key] = value
            elif key == "reason" and isinstance(value, str) and value in ("stdin_eof", "sigterm", "host_error"):
                safe[key] = value
        data = (json.dumps({"t": round(time.time(), 3), "pid": os.getpid(), "event": event, **safe}, separators=(",", ":")) + "\n").encode()
        try:
            with self.lock:
                # Never follow a substituted log path, and refuse shared inodes.
                fd = secure_open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
                try:
                    info = os.fstat(fd)
                    if not stat.S_ISREG(info.st_mode) or (not WINDOWS and info.st_uid != os.getuid()) or info.st_nlink != 1:
                        return
                    if not WINDOWS:
                        os.fchmod(fd, 0o600)
                    if info.st_size + len(data) > DIAG_LIMIT:
                        os.ftruncate(fd, 0)
                    os.write(fd, data)
                finally:
                    os.close(fd)
        except OSError:
            pass  # Diagnostics cannot take down the bridge.


def private_runtime_directory(candidate, uid=None):
    """Accept existing owner-only runtime directories without following a symlink."""
    if WINDOWS:
        return False
    if not candidate or not Path(candidate).is_absolute():
        return False
    try:
        info = Path(candidate).lstat()
    except OSError:
        return False
    return stat.S_ISDIR(info.st_mode) and info.st_uid == (os.getuid() if uid is None else uid) and stat.S_IMODE(info.st_mode) == 0o700


def default_socket_path(environ=None):
    env = os.environ if environ is None else environ
    if env.get("VIDS_STUDIO_SOCKET"):
        return Path(env["VIDS_STUDIO_SOCKET"])
    if WINDOWS:
        root = Path(env.get("LOCALAPPDATA") or Path.home() / "AppData/Local")
        return root / "VidsStudio/runtime" / PROFILE["socketNamespace"] / "bridge.json"
    uid = os.getuid()
    if sys.platform == "darwin":
        return Path(f"/private/tmp/{PROFILE['socketNamespace']}-{uid}/bridge.sock")
    # MCP clients commonly strip XDG_RUNTIME_DIR from child environments. Use the
    # same Linux user runtime Chrome uses, but only if it really is private.
    for runtime in (env.get("XDG_RUNTIME_DIR"), f"/run/user/{uid}"):
        if private_runtime_directory(runtime, uid):
            return Path(runtime) / PROFILE["socketNamespace"] / "bridge.sock"
    return Path(f"/tmp/{PROFILE['socketNamespace']}-{uid}/bridge.sock")


def default_registry_path(environ=None):
    env = os.environ if environ is None else environ
    if env.get("VIDS_STUDIO_REGISTRY_DIR"):
        return Path(env["VIDS_STUDIO_REGISTRY_DIR"])
    if WINDOWS:
        return Path(env.get("LOCALAPPDATA") or Path.home() / "AppData/Local") / "VidsStudio/coordinator"
    if sys.platform == "darwin" and not env.get("XDG_STATE_HOME"):
        return Path.home() / "Library/Application Support/VidsStudio/coordinator"
    state_home = Path(env["XDG_STATE_HOME"]) if env.get("XDG_STATE_HOME") else Path.home() / ".local/state"
    # Keep unknown Google-side outcomes across OS reboots, not only host restarts.
    # A configured relative/unsafe location is rejected when opened; never fall
    # back to an empty volatile registry after a persistence failure.
    return state_home / "vids-studio/coordinator"


def read_exact(stream, size):
    chunks = bytearray()
    while len(chunks) < size:
        chunk = stream.read(size - len(chunks))
        if not chunk:
            if not chunks:
                raise EOFError()
            raise ValueError("Truncated native message")
        chunks.extend(chunk)
    return bytes(chunks)


def read_native(stream):
    size, = struct.unpack("=I", read_exact(stream, 4))
    if not 0 < size <= MAX_NATIVE:
        raise ValueError("Native message exceeds framing limit")
    try:
        payload = read_exact(stream, size)
    except EOFError as exc:
        raise ValueError("Truncated native message body") from exc
    value = json.loads(payload.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Native message must be an object")
    return value


def encode_native(message):
    data = json.dumps(message, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(data) > MAX_REQUEST:
        raise ValueError("Outgoing native message too large")
    return struct.pack("=I", len(data)) + data


def error(code, message, *, unknown=False):
    return {"ok": False, "error": {"code": code, "message": message, "outcome": "unknown" if unknown else "not_performed"}}


@dataclass
class Pending:
    request_id: str
    fingerprint: str
    mutating: bool
    method: str = ""
    session_id: str | None = None
    control_token: str | None = None
    operation_id: str | None = None
    coordinator_lease: object | None = None
    binding_generation: int = 0
    sent: bool = False
    created: float = field(default_factory=time.monotonic)
    done: threading.Event = field(default_factory=threading.Event)
    response: dict | None = None


@dataclass
class ControlLease:
    session_id: str
    token: str
    owner_label: str
    renewed: float = field(default_factory=time.monotonic)
    inflight: int = 0
    coordinator_lease: object | None = None


class Bridge:
    def __init__(self, socket_path, stdout=None, timeout=TIMEOUT, registry_path=None):
        self.path = Path(socket_path)
        self.stdout = stdout or sys.stdout.buffer
        self.timeout = timeout
        self.lock = threading.Lock()
        self.write_lock = threading.Lock()
        self.pending = {}
        self.receipts = {}
        self.session_id = None
        self.binding_generation = 0
        self.document_id = None
        self.extension_runtime = None
        self.coordinator = Coordinator(registry_path or default_registry_path())
        self.coordinator_error = None
        self.control = None
        self.stopped = threading.Event()
        self.listener = None
        self.identity = None
        self.workers = threading.BoundedSemaphore(32)
        self.diagnostics = None
        self.transport_secret = None

    def bind(self):
        if WINDOWS:
            return self._bind_windows()
        # Never replace a pre-existing endpoint: it may belong to another profile.
        parent = self.path.parent
        try:
            parent.mkdir(mode=0o700)
        except FileExistsError:
            pass
        st = parent.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != 0o700:
            raise PermissionError("Socket directory must be an owned, non-symlink directory with mode 0700")
        if not self.path.is_absolute():
            raise ValueError("Socket path must be absolute")
        if os.path.lexists(self.path):
            raise FileExistsError("Bridge endpoint already exists; detach the other bridge or inspect the stale socket manually")
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            # Protect the inode at creation time, before chmod.
            previous = os.umask(0o177)
            try:
                listener.bind(str(self.path))
            finally:
                os.umask(previous)
            os.chmod(self.path, 0o600)
            inode = self.path.lstat()
            self.identity = (inode.st_dev, inode.st_ino)
            listener.listen(16)
            listener.settimeout(0.25)
            self.listener = listener
            self.diagnostics = DiagnosticLog(parent / "bridge.log")
            self.diag("start")
        except BaseException:
            listener.close()
            self._unlink_owned()
            raise

    def _bind_windows(self):
        ensure_private_directory(self.path.parent)
        if os.path.lexists(self.path):
            raise FileExistsError("Bridge endpoint already exists; detach the other bridge or inspect the stale descriptor manually")
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        fd = None
        try:
            # Never expose a listener outside this computer, or reuse another
            # listener's address. Endpoint authentication additionally proves
            # server identity before a client sends any browser capability.
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            listener.bind(("127.0.0.1", 0))
            listener.listen(16)
            listener.settimeout(0.25)
            self.transport_secret = secrets.token_hex(32)
            descriptor = {"v": 1, "transport": "tcp", "host": "127.0.0.1", "port": listener.getsockname()[1], "token": self.transport_secret}
            fd = secure_open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
            info = os.fstat(fd)
            self.identity = (info.st_dev, info.st_ino)
            os.write(fd, json.dumps(descriptor, separators=(",", ":")).encode("utf-8"))
            os.fsync(fd)
            os.close(fd)
            fd = None
            self.listener = listener
            self.diagnostics = DiagnosticLog(self.path.parent / "bridge.log")
            self.diag("start")
        except BaseException:
            if fd is not None:
                os.close(fd)
            listener.close()
            self._unlink_owned()
            raise

    @staticmethod
    def _read_line(client, limit):
        raw = bytearray()
        while b"\n" not in raw:
            data = client.recv(min(65536, limit + 1 - len(raw)))
            if not data:
                raise EOFError()
            raw.extend(data)
            if len(raw) > limit:
                raise ValueError("Local request exceeds framing limit")
        first, _, rest = raw.partition(b"\n")
        if rest.strip():
            raise ValueError("Only one request is allowed per message")
        return json.loads(first.decode("utf-8"))

    def _authenticate_windows(self, client):
        hello = self._read_line(client, 4096)
        if not isinstance(hello, dict) or hello.get("v") != 1 or hello.get("type") != "transport_hello" or not re.fullmatch(r"[0-9a-f]{64}", str(hello.get("nonce", ""))):
            raise ValueError("Invalid transport handshake")
        client_nonce = hello["nonce"]
        server_nonce = secrets.token_hex(32)
        def proof(role):
            return hmac.new(bytes.fromhex(self.transport_secret), f"{role}:{client_nonce}:{server_nonce}".encode("ascii"), hashlib.sha256).hexdigest()
        client.sendall(json.dumps({"v": 1, "type": "transport_challenge", "nonce": server_nonce, "proof": proof("server")}, separators=(",", ":")).encode("ascii") + b"\n")
        request = self._read_line(client, MAX_REQUEST)
        if not isinstance(request, dict) or not hmac.compare_digest(str(request.pop("transportProof", "")), proof("client")):
            raise PermissionError("Transport authentication failed")
        return request

    def diag(self, event, **fields):
        if self.diagnostics:
            self.diagnostics.write(event, **fields)

    def serve(self):
        while not self.stopped.is_set():
            try:
                client, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            if not self.workers.acquire(blocking=False):
                client.close()
                continue
            threading.Thread(target=self._client, args=(client,), daemon=True).start()

    def _client(self, client):
        request = None
        try:
            client.settimeout(self.timeout + 2)
            # Linux credentials add defense in depth beyond the socket permissions.
            if hasattr(socket, "SO_PEERCRED"):
                _, uid, _ = struct.unpack("3i", client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                if uid != os.getuid():
                    return
            request = self._authenticate_windows(client) if WINDOWS else self._read_line(client, MAX_REQUEST)
            response = self.request(request)
            response.update({"v": LOCAL_PROTOCOL, "type": "response", "id": request.get("id")})
            client.sendall(json.dumps(response, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8") + b"\n")
        except (ValueError, TypeError, UnicodeError, json.JSONDecodeError):
            try:
                response = error("INVALID_ARGUMENT", "Malformed or oversized bridge request")
                response.update({"v": LOCAL_PROTOCOL, "type": "response", "id": request.get("id") if isinstance(request, dict) else None})
                client.sendall(json.dumps(response).encode() + b"\n")
            except OSError:
                pass
        except (OSError, EOFError):
            pass  # A caller leaving does not cancel or replay its browser mutation.
        finally:
            client.close()
            self.workers.release()

    def request(self, request):
        try:
            return self._request(request)
        except CoordinationError as exc:
            self.coordinator_error = exc.code
            return error(exc.code, str(exc))
        except (sqlite3.Error, OSError):
            self.coordinator_error = "COORDINATOR_UNAVAILABLE"
            return error("COORDINATOR_UNAVAILABLE", "Shared document arbitration is unavailable; no new browser action is authorized. Inspect diagnostics and restore the private registry")

    def _extension_compatible(self):
        expected = {**HOST_RUNTIME, "protocol": EXTENSION_PROTOCOL}
        return isinstance(self.extension_runtime, dict) and all(self.extension_runtime.get(key) == value for key, value in expected.items())

    def _metadata(self):
        try:
            coordination = self.coordinator.status(self.document_id)
            self.coordinator_error = None
        except (CoordinationError, sqlite3.Error, OSError) as exc:
            coordination = {"state": "unavailable", "nextStep": "Restore the private shared registry before acquiring control"}
            self.coordinator_error = exc.code if isinstance(exc, CoordinationError) else "COORDINATOR_UNAVAILABLE"
        try:
            control = self._public_control(time.monotonic())
        except (CoordinationError, sqlite3.Error, OSError):
            control = {"held": bool(self.control), "state": "coordinator_unavailable"}
        result = {"attached": bool(self.session_id), "sessionId": self.session_id, "documentId": self.document_id,
                  "control": control, "bridgeProtocol": LOCAL_PROTOCOL,
                  "runtime": {"host": HOST_RUNTIME, "extension": self.extension_runtime},
                  "coordinator": coordination, "coordinatorError": self.coordinator_error}
        if not self._extension_compatible():
            result["nextStep"] = "Reload this profile's extension during an owner-confirmed pause, explicitly attach the intended document, then use fresh session/control/snapshot IDs"
        return result

    def _request(self, request):
        if not isinstance(request, dict):
            raise ValueError("Request must be an object")
        method, rid, params = request.get("method"), request.get("id"), request.get("params")
        if request.get("v") != LOCAL_PROTOCOL:
            return error("RECONNECT_REQUIRED", "MCP and native host protocol versions differ; update the named profile before using new tools")
        if request.get("type") != "request" or method not in METHODS:
            raise ValueError("Unsupported method or protocol")
        if not isinstance(rid, str) or not 1 <= len(rid) <= 128 or not isinstance(params, dict):
            raise ValueError("Invalid request shape")
        if method not in ("status", "diagnostics"):
            client = request.get("client")
            if not isinstance(client, dict) or any(client.get(key) != value for key, value in HOST_RUNTIME.items()) or not self._extension_compatible():
                return error("RECONNECT_REQUIRED", "MCP, native host and extension must match the configured profile, build and protocol before control or browser operations")
        session = request.get("sessionId")
        if method not in ("status", "diagnostics") and (not isinstance(session, str) or not 1 <= len(session) <= 128):
            raise ValueError("sessionId required")
        token = request.get("controlToken")
        mutating = method in MUTATIONS
        op = request.get("operation_id")
        if mutating and (not isinstance(op, str) or not 8 <= len(op) <= 128):
            raise ValueError("Mutations require a unique operation_id (8..128 characters)")
        fingerprint = hashlib.sha256(json.dumps([session, method, params], sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).hexdigest()
        replay = False
        with self.lock:
            if self.stopped.is_set():
                return error("NOT_CONNECTED", "Native bridge has disconnected")
            if method == "diagnostics":
                return {"ok": True, "result": self._metadata()}
            now = time.monotonic()
            self._expire_control(now)
            if method in CONTROL_METHODS:
                return self._control_request(method, session, token, params, now)
            if method != "status":
                denied = self._check_control(session, token, now)
                if denied:
                    return denied
            # Ownership is checked before receipt lookup. A receipt never grants
            # control, and the secret token is intentionally not fingerprinted.
            self.receipts = {key: value for key, value in self.receipts.items() if now - value.created < CACHE_TTL or not value.done.is_set()}
            pending = self.receipts.get(op) if mutating else None
            if pending:
                if pending.fingerprint != fingerprint:
                    return error("OPERATION_ID_CONFLICT", "operation_id is already bound to another session, method, or payload")
                replay = True
            else:
                if rid in self.pending:
                    return error("DUPLICATE_REQUEST_ID", "Request id is already pending")
                if len(self.pending) >= MAX_PENDING:
                    return error("BRIDGE_BUSY", "Too many unsettled requests; inspect the connection before continuing")
                if mutating and len(self.receipts) >= CACHE_LIMIT:
                    return error("RECEIPT_CACHE_FULL", "Receipt cache is full; wait for expiry without reusing operation IDs")
                lease = self.control.coordinator_lease if method != "status" else None
                if mutating:
                    # Commit durable intent before any bytes can reach Chrome.
                    self.coordinator.begin(lease, op, fingerprint)
                pending = Pending(rid, fingerprint, mutating, method=method, session_id=session,
                                  control_token=token if method != "status" else None,
                                  operation_id=op if mutating else None, coordinator_lease=lease,
                                  binding_generation=self.binding_generation)
                self.pending[rid] = pending
                if pending.control_token:
                    self.control.inflight += 1
                if mutating:
                    self.receipts[op] = pending
        if not replay:
            try:
                payload = {"v": EXTENSION_PROTOCOL, "type": "request", "id": rid, "method": method, "params": params}
                if session is not None:
                    payload["sessionId"] = session
                with self.write_lock:
                    # Keep revocation and sending ordered. A prior authorisation
                    # outside this lock cannot survive a session/control change.
                    with self.lock:
                        if method != "status":
                            denied = self._check_control(session, token, time.monotonic())
                            if denied:
                                self._complete_locked(rid, denied)
                            else:
                                self.coordinator.authorize(pending.coordinator_lease, mutating=mutating)
                                pending.sent = True
                                self.stdout.write(encode_native(payload))
                                self.stdout.flush()
                        else:
                            pending.sent = True
                            self.stdout.write(encode_native(payload))
                            self.stdout.flush()
            except (CoordinationError, sqlite3.Error) as exc:
                code = exc.code if isinstance(exc, CoordinationError) else "COORDINATOR_UNAVAILABLE"
                self.complete(rid, error(code, "Document authority could not be verified before dispatch; inspect diagnostics", unknown=mutating and pending.sent), settled=not pending.sent)
            except (OSError, ValueError):
                self.complete(rid, error("BRIDGE_WRITE_FAILED", "Native messaging write failed; observe before any further mutation", unknown=mutating and pending.sent), settled=not pending.sent)
        if not pending.done.wait(self.timeout):
            self.complete(pending.request_id, error("TIMEOUT", "No receipt arrived. Observe the document; never automatically repeat an uncertain mutation", unknown=mutating), settled=False)
        with self.lock:
            response = dict(pending.response or error("DISCONNECTED", "Bridge disconnected", unknown=mutating))
            if method == "status" and response.get("ok") is True and isinstance(response.get("result"), dict):
                response["result"] = {**response["result"], **self._metadata()}
        self.diag("request", method=method, ok=response.get("ok"),
                  code=(response.get("error") or {}).get("code"),
                  ms=max(0, int((time.monotonic() - pending.created) * 1000)))
        if mutating:
            response["receipt"] = {"operation_id": op, "replayed": replay, "retentionSeconds": int(CACHE_TTL), "durable": False}
        return response

    def _expire_control(self, now):
        if self.control and self.control.inflight == 0 and now - self.control.renewed >= CONTROL_TTL:
            self.coordinator.release(self.control.coordinator_lease)
            self.control = None

    def _public_control(self, now):
        self._expire_control(now)
        if not self.control:
            return {"held": False, "idleTimeoutSeconds": int(CONTROL_TTL)}
        return {"held": True, "ownerLabel": self.control.owner_label,
                "sessionId": self.control.session_id, "inflight": self.control.inflight,
                "mode": self.control.coordinator_lease.mode,
                "generation": self.control.coordinator_lease.generation,
                "expiresInSeconds": max(0, int(CONTROL_TTL - (now - self.control.renewed))),
                "idleTimeoutSeconds": int(CONTROL_TTL)}

    def _check_control(self, session, token, now):
        if session != self.session_id:
            return error("SESSION_MISMATCH", "Control belongs to the currently attached Google Vids session only")
        if not self.control:
            return error("CONTROL_REQUIRED", "Acquire control of this session before observing or editing")
        if not isinstance(token, str) or not secrets.compare_digest(token, self.control.token):
            return error("CONTROL_BUSY", "This Vids session is controlled by another task; do not override it")
        if session != self.control.session_id:
            return error("SESSION_MISMATCH", "Control token belongs to a different attached session")
        self.coordinator.authorize(self.control.coordinator_lease)
        self.control.renewed = now
        return None

    def _control_request(self, method, session, token, params, now):
        if session != self.session_id or self.session_id is None:
            return error("SESSION_MISMATCH", "Use the current attached sessionId from vids_status")
        if method == "acquire_control":
            label = params.get("ownerLabel")
            if not isinstance(label, str) or not 1 <= len(label.strip()) <= 120:
                raise ValueError("ownerLabel must be 1..120 nonblank characters")
            if self.control:
                return error("CONTROL_BUSY", "This Vids session is controlled by another task; wait for release or idle expiry")
            lease = self.coordinator.acquire(self.document_id, PROFILE["id"], session, label.strip())
            self.control = ControlLease(session, secrets.token_urlsafe(32), label.strip(), renewed=now, coordinator_lease=lease)
            return {"ok": True, "result": {"controlToken": self.control.token,
                    "sessionId": session, "ownerLabel": self.control.owner_label,
                    "idleTimeoutSeconds": int(CONTROL_TTL), "mode": lease.mode, "generation": lease.generation}}
        denied = self._check_control(session, token, now)
        if denied:
            return denied
        if method == "renew_control":
            return {"ok": True, "result": {"renewed": True, "idleTimeoutSeconds": int(CONTROL_TTL)}}
        if self.control.inflight:
            return error("CONTROL_IN_FLIGHT", "Control cannot be released while browser requests are unsettled; wait for completion or reconnect the extension")
        if method == "reconcile_control":
            self.coordinator.reconcile(self.control.coordinator_lease, params.get("evidence"), params.get("acknowledgeUnknown"))
            return {"ok": True, "result": {"reconciled": True, "mode": "write", "oldOutcomePreserved": True}}
        self.coordinator.release(self.control.coordinator_lease)
        self.control = None
        return {"ok": True, "result": {"released": True}}

    def _complete_locked(self, rid, response, settled=True):
        pending = self.pending.get(rid)
        if not pending:
            return
        if pending.mutating and pending.coordinator_lease:
            outcome = "succeeded" if response.get("ok") else "unknown" if (response.get("error") or {}).get("outcome") == "unknown" else "not_performed"
            try:
                self.coordinator.finish(pending.coordinator_lease, pending.operation_id, outcome, settled)
            except (CoordinationError, sqlite3.Error, OSError):
                self.coordinator_error = "COORDINATOR_UNAVAILABLE"
                # No durable completion means no transferable authority. Keep
                # the pending guard and return uncertainty, never a false PASS.
                response = error("COORDINATOR_UNAVAILABLE", "Durable arbitration could not record the operation outcome; inspect diagnostics before further mutations", unknown=pending.sent)
                settled = False
        if settled:
            self.pending.pop(rid, None)
            if self.control and pending.control_token == self.control.token:
                self.control.inflight -= 1
                self.control.renewed = time.monotonic()
        if not pending.done.is_set():
            pending.response = response
            pending.done.set()

    def complete(self, rid, response, *, settled=True):
        with self.lock:
            self._complete_locked(rid, response, settled)

    def _session_status(self, status, fence_receipts=None, expected_generation=None):
        if not isinstance(status, dict) or not isinstance(status.get("attached"), bool):
            return False
        runtime = (status.get("runtime") or {}).get("extension")
        session = status.get("sessionId") if status["attached"] else None
        if status["attached"] and (not isinstance(session, str) or not 1 <= len(session) <= 128):
            return False
        document = status.get("documentId") if status["attached"] else None
        if status["attached"] and (not isinstance(document, str) or not 1 <= len(document) <= 256):
            return False
        with self.lock:
            if expected_generation is not None and expected_generation != self.binding_generation:
                return False
            self.extension_runtime = runtime if isinstance(runtime, dict) else None
            if not self._extension_compatible():
                return False
            if session is not None and session == self.session_id and document != self.document_id:
                return False
            try:
                self.coordinator.record_fences(PROFILE["id"], fence_receipts or [])
            except (CoordinationError, sqlite3.Error, OSError):
                self.coordinator_error = "COORDINATOR_UNAVAILABLE"
            if session != self.session_id:
                for rid, pending in list(self.pending.items()):
                    if pending.session_id and pending.session_id != session:
                        self._complete_locked(rid, error("DISCONNECTED", "The attached session changed; old control and snapshots are invalid", unknown=pending.mutating))
                if self.control:
                    try:
                        self.coordinator.release(self.control.coordinator_lease, abandoned=True)
                    except (CoordinationError, sqlite3.Error, OSError):
                        self.coordinator_error = "COORDINATOR_UNAVAILABLE"
                self.control = None
                self.session_id = session
                self.document_id = document
                self.binding_generation += 1
        return True

    def receive(self, message):
        if message.get("v") != EXTENSION_PROTOCOL:
            return
        if message.get("type") == "diagnostic":
            self.diag("cdp", phase=message.get("phase"), method=message.get("method"), elapsedMs=message.get("elapsedMs"))
            return
        if message.get("type") in ("hello", "event"):
            status = message.get("status")
            event = "hello" if message.get("type") == "hello" else message.get("event")
            self.diag(event, attached=status.get("attached") if isinstance(status, dict) else None)
            self._session_status(status, message.get("fenceReceipts"))
            return
        if message.get("type") == "response" and isinstance(message.get("id"), str):
            if message.get("ok") is True:
                with self.lock:
                    pending = self.pending.get(message["id"])
                    is_status = pending is not None and pending.method == "status"
                if is_status:
                    if not self._session_status(message.get("result"), expected_generation=pending.binding_generation):
                        self.complete(message["id"], error("STALE_STATUS", "Status belongs to an old or incompatible attachment; request current diagnostics/status again"))
                        return
                self.complete(message["id"], {"ok": True, "result": message.get("result")})
            elif message.get("ok") is False:
                self.complete(message["id"], {"ok": False, "error": message.get("error", {"code": "EXTENSION_ERROR", "message": "Extension rejected operation"})})

    def _unlink_owned(self):
        if self.identity:
            try:
                st = self.path.lstat()
                expected_type = stat.S_ISREG(st.st_mode) if WINDOWS else stat.S_ISSOCK(st.st_mode)
                if expected_type and (st.st_dev, st.st_ino) == self.identity:
                    self.path.unlink()
            except FileNotFoundError:
                pass

    def close(self):
        self.stopped.set()
        if self.listener:
            self.listener.close()
        with self.lock:
            for pending in self.pending.values():
                pending.response = error("DISCONNECTED", "Native host connection lost; observe before another mutation", unknown=pending.mutating)
                pending.done.set()
            if self.control:
                try:
                    self.coordinator.release(self.control.coordinator_lease, abandoned=True)
                except (CoordinationError, sqlite3.Error, OSError):
                    pass  # The persisted generation still requires fencing.
            self.control = None
            self.session_id = None
            self.document_id = None
            self.binding_generation += 1
            self.pending.clear()
        self._unlink_owned()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", type=Path, default=default_socket_path())
    parser.add_argument("--registry", type=Path, default=default_registry_path())
    parser.add_argument("--parent-window", default=None)  # Chrome supplies this on Windows.
    parser.add_argument("chrome_origin", nargs="?")  # Chrome appends its extension origin.
    args = parser.parse_args()
    if WINDOWS:
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    bridge = Bridge(args.socket, registry_path=args.registry)
    exit_reason = "host_error"

    def stop(*_):
        nonlocal exit_reason
        exit_reason = "sigterm"
        # No locks or I/O in a signal handler: it may interrupt a log write.
        sys.exit(0)

    try:
        bridge.bind()
        signal.signal(signal.SIGTERM, stop)
        threading.Thread(target=bridge.serve, daemon=True).start()
        while True:
            bridge.receive(read_native(sys.stdin.buffer))
    except EOFError:
        exit_reason = "stdin_eof"
        return 0
    except (ValueError, OSError) as exc:
        print(f"vids-studio bridge: {exc}", file=sys.stderr)
        return 1
    finally:
        bridge.diag("exit", reason=exit_reason)
        bridge.close()


if __name__ == "__main__":
    sys.exit(main())
