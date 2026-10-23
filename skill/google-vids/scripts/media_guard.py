"""Shared local media admission for skill helpers (no browser authority).

Use one ``with media_budget('helper-name') as guard`` for a workflow and launch
its FFmpeg/ffprobe/whisper executables through ``guard.run``. Do not wrap a
second budgeted helper inside it. Only direct executables are supervised: shell
wrappers or programs that detach descendants are outside this contract.

Cancellation/timeout waits for the media process to exit before releasing its
permit. Abrupt supervisor/keeper death retains the native durable marker; it
requires the existing explicit operator acknowledgement, never PID/TTL cleanup.
"""
import contextvars
import json
import math
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid

_ACTIVE = contextvars.ContextVar("vids_media_guard", default=False)
_HELPER = Path(__file__).resolve().parents[3] / "native/media_budget.py"


class MediaBudgetError(RuntimeError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(f"{code}: {message}")


def media_tool(name):
    """Find an installed tool; explicit overrides must be absolute executables."""
    if name not in ("ffmpeg", "ffprobe"):
        raise ValueError("Expected ffmpeg or ffprobe")
    configured = os.environ.get("VIDS_STUDIO_" + name.upper())
    if configured and not Path(configured).is_absolute():
        raise ValueError(f"{name} override must be an absolute executable path")
    found = shutil.which(configured or name)
    if not found:
        raise ValueError(f"{name} is not available; install or configure it separately")
    return found


def _stop(process):
    """Never treat kill() itself as evidence of exit."""
    if process.poll() is None:
        try:
            process.kill()
        except ProcessLookupError:
            pass
    while True:
        try:
            process.wait()
            return
        except KeyboardInterrupt:
            # A repeated interrupt must not release while media still runs.
            continue


class MediaBudget:
    def __init__(self, name, *, wait_seconds=600, env=None):
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", name):
            raise ValueError("Use an opaque helper name, not a filename or document ID")
        if not math.isfinite(wait_seconds) or not 0 < wait_seconds <= 3600:
            raise ValueError("wait_seconds must be between zero and 3600")
        self.name, self.wait_seconds = name, wait_seconds
        self.env = dict(os.environ if env is None else env)
        self.keeper = self.lease = self.token = None
        self.messages = queue.Queue()
        self.lost = False

    def _read(self):
        try:
            while True:
                line = self.keeper.stdout.readline(16385)
                if not line:
                    break
                if len(line) > 16384:
                    raise ValueError("Oversized keeper response")
                self.messages.put(json.loads(line))
        except (OSError, ValueError):
            pass
        finally:
            self.messages.put(None)

    def _message(self, timeout):
        try:
            message = self.messages.get(timeout=timeout)
        except queue.Empty:
            if self.keeper.poll() is None:
                return {}
            message = None
        if not isinstance(message, dict):
            self.lost = True
            raise MediaBudgetError("MEDIA_BUDGET_LOST", "Admission keeper stopped; inspect native/media_budget.py status before retrying.")
        if message.get("event") == "error":
            self.lost = True
            raise MediaBudgetError(message.get("code", "MEDIA_BUDGET_UNAVAILABLE"), message.get("message", "Local media admission failed."))
        return message

    def _send(self, message):
        try:
            self.keeper.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
            self.keeper.stdin.flush()
        except (OSError, ValueError):
            self.lost = True
            raise MediaBudgetError("MEDIA_BUDGET_LOST", "Admission keeper connection was lost; its permit may remain unconfirmed.") from None

    def __enter__(self):
        if self.keeper is not None or _ACTIVE.get():
            raise ValueError("Reuse the active media guard; nested admission is not supported")
        self.token = _ACTIVE.set(True)
        try:
            self.keeper = subprocess.Popen([sys.executable, str(_HELPER), "acquire", "--wait-seconds", str(self.wait_seconds)],
                                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                           text=True, encoding="utf-8", env=self.env)
            threading.Thread(target=self._read, daemon=True).start()
            self._send({"jobId": f"{self.name}-{uuid.uuid4().hex}", "ownerPid": os.getpid()})
            deadline = time.monotonic() + self.wait_seconds + 5
            while time.monotonic() < deadline:
                message = self._message(.1)
                if message.get("event") == "acquired" and isinstance(message.get("leaseId"), str):
                    self.lease = message["leaseId"]
                    return self
                if message and message.get("event") != "waiting":
                    raise MediaBudgetError("MEDIA_BUDGET_UNAVAILABLE", "Unexpected admission response")
            raise MediaBudgetError("MEDIA_CAPACITY_TIMEOUT", "Local media capacity did not become available.")
        except BaseException:
            self._close(acquiring=True)
            raise

    def _check(self):
        if self.lease is None or self.lost:
            raise MediaBudgetError("MEDIA_BUDGET_LOST", "Local media admission is not active")
        message = self._message(0)
        if message:
            self.lost = True
            raise MediaBudgetError("MEDIA_BUDGET_LOST", "Unexpected message while local media was running")

    def run(self, args, *, capture_output=False, check=False, timeout=600, input=None, **kwargs):
        """subprocess.run-style result, with bounded waiting and confirmed cleanup."""
        self._check()
        if kwargs.get("shell") or isinstance(args, (str, bytes)):
            raise ValueError("Pass an argument list for a direct media executable; shell wrappers are unsupported")
        if timeout is not None and (not math.isfinite(timeout) or timeout <= 0):
            raise ValueError("timeout must be positive")
        if capture_output:
            if "stdout" in kwargs or "stderr" in kwargs:
                raise ValueError("capture_output cannot be combined with stdout/stderr")
            kwargs.update(stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if input is not None:
            if "stdin" in kwargs:
                raise ValueError("input cannot be combined with stdin")
            kwargs["stdin"] = subprocess.PIPE
        kwargs.setdefault("stdin", subprocess.DEVNULL)
        kwargs.setdefault("env", self.env)
        try:
            child = subprocess.Popen(args, **kwargs)
        except (KeyboardInterrupt, SystemExit):
            # Creation may have reached the OS without returning its handle.
            # Retain admission because this caller cannot confirm child exit.
            self.lost = True
            raise
        deadline = time.monotonic() + timeout if timeout is not None else None
        try:
            while True:
                self._check()
                if deadline is not None and time.monotonic() >= deadline:
                    raise subprocess.TimeoutExpired(args, timeout)
                try:
                    stdout, stderr = child.communicate(input=input, timeout=.1)
                    break
                except subprocess.TimeoutExpired:
                    input = None
            self._check()
            result = subprocess.CompletedProcess(args, child.returncode, stdout, stderr)
            if check:
                result.check_returncode()
            return result
        except BaseException:
            _stop(child)
            raise
        finally:
            for pipe in (child.stdin, child.stdout, child.stderr):
                if pipe is not None:
                    pipe.close()

    def _close(self, *, acquiring=False):
        failure = None
        try:
            if not acquiring and self.lease is not None and (self.lost or self.keeper.poll() is not None):
                raise MediaBudgetError("MEDIA_BUDGET_LOST", "Permit release was not confirmed; inspect native/media_budget.py status.")
            if self.keeper is not None and self.keeper.poll() is None and not self.lost:
                self._send({"action": "cancel"} if acquiring else {"action": "release", "leaseId": self.lease})
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    message = self._message(.1)
                    if message.get("event") == "released":
                        break
                    if acquiring and self.keeper.poll() is not None:
                        break
                else:
                    raise MediaBudgetError("MEDIA_BUDGET_LOST", "Permit release was not confirmed; inspect native/media_budget.py status.")
        except BaseException as error:
            failure = error
        finally:
            if self.keeper is not None:
                _stop(self.keeper)
                for pipe in (self.keeper.stdin, self.keeper.stdout):
                    if pipe is not None:
                        pipe.close()
            if self.token is not None:
                _ACTIVE.reset(self.token)
                self.token = None
        if failure and not acquiring:
            raise failure

    def __exit__(self, kind, value, traceback):
        try:
            self._close()
        except BaseException:
            if kind is None:
                raise
        return False


def media_budget(name, **kwargs):
    return MediaBudget(name, **kwargs)
