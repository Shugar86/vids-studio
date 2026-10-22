"""Cross-profile local media admission; never browser authority or recovery.

A normal release requires the Node supervisor to confirm every media child has
exited. Pipe loss leaves a durable marker. A dead PID or elapsed time is not
used to reclaim that marker: an orphaned decoder may still be running.
"""
import argparse
import contextlib
import json
import os
from pathlib import Path
import queue
import re
import sys
import threading
import time
import uuid

from fleet import FleetRegistry, Resources, default_directory
from platform_support import assert_private_file, ensure_private_directory, lock_file, secure_open


def directory_default():
    return Path(os.environ.get("VIDS_STUDIO_MEDIA_BUDGET_DIR") or default_directory().parent / "media-budget")


def budget_limit(sample):
    """Unknown metrics admit one checker. Measurements can admit a second."""
    free, cpu = sample.get("memoryAvailableBytes"), sample.get("cpuPercent")
    if free is not None and free < 512 * 1024**2:
        return 0
    return 2 if free is not None and free >= 4 * 1024**3 and cpu is not None and cpu < 70 else 1


def read_marker(path):
    assert_private_file(path)
    fd = secure_open(path, os.O_RDONLY)
    try:
        if os.fstat(fd).st_size > 4096:
            raise ValueError("Invalid media permit metadata")
        value = json.loads(os.read(fd, 4097))
        if value.get("schemaVersion") != 1 or not isinstance(value.get("leaseId"), str):
            raise ValueError("Invalid media permit metadata")
        return value
    finally:
        os.close(fd)


def snapshot(directory):
    result = {"schemaVersion": 1, "maxSlots": 2, "slots": []}
    if not directory.exists():
        return result
    ensure_private_directory(directory)
    for index in range(2):
        marker = directory / f"slot-{index}.json"
        if marker.exists():
            value = read_marker(marker)
            result["slots"].append({"slot": index, **{key: value.get(key) for key in ("leaseId", "jobId", "ownerPid", "helperPid", "startedAt")}})
    return result


def reserve(directory, owner, maximum):
    """Serialize only admission; all occupied/unknown slots count after downshift."""
    admission = secure_open(directory / "admission.lock", os.O_RDWR | os.O_CREAT)
    try:
        assert_private_file(directory / "admission.lock")
        try:
            lock_file(admission)
        except BlockingIOError:
            return None, False
        occupied, stale = set(), 0
        for index in range(2):
            marker = directory / f"slot-{index}.json"
            if not marker.exists():
                continue
            read_marker(marker)
            occupied.add(index)
            fd = secure_open(directory / f"slot-{index}.lock", os.O_RDWR | os.O_CREAT)
            try:
                assert_private_file(directory / f"slot-{index}.lock")
                try:
                    lock_file(fd)
                    stale += 1
                except BlockingIOError:
                    pass
            finally:
                os.close(fd)
        if len(occupied) >= maximum:
            return None, maximum > 0 and stale >= maximum
        for index in range(2):
            if index in occupied:
                continue
            fd = secure_open(directory / f"slot-{index}.lock", os.O_RDWR | os.O_CREAT)
            try:
                assert_private_file(directory / f"slot-{index}.lock")
                try:
                    lock_file(fd)
                except BlockingIOError:
                    os.close(fd)
                    continue
                lease = str(uuid.uuid4())
                marker = directory / f"slot-{index}.json"
                record = {"schemaVersion": 1, "leaseId": lease, "jobId": owner["jobId"], "ownerPid": owner["ownerPid"], "helperPid": os.getpid(), "startedAt": time.time()}
                metadata = secure_open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
                try:
                    os.write(metadata, json.dumps(record, separators=(",", ":")).encode())
                    os.fsync(metadata)
                finally:
                    os.close(metadata)
                return (fd, index, marker, lease), False
            except BaseException:
                os.close(fd)
                raise
        return None, False
    finally:
        os.close(admission)


