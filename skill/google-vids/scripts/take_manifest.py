#!/usr/bin/env python3
"""Keep local takes and review dependencies; never edit the Google Vids timeline."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from urllib.parse import urlparse

if os.name == "nt":
    import msvcrt
else:
    import fcntl

DEPENDENCIES = ("timing", "voice", "styled_captions", "soft_captions", "music", "sfx", "neighbors")
MAX_JSON_BYTES = 8 * 1024 * 1024


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def text(value, label, maximum=2000, empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not empty and not value.strip()):
        raise ValueError(f"{label} must be {'0' if empty else '1'}–{maximum} characters")
    return value.strip()


def identifier(value, label):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,120}", value):
        raise ValueError(f"{label} must be a short ASCII ID (letters, numbers, _, -, ., :)")
    return value


def number(value, label, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0 or (positive and value == 0):
        raise ValueError(f"{label} must be finite and {'positive' if positive else 'nonnegative'}")
    return float(value)


def safe_path(value):
    path = Path(value).expanduser().absolute()
    if any(component.is_symlink() or (component.exists() and getattr(component.lstat(), "st_file_attributes", 0) & 0x400) for component in (path, *path.parents)):
        raise ValueError("Symlink paths are not accepted")
    return path


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def evidence(values, require_files=True):
    if not isinstance(values, list) or len(values) > 32:
        raise ValueError("evidence must be a list of up to 32 file paths or HTTP(S) links")
    result = []
    for value in values:
        value = text(value, "evidence link", 4000)
        parsed = urlparse(value)
        if parsed.scheme in ("http", "https"):
            if not parsed.netloc or parsed.username or parsed.password:
                raise ValueError("Evidence URLs need a host and must not contain credentials")
            result.append(value)
        elif parsed.scheme and not Path(value).is_absolute():
            raise ValueError("Evidence accepts existing local files or HTTP(S) links only")
        else:
            path = safe_path(value)
            if require_files and not path.is_file():
                raise ValueError("Local evidence file does not exist")
            result.append(str(path))
    return result


def review_value(value, *, take=False, require_files=True):
    if not isinstance(value, dict):
        raise ValueError("review/verdict must be an object")
    allowed = {"accepted", "rejected", "unreviewed"} if take else {"verified", "failed", "not_applicable", "unresolved"}
    status = value.get("status")
    if status not in allowed:
        raise ValueError("Unsupported review status")
    reason = text(value.get("reason"), "review reason")
    links = evidence(value.get("evidence", []), require_files=require_files)
    if status in ("accepted", "rejected", "verified", "failed") and not links:
        raise ValueError("A reviewed result requires evidence links")
    return {"status": status, "reason": reason, "evidence": links}


def source_range(value, duration):
    if not isinstance(value, dict) or set(value) != {"start", "end"}:
        raise ValueError("source_range needs exactly start and end seconds")
    start, end = number(value["start"], "range start"), number(value["end"], "range end")
    if end <= start or end > duration + 0.000001:
        raise ValueError("source_range must have positive length and fit the measured source")
    return {"start": start, "end": min(end, duration)}


def probe(path, kind):
    if kind == "image":
        with path.open("rb") as stream:
            head = stream.read(16)
        if not (head.startswith((b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff", b"GIF87a", b"GIF89a")) or (head[:4] == b"RIFF" and head[8:12] == b"WEBP")):
            raise ValueError("Image source must be PNG, JPEG, GIF or WebP")
        return None
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise ValueError("Existing ffprobe is required to measure audio/video; nothing is installed")
    result = subprocess.run([ffprobe, "-v", "error", "-protocol_whitelist", "file,pipe", "-show_format", "-show_streams", "-of", "json", str(path)], capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise ValueError("ffprobe could not inspect the archived source")
    metadata = json.loads(result.stdout)
    stream = next((item for item in metadata.get("streams", []) if item.get("codec_type") == kind and not item.get("disposition", {}).get("attached_pic")), None)
    if stream is None:
        raise ValueError(f"Source has no {kind} stream")
    duration = float(stream.get("duration", metadata.get("format", {}).get("duration", "nan")))
    return number(duration, "measured duration", positive=True)


def archive_source(manifest_path, source):
    source = safe_path(text(source, "source path", 4000))
    if not source.is_file():
        raise ValueError("Source must be an existing regular local file")
    directory = safe_path(manifest_path.with_suffix(".takes"))
    directory.mkdir(mode=0o700, exist_ok=True)
    if not directory.is_dir():
        raise ValueError("Take archive path is not a directory")
    fd, temporary = tempfile.mkstemp(prefix=".take-", dir=directory)
    temporary = Path(temporary)
    try:
        with os.fdopen(fd, "wb") as target, source.open("rb") as original:
            shutil.copyfileobj(original, target, 1024 * 1024)
            target.flush()
            os.fsync(target.fileno())
        sha256 = digest(temporary)
        suffix = source.suffix.lower() if re.fullmatch(r"\.[a-zA-Z0-9]{1,10}", source.suffix) else ".media"
        archived = safe_path(directory / (sha256 + suffix))
        created = False
        try:
            os.link(temporary, archived)
            created = True
        except FileExistsError:
            if not archived.is_file() or digest(archived) != sha256:
                raise ValueError("An existing archived take has changed; refusing to overwrite it")
        sync_directory(directory)
        return source, archived, sha256, created
    finally:
        temporary.unlink(missing_ok=True)


def sync_directory(path):
    # Windows has no POSIX directory fsync; file data is flushed before replace.
    if os.name == "nt":
        return
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def read_json(path):
    if path.stat().st_size > MAX_JSON_BYTES:
        raise ValueError("JSON exceeds the 8 MiB limit")
    raw = path.read_bytes()
    if len(raw) > MAX_JSON_BYTES:
        raise ValueError("JSON exceeds the 8 MiB limit")
    return parse_json(raw)


def parse_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate JSON keys are not accepted")
            result[key] = value
        return result
    def invalid_constant(_):
        raise ValueError("Nonfinite JSON numbers are not accepted")
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)


def validate_manifest(data):
    if not isinstance(data, dict) or data.get("schema_version") != 1:
        raise ValueError("Unsupported manifest schema")
    identifier(data.get("project_id"), "project_id")
    if any(isinstance(data.get(key), bool) or not isinstance(data.get(key), int) or data[key] < 0 for key in ("revision", "timeline_revision")):
        raise ValueError("Manifest revisions must be nonnegative integers")
    if not isinstance(data.get("takes"), dict) or not isinstance(data.get("scenes"), list) or not isinstance(data.get("changes"), list):
        raise ValueError("Manifest needs takes, scenes and changes")
    for take_id, take in data["takes"].items():
        identifier(take_id, "take_id")
        if not isinstance(take, dict) or take.get("kind") not in ("video", "audio", "image") or not re.fullmatch(r"[0-9a-f]{64}", take.get("sha256", "")):
            raise ValueError("Invalid take record")
        text(take.get("archive_path"), "archive path", 4000)
        if take["kind"] != "image":
            source_range(take.get("source_range"), number(take.get("duration_seconds"), "duration", positive=True))
        review_value(take.get("verdict"), take=True, require_files=False)
    scene_ids = set()
    for scene in data["scenes"]:
        scene_id = identifier(scene.get("scene_id"), "scene_id")
        if scene_id in scene_ids or scene.get("take_id") not in data["takes"]:
            raise ValueError("Scene IDs must be unique and reference registered takes")
        scene_ids.add(scene_id)
        number(scene.get("duration_seconds"), "scene duration", positive=True)
        number(scene.get("planned_start_seconds"), "planned start")
    for change in data["changes"]:
        if not isinstance(change, dict) or set(change.get("reviews", {})) != set(DEPENDENCIES):
            raise ValueError("Each change needs all review dependencies")
        for review in change["reviews"].values():
            review_value(review, require_files=False)


def selection(take, request):
    if take["verdict"]["status"] != "accepted":
        raise ValueError("A take must be accepted with evidence before assigning it")
    archived = safe_path(take["archive_path"])
    if not archived.is_file() or digest(archived) != take["sha256"]:
        raise ValueError("Archived take is missing or changed")
    if take["kind"] == "image":
        if "source_range" in request:
            raise ValueError("Static images have no source time range")
        return {"source_range": None, "duration_seconds": number(request.get("duration_seconds"), "image display duration", positive=True)}
    if "duration_seconds" in request:
        raise ValueError("Audio/video duration comes from its source range, not a requested override")
    selected = source_range(request.get("source_range", take["source_range"]), take["duration_seconds"])
    return {"source_range": selected, "duration_seconds": round(selected["end"] - selected["start"], 9)}


def recompute_plan(data):
    position = 0.0
    for scene in data["scenes"]:
        scene["planned_start_seconds"] = round(position, 9)
        position += scene["duration_seconds"]
    return round(position, 9)


def summary(data):
    unresolved = []
    current_changes = {change["scene_id"]: change for change in data["changes"]}
    for change in current_changes.values():
        for dependency, review in change["reviews"].items():
            current = review.get("checked_timeline_revision") == data["timeline_revision"]
            status = review["status"] if current else "unresolved"
            if status not in ("verified", "not_applicable"):
                unresolved.append({"change_id": change["change_id"], "scene_id": change["scene_id"], "dependency": dependency, "status": status, "reason": review["reason"] if current else "Timeline plan changed since this check; review it again"})
    return {"schema_version": 1, "project_id": data["project_id"], "revision": data["revision"], "timeline_revision": data["timeline_revision"], "takes": len(data["takes"]), "current_changes": {key: value["change_id"] for key, value in current_changes.items()}, "planned_timeline": data["scenes"], "planned_duration_seconds": sum(scene["duration_seconds"] for scene in data["scenes"]), "unresolved_reviews": unresolved, "dependency_review_complete": bool(data["scenes"]) and not unresolved, "vids_timeline_modified_by_helper": False, "scope": "Local plan and recorded review evidence only; no automatic Vids edits or independent proof of a finished film"}


def apply(data, request, manifest_path):
    if not isinstance(request, dict):
        raise ValueError("Request must be a JSON object")
    operation = request.get("op")
    if operation == "init":
        if data is not None:
            raise ValueError("Manifest already exists; init never overwrites it")
        return {"schema_version": 1, "project_id": identifier(request.get("project_id"), "project_id"), "revision": 1, "timeline_revision": 0, "created_at": timestamp(), "updated_at": timestamp(), "takes": {}, "scenes": [], "changes": []}
    if data is None:
        raise ValueError("Initialize the manifest first")
    validate_manifest(data)
    if operation == "status":
        return data
    if operation == "add_take":
        take_id, asset_id = identifier(request.get("take_id"), "take_id"), identifier(request.get("asset_id"), "asset_id")
        if take_id in data["takes"]:
            raise ValueError("Take IDs are immutable; register a new ID for a new source")
        kind = request.get("kind")
        if kind not in ("video", "audio", "image"):
            raise ValueError("kind must be video, audio or image")
        verdict = review_value(request.get("verdict", {"status": "unreviewed", "reason": "Not reviewed yet", "evidence": []}), take=True)
        references = request.get("reference_ids", [])
        if not isinstance(references, list) or len(references) > 64:
            raise ValueError("reference_ids must be a list of up to 64 IDs")
        references = [text(value, "reference ID", 1000) for value in references]
        prompt = request.get("prompt_id")
        if prompt is not None:
            prompt = text(prompt, "prompt ID", 1000)
        metadata = {}
        if kind == "image":
            metadata["reference_version"] = text(request.get("reference_version"), "reference_version", 200)
        elif kind == "audio":
            metadata["speech_text"] = text(request.get("speech_text"), "speech_text", 100000, empty=True)
        else:
            action = request.get("action")
            if not isinstance(action, dict):
                raise ValueError("Video needs action.start and action.end descriptions")
            metadata["action"] = {key: text(action.get(key), f"action.{key}") for key in ("start", "end")}
        original, archived, sha256, created = archive_source(manifest_path, request.get("source"))
        try:
            duration = probe(archived, kind)
            selected = source_range(request.get("source_range", {"start": 0, "end": duration}), duration) if duration is not None else None
            if kind == "image" and "source_range" in request:
                raise ValueError("Static images have no source time range")
            data["takes"][take_id] = {"take_id": take_id, "asset_id": asset_id, "kind": kind, "source_path": str(original), "archive_path": str(archived), "sha256": sha256, "duration_seconds": duration, "duration_method": "ffprobe archived source" if duration is not None else "not_applicable: static image", "source_range": selected, "prompt_id": prompt, "reference_ids": references, "verdict": verdict, "verdict_history": [], "registered_at": timestamp(), **metadata}
        except (ValueError, OSError, subprocess.SubprocessError):
            if created:
                archived.unlink(missing_ok=True)
            raise
    elif operation == "verdict":
        take = data["takes"].get(identifier(request.get("take_id"), "take_id"))
        if take is None:
            raise ValueError("Unknown take ID")
        verdict = review_value(request.get("verdict"), take=True)
        if verdict["status"] != "accepted" and any(scene["take_id"] == take["take_id"] for scene in data["scenes"]):
            raise ValueError("Replace an assigned take before rejecting or unreviewing it")
        take["verdict_history"].append({**take["verdict"], "superseded_at": timestamp()})
        take["verdict"] = verdict
    elif operation in ("assign", "replace"):
        scene_id, take_id = identifier(request.get("scene_id"), "scene_id"), identifier(request.get("take_id"), "take_id")
        take = data["takes"].get(take_id)
        if take is None:
            raise ValueError("Unknown take ID")
        reason = text(request.get("reason"), "assignment/replacement reason")
        selected = {"scene_id": scene_id, "take_id": take_id, **selection(take, request)}
        index = next((i for i, scene in enumerate(data["scenes"]) if scene["scene_id"] == scene_id), None)
        if operation == "assign" and index is not None:
            raise ValueError("Scene already exists; replace it explicitly")
        if operation == "replace" and index is None:
            raise ValueError("Unknown scene ID")
        old = dict(data["scenes"][index]) if index is not None else None
        if old and old["take_id"] == take_id and old["source_range"] == selected["source_range"] and old["duration_seconds"] == selected["duration_seconds"]:
            raise ValueError("Replacement does not change the selected take or range")
        if index is None:
            data["scenes"].append(selected)
        else:
            data["scenes"][index] = selected
        data["timeline_revision"] += 1
        recompute_plan(data)
        change_id = f"change-{len(data['changes']) + 1:06d}"
        previous = next((change for change in reversed(data["changes"]) if change["scene_id"] == scene_id), None)
        reviews = {}
        for name in DEPENDENCIES:
            prior = previous["reviews"][name] if previous else None
            open_issue = prior and prior["status"] in ("unresolved", "failed")
            reviews[name] = {"status": "unresolved", "reason": prior["reason"] if open_issue else "Assignment changed; check actual Vids timing and dependent tracks", "evidence": prior["evidence"] if open_issue else [], "checked_timeline_revision": data["timeline_revision"], "history": [], "carried_from_change": previous["change_id"] if open_issue else None}
        data["changes"].append({"change_id": change_id, "scene_id": scene_id, "kind": operation, "from": old, "to": dict(selected), "duration_delta_seconds": round(selected["duration_seconds"] - (old["duration_seconds"] if old else 0), 9), "reason": reason, "created_at": timestamp(), "timeline_revision": data["timeline_revision"], "reviews": reviews})
    elif operation == "review":
        change_id = identifier(request.get("change_id"), "change_id")
        change = next((item for item in data["changes"] if item["change_id"] == change_id), None)
        dependency = request.get("dependency")
        if change is None or dependency not in DEPENDENCIES:
            raise ValueError("Review needs an existing change_id and named dependency")
        if next(item for item in reversed(data["changes"]) if item["scene_id"] == change["scene_id"]) is not change:
            raise ValueError("This change has been superseded; review the current change for the scene")
        if request.get("timeline_revision") != data["timeline_revision"]:
            raise ValueError("Review is stale; supply the current timeline_revision")
        previous = change["reviews"][dependency]
        value = review_value(request.get("review"))
        history = [*previous.get("history", []), {key: value for key, value in previous.items() if key != "history"}]
        change["reviews"][dependency] = {**value, "checked_timeline_revision": data["timeline_revision"], "checked_at": timestamp(), "history": history}
    else:
        raise ValueError("op must be init, add_take, verdict, assign, replace, review or status")
    data["revision"] += 1
    data["updated_at"] = timestamp()
    validate_manifest(data)
    return data


@contextmanager
def manifest_lock(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = safe_path(path.with_suffix(path.suffix + ".lock"))
    if os.name == "nt":
        import pywintypes, win32api, win32con, win32file, win32security
        token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
        try:
            user = win32security.GetTokenInformation(token, win32security.TokenUser)[0]
        finally:
            token.Close()
        attributes = pywintypes.SECURITY_ATTRIBUTES()
        descriptor = win32security.SECURITY_DESCRIPTOR()
        descriptor.SetSecurityDescriptorOwner(user, False)
        attributes.SECURITY_DESCRIPTOR = descriptor
        handle = win32file.CreateFile(str(lock_path), win32con.GENERIC_READ | win32con.GENERIC_WRITE,
            win32con.FILE_SHARE_READ | win32con.FILE_SHARE_WRITE, attributes,
            win32con.OPEN_ALWAYS, win32file.FILE_FLAG_OPEN_REPARSE_POINT, None)
        try:
            if win32file.GetFileInformationByHandle(handle)[0] & win32con.FILE_ATTRIBUTE_REPARSE_POINT:
                raise ValueError("Manifest lock must not be a reparse point")
            descriptor = win32security.GetSecurityInfo(handle, win32security.SE_FILE_OBJECT, win32security.OWNER_SECURITY_INFORMATION)
            if descriptor.GetSecurityDescriptorOwner() != user:
                raise ValueError("Manifest lock must belong to the current user")
            fd = msvcrt.open_osfhandle(handle.Detach(), os.O_RDWR | os.O_BINARY)
        finally:
            handle.Close()
    else:
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError("Unsafe manifest lock")
        if os.name == "nt":
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
        else:
            if info.st_uid != os.getuid():
                raise ValueError("Unsafe manifest lock")
            fcntl.flock(fd, fcntl.LOCK_EX)
        safe_path(path)
        yield
    finally:
        os.close(fd)


def atomic_write(path, data):
    serialized = json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False).encode() + b"\n"
    if len(serialized) > MAX_JSON_BYTES:
        raise ValueError("Manifest exceeds the 8 MiB limit")
    fd, temporary = tempfile.mkstemp(prefix=".manifest-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(serialized)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def run(manifest_path, request):
    path = safe_path(manifest_path)
    if path.suffix != ".json":
        raise ValueError("Manifest path must end in .json")
    with manifest_lock(path):
        existing = read_json(path) if path.exists() else None
        data = apply(existing, request, path)
        if request.get("op") != "status":
            atomic_write(path, data)
        return summary(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("request", nargs="?", default="-", help="JSON request file; default: stdin")
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(MAX_JSON_BYTES + 1) if args.request == "-" else safe_path(args.request).read_bytes()
        if len(raw) > MAX_JSON_BYTES:
            raise ValueError("Request exceeds the 8 MiB limit")
        result = run(args.manifest, parse_json(raw))
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False, allow_nan=False))
        return 0
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