def acquire(directory, owner, inbox, emit, *, wait_seconds=600, resources=None):
    if not isinstance(owner, dict) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", str(owner.get("jobId", ""))) or type(owner.get("ownerPid")) is not int or owner["ownerPid"] <= 0:
        raise ValueError("Invalid media owner")
    ensure_private_directory(directory)
    resources = resources or Resources()
    deadline, last_wait = time.monotonic() + wait_seconds, 0
    while time.monotonic() < deadline:
        if not inbox.empty():
            return 0
        sample = resources.sample()
        maximum = budget_limit(sample)
        try:
            policy = FleetRegistry().snapshot()["policy"]
            maximum = min(maximum, policy.get("maxConcurrency", 1))
            if policy.get("paused"):
                maximum = 0
        except (OSError, ValueError, KeyError):
            maximum = 0
        reservation, stale = reserve(directory, owner, maximum)
        if reservation:
            fd, index, marker, lease = reservation
            try:
                emit({"event": "acquired", "slot": index, "leaseId": lease, "effectiveSlots": maximum})
                command = inbox.get()
                if isinstance(command, dict) and ((command.get("action") == "release" and command.get("leaseId") == lease) or command.get("action") == "cancel"):
                    if read_marker(marker)["leaseId"] != lease:
                        raise ValueError("Media permit identity changed")
                    marker.unlink()
                    emit({"event": "released"})
                return 0
            finally:
                os.close(fd)
        if stale:
            emit({"event": "error", "code": "MEDIA_PERMIT_UNCONFIRMED", "message": "A previous local verifier did not confirm exit. Inspect media_budget.py status and stop the old media processes before explicitly clearing the permit."})
            return 1
        if time.monotonic() - last_wait >= 2:
            emit({"event": "waiting", "reason": "resource_pressure_or_pause" if maximum == 0 else "local_capacity", "effectiveSlots": maximum})
            last_wait = time.monotonic()
        try:
            inbox.get(timeout=.25)
            return 0
        except queue.Empty:
            pass
    emit({"event": "error", "code": "MEDIA_CAPACITY_TIMEOUT", "message": "Local verification capacity did not become available in time; the source download is unchanged."})
    return 1


def clear(directory, index, lease):
    """Explicit operator-only acknowledgement; no inference from PIDs or TTL."""
    ensure_private_directory(directory)
    fd = secure_open(directory / f"slot-{index}.lock", os.O_RDWR | os.O_CREAT)
    try:
        lock_file(fd)  # An active supervisor cannot be cleared.
        marker = directory / f"slot-{index}.json"
        if read_marker(marker)["leaseId"] != lease:
            raise ValueError("Permit changed; inspect it again")
        marker.unlink()
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("acquire", "status", "clear"))
    parser.add_argument("--directory", type=Path, default=directory_default())
    parser.add_argument("--wait-seconds", type=float, default=600)
    parser.add_argument("--slot", type=int, choices=(0, 1))
    parser.add_argument("--lease-id")
    parser.add_argument("--acknowledge-media-stopped", action="store_true")
    args = parser.parse_args()
    def emit(value):
        sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    try:
        if args.command == "status":
            emit({"ok": True, "result": snapshot(args.directory)})
            return 0
        if args.command == "clear":
            if args.slot is None or not args.lease_id or not args.acknowledge_media_stopped:
                raise ValueError("Clearing requires a slot, its observed lease ID and an explicit acknowledgement that old media processes stopped")
            clear(args.directory, args.slot, args.lease_id)
            emit({"ok": True})
            return 0
        raw = sys.stdin.readline(4097)
        if len(raw) > 4096 or not 0 < args.wait_seconds <= 3600:
            raise ValueError("Invalid request limit")
        owner = json.loads(raw)
        inbox = queue.Queue(maxsize=1)
        def listen():
            try:
                message = sys.stdin.readline(4097)
                inbox.put(json.loads(message) if message and len(message) <= 4096 else None)
            except (ValueError, OSError):
                inbox.put(None)
        threading.Thread(target=listen, daemon=True).start()
        return acquire(args.directory, owner, inbox, emit, wait_seconds=args.wait_seconds)
    except (OSError, ValueError, KeyError) as error:
        try:
            emit({"event": "error", "code": "MEDIA_BUDGET_UNAVAILABLE", "message": "Private local verification admission is unavailable; inspect its permissions and permit status."})
        except (OSError, BrokenPipeError):
            pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
