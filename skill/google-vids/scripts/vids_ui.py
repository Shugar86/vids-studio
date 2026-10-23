#!/usr/bin/env python3
"""Shared timeline helpers for the installed Codex or Claude vids_call.mjs wrapper:
pick a scene by its thumbnail (the AX "Scene N of M" nodes pointed at the wrong scene), set a scene's
length by replacing a verified clip and delete only a verified scene.

    mkdir -p -m 700 work/private-vids
    python3 vids_ui.py acquire work/private-vids/control.json --session SESSION_UUID \\
      --document DOCUMENT_ID --ticket-file work/private-vids/popup-ticket --label "My video task"
    export VIDS_CONTROL=work/private-vids/control.json
    python3 vids_ui.py scenes
    python3 vids_ui.py replace 4 opening-clip work/clips/opening-v2.mp4
    python3 vids_ui.py delete 3 obsolete-clip
    python3 vids_ui.py add work/clips/s9.mp4          # new last scene with this clip
    python3 vids_ui.py fullframe                      # selected object → 1920×1080 at 0,0 (fullframe 1080 1920 for 9:16)
    python3 vids_ui.py transition 4 Dissolve 0.6      # between scenes 4 and 5; "transition 4 None" removes it
    python3 vids_ui.py playhead0                      # before inserting music from the start
    python3 vids_ui.py release

Use --ticket-file - to read the one-time popup code from stdin. Never pass the code in shell arguments.
The exact session/document must be explicitly assigned to THIS chat; there is no current/free tab.
The sibling .binding.json file is durable recovery authority, written privately before claim.
No secret is printed or placed in child-process arguments. Keep these files private and task-local.
Export uses the installed vids_job_start/status tools, never filename-based download matching.
Python capability files require POSIX ownership/permissions; on Windows use direct MCP tools.
Default screenshots use a fresh private temporary directory and are deleted after decoding.
Every mutation takes a fresh snapshot and a new operation_id. A failed or unknown outcome stops with
exit code 1: observe the document, then vids_reconcile_control by hand — never repeat blindly.
Screenshots may be unavailable when Chrome is hidden or occluded. Check the loaded runtime: screenshot_read_pending preserves attachment and allows fresh AX; input_ack_pending blocks new mutations until settlement and reconciliation. Never foreground Chrome or replay timed-out input.
"""
import argparse
import contextlib
import json
import math
import os
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

from PIL import Image

try:
    import fcntl
except ImportError:
    fcntl = None

CALL = Path(__file__).resolve().with_name("vids_call.mjs")
CTL = {}
PROFILE_ID = {"google-vids": "codex", "vids-director": "claude"}.get(Path(__file__).resolve().parents[1].name)
STRIP_Y = None   # CSS y inside the scene-thumbnail row, refreshed by thumbs()


def use(control_path):
    """Load ONLY this task's own control capability, never the binding/pairing recovery data."""
    global CTL
    _require_private_platform()
    data = _read_private_json(Path(control_path))
    if (data.get("schemaVersion") != 1 or data.get("profileId") != _profile_id()
            or not _uuid(data.get("sessionId")) or not _uuid(data.get("bindingId"))
            or not isinstance(data.get("documentId"), str) or not 1 <= len(data["documentId"]) <= 256
            or not _capability(data.get("controlToken"))):
        stop("control file must explicitly match this profile, document, binding and own session/control capability")
    CTL = {key: data[key] for key in ("sessionId", "controlToken")}
    return CTL


def _profile_id():
    if PROFILE_ID not in ("codex", "claude"):
        stop("run this helper from its installed google-vids or vids-director wrapper; no profile fallback is used")
    return PROFILE_ID


def _require_private_platform():
    if os.name != "posix" or fcntl is None or not hasattr(os, "O_NOFOLLOW"):
        stop("Python control-file acquisition requires POSIX private-file checks; on Windows use the direct MCP binding/control tools instead")


def _uuid(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", value)


def _capability(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{32,128}", value)


def _private_info(info, directory=False):
    return (info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == (0o700 if directory else 0o600)
            and (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1))


def _read_private(path):
    """Read a small owned 0600 regular file without following a symlink."""
    _require_private_platform()
    try:
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "r", encoding="utf-8") as stream:
            if not _private_info(os.fstat(stream.fileno())):
                stop("capability/ticket file must be an owned 0600 regular file, not a link")
            text = stream.read(16385)
            if len(text) > 16384:
                stop("capability/ticket file is unexpectedly large")
            return text
    except (OSError, UnicodeError):
        stop("could not safely read the private capability/ticket file")


def _read_private_json(path):
    try:
        value = json.loads(_read_private(path))
        if isinstance(value, dict):
            return value
    except ValueError:
        pass
    stop("private recovery/control file is malformed; do not discard or replace its authority")


def _write_private(path, value):
    """Atomic durable replacement in an already verified private directory."""
    descriptor, temporary = tempfile.mkstemp(prefix=".vids-private-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextlib.contextmanager
def _acquisition_lock(path):
    _require_private_platform()
    try:
        if not _private_info(path.parent.lstat(), directory=True):
            stop("create the control file's parent as an owned 0700 directory first")
        descriptor = os.open(str(path) + ".lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "r+") as lock:
            if not _private_info(os.fstat(lock.fileno())):
                stop("unsafe acquisition lock file")
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                stop("another acquisition is using this private recovery file; wait for its receipt")
            yield
    except OSError:
        stop("could not safely access the private acquisition directory; nothing was selected automatically")


def acquire(control_path, session, document, ticket_file=None, label="Vids montage"):
    """Explicit first claim; only identical pending CLAIM is recoverable automatically on a later invocation."""
    _require_private_platform()
    _profile_id()
    if not control_path or not _uuid(session) or not isinstance(document, str) or not 1 <= len(document) <= 256:
        stop("acquire requires --session UUID and --document ID for this chat; use MCP binding tools, never legacy/current-tab selection")
    if not isinstance(label, str) or not 1 <= len(label.strip()) <= 120:
        stop("--label must be 1..120 nonblank characters")
    path = Path(control_path).absolute()
    recovery_path = path.with_name(path.name + ".binding.json")
    with _acquisition_lock(path):
        if path.exists() or path.is_symlink():
            stop("control file already exists; use only your own saved lease or recover it with MCP tools, never overwrite it")
        if recovery_path.exists() or recovery_path.is_symlink():
            recovery = _read_private_json(recovery_path)
            if (recovery.get("schemaVersion") != 1 or recovery.get("profileId") != _profile_id()
                    or recovery.get("sessionId") != session or recovery.get("expectedDocumentId") != document
                    or not _uuid(recovery.get("bindingId")) or not _uuid(recovery.get("intentId"))
                    or not _capability(recovery.get("bindingToken"))):
                stop("recovery belongs to a different or invalid assignment; use your own MCP resume_binding with explicit fencing")
            if recovery.get("state") not in ("claim_pending", "claimed"):
                stop("an acquire receipt may be lost; retain recovery and inspect MCP status/binding_status manually; acquisition was not retried")
        else:
            if not ticket_file:
                stop("first claim needs --ticket-file PRIVATE_FILE or --ticket-file - (stdin); no ticket is borrowed")
            ticket = (sys.stdin.read(1025) if ticket_file == "-" else _read_private(Path(ticket_file))).strip()
            if not re.fullmatch(r"[0-9a-fA-F]{64}", ticket):
                stop("popup ticket must be exactly 64 hexadecimal characters")
            recovery = {"schemaVersion": 1, "profileId": _profile_id(), "sessionId": session,
                        "expectedDocumentId": document, "bindingId": str(uuid.uuid4()),
                        "bindingToken": secrets.token_urlsafe(32), "intentId": str(uuid.uuid4()),
                        "ownerLabel": label.strip(), "pairingTicket": ticket, "state": "claim_pending"}
            # Recovery is durable BEFORE crossing the MCP boundary, including an uncertain claim receipt.
            _write_private(recovery_path, recovery)
        binding = {key: recovery[key] for key in ("sessionId", "expectedDocumentId", "bindingId", "bindingToken")}
        if recovery["state"] == "claim_pending":
            if not re.fullmatch(r"[0-9a-fA-F]{64}", recovery.get("pairingTicket", "")):
                stop("pending claim recovery has no valid ticket; preserve it for manual recovery")
            result, _ = call("vids_claim_attachment", {**binding, **{key: recovery[key]
                              for key in ("pairingTicket", "intentId", "ownerLabel")}})
            claimed = result.get("result", result)
            if any(claimed.get(key) != expected for key, expected in
                   (("sessionId", session), ("documentId", document), ("bindingId", recovery["bindingId"]))):
                stop("claim receipt does not identify the exact assignment; no control was acquired")
            recovery["state"] = "claimed"
            recovery.pop("pairingTicket", None)
            _write_private(recovery_path, recovery)
        # acquire_control is NOT idempotent: a lost receipt must not trigger a fresh lease request.
        recovery["state"] = "acquire_pending"
        _write_private(recovery_path, recovery)
        result, _ = call("vids_acquire_control", {**binding, "ownerLabel": recovery["ownerLabel"]})
        lease = result.get("result", result)
        if lease.get("sessionId") != session or not _capability(lease.get("controlToken")):
            stop("control receipt is invalid; retain recovery and inspect MCP status, never retry automatically")
        _write_private(path, {"schemaVersion": 1, "profileId": _profile_id(), "sessionId": session,
                             "documentId": document, "bindingId": recovery["bindingId"],
                             "controlToken": lease["controlToken"], "mode": lease.get("mode")})
        recovery["state"] = "active"
        _write_private(recovery_path, recovery)
    print("own control and durable binding saved privately; use --control or VIDS_CONTROL")


def _objects(text):
    dec, i, out = json.JSONDecoder(), 0, []
    while True:
        j = text.find("{", i)
        if j < 0:
            return out
        try:
            obj, i = dec.raw_decode(text, j)
            out.append(obj)
        except json.JSONDecodeError:
            i = j + 1


def call(tool, params=None, image=None, timeout=150):
    unleased = {"vids_status", "vids_diagnostics", "vids_list_sessions", "vids_claim_attachment",
                "vids_binding_status", "vids_resume_binding", "vids_release_binding", "vids_acquire_control"}
    payload = {**({} if tool in unleased else CTL), **(params or {})}
    cmd = [shutil.which("node") or "node", str(CALL), tool, "-"]
    if image:
        cmd += ["--image", str(image)]
    try:
        process = subprocess.run(cmd, input=json.dumps(payload, ensure_ascii=False),
                                 capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        # Never expose raw subprocess errors/output: they may include private payloads.
        stop(f"{tool} timed out; inspect status/observe and never replay an unknown mutation")
    except OSError:
        stop(f"{tool} could not start; check the local Node/MCP installation")
    objs = _objects(process.stdout)
    errors = [obj for obj in objs if obj.get("error") or obj.get("ok") is False or obj.get("isError") is True]
    if process.returncode or errors or not objs:
        detail = errors[0].get("error", {}) if errors else {}
        code = detail.get("code", "TOOL_ERROR") if isinstance(detail, dict) else "TOOL_ERROR"
        if not isinstance(code, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", code):
            code = "TOOL_ERROR"
        stop(f"{tool} failed ({code}, exit {process.returncode}); inspect status/observe before continuing")
    return objs[0], objs


def stop(msg):
    print(msg, file=sys.stderr)
    sys.exit(1)


def obs(max_nodes=1500):
    r, _ = call("vids_observe", {"maxNodes": max_nodes})
    if "result" not in r:
        stop("observe returned no snapshot result; inspect connection status before continuing")
    return r["result"]


def find(o, role=None, name=None, prefix=None, contains=None):
    for n in o["nodes"]:
        nm = (n.get("name") or "").strip()
        if (role is None or n.get("role") == role) and (name is None or nm == name) and \
           (prefix is None or nm.startswith(prefix)) and (contains is None or contains in nm):
            return n
    return None


def act(tool, o=None, wait=1.2, **p):
    """One mutation on a fresh snapshot; stops on anything but performed."""
    o = o or obs()
    op = str(uuid.uuid4())
    r, _ = call(tool, {"snapshotId": o["snapshotId"], "operation_id": op, **p})
    if not (r.get("result") or {}).get("performed"):
        stop(f"{tool} not confirmed performed (operation_id {op}); inspect before continuing, never replay automatically")
    time.sleep(wait)
    return obs()


def click(o, node, wait=1.2):
    if node is None:
        stop("click target not found in the snapshot")
    return act("vids_click", o, wait=wait, nodeRef=node["ref"])


def click_xy(x, y, wait=1.5):
    return act("vids_click", None, wait=wait, x=x, y=y)


def total(o):
    """['00:12.3' playhead, '00:45.4' total] from the timeline readout."""
    return [n["name"] for n in o["nodes"] if n.get("role") == "StaticText" and (n.get("name") or "")[:3] in ("00:", "01:", "02:")]


def scenes(o):
    return [n for n in o["nodes"] if n.get("role") == "button" and (n.get("name") or "").startswith("Scene ") and " of " in n["name"]]


def media(o):
    """Layer names of the selected scene, top to bottom (the video is a *.mp4, images *.png)."""
    return [n["name"] for n in o["nodes"] if n.get("role") == "StaticText" and
            ((n.get("name") or "").endswith((".mp4", ".png")) or (n.get("name") or "").startswith("Caption for"))]


def shot(path=None):
    """Screenshot → (fresh image, reported image px per CSS px); never reuse an old file."""
    # Default captures are private and unique per invocation, including between
    # parallel chats/processes. Only an explicitly requested path is retained.
    path = Path(path).absolute() if path is not None else None
    if path is not None:
        _require_private_platform()
        try:
            if not _private_info(path.parent.lstat(), directory=True):
                stop("screenshot destination must be inside an existing owned 0700 task directory")
            if path.is_symlink():
                stop("screenshot destination must not be a symlink")
        except OSError:
            stop("could not verify the private screenshot destination")
    with tempfile.TemporaryDirectory(prefix=".vids-shot-", dir=path.parent if path else None) as directory:
        capture = Path(directory) / "capture.png"
        r, _ = call("vids_screenshot", {}, image=capture)
        metadata = r.get("image")
        if (r.get("error") or not r.get("snapshotId") or r.get("coordinateSpace") != "css-viewport"
                or not isinstance(metadata, dict)):
            stop("screenshot has no valid fresh receipt; use status/observe before continuing")
        scale_x, scale_y = metadata.get("scaleX"), metadata.get("scaleY")
        if not all(type(value) in (int, float) and math.isfinite(value) and value > 0
                   for value in (scale_x, scale_y)):
            stop("screenshot has no valid CSS scale; cannot infer coordinates from an old viewport")
        if not math.isclose(scale_x, scale_y, rel_tol=0.001):
            stop("screenshot has unequal X/Y scales; thumbnail helpers require uniform scaling")
        try:
            with Image.open(capture) as source:
                im = source.convert("RGB")
        except (OSError, ValueError):
            stop("screenshot did not produce a valid new image; previous image was not used")
        if im.size != (metadata.get("width"), metadata.get("height")):
            stop("screenshot dimensions do not match its receipt; previous image was not used")
        if path is not None:
            os.chmod(capture, 0o600)
            os.replace(capture, path)
        return im, float(scale_x)


def runs(idx):
    out = []
    for i in idx:
        if out and i == out[-1][1] + 1:
            out[-1][1] = i
        else:
            out.append([i, i])
    return [tuple(r) for r in out]


def thumb_runs(im, k, n, y_from=560, y_to=800, x_to=1250):
    """First CSS row in [y_from, y_to) crossing exactly n thumbnails: (y, [(x0, x1), ...]) in CSS px."""
    px = im.load()
    for yc in range(y_from, y_to, 2):
        y = int(yc * k)
        if y >= im.size[1]:
            break
        bg = px[int(30 * k), y]
        xs = [x for x in range(0, min(im.size[0], int(x_to * k)))
              if sum(abs(a - b) for a, b in zip(px[x, y], bg)) > 40]
        rs = [(s / k, e / k) for s, e in runs(xs) if (e - s) / k > 20]
        if len(rs) == n:
            return yc, rs
    return None, []


def thumbs(n=None):
    """Thumbnail x-ranges of all scenes at Fit zoom; refreshes STRIP_Y (the panel height follows the layer count)."""
    global STRIP_Y
    n = n or len(scenes(obs()))
    im, k = shot()
    y, rs = thumb_runs(im, k, n)
    if not rs:  # with the side sheet closed the strip runs past x 1250 CSS px
        y, rs = thumb_runs(im, k, n, x_to=im.size[0] / k)
    if not rs:
        stop(f"scene strip with {n} thumbnails not found; set the timeline zoom to Fit")
    STRIP_Y = y + 20
    return rs


def select_thumb(k):
    """Click the k-th thumbnail (1-based) found on a fresh screenshot; returns (snapshot, (x0, x1))."""
    x0, x1 = thumbs()[k - 1]
    o = click_xy(x0 + 0.4 * (x1 - x0), STRIP_Y)   # left of centre: the floating "+" covers the last thumbnail's right side
    return o, (x0, x1)


def select_scene(k, expect):
    """Click the k-th thumbnail (1-based) and verify the selected scene's video name starts with `expect`."""
    o, (x0, x1) = select_thumb(k)
    if not any(m.startswith(expect) for m in media(o)):
        stop(f"scene {k} shows {media(o)}, expected {expect}*")
    return o, (x0, x1)


def layer_rows(x1):
    """CSS y-centres of the selected scene's layer bars (red captions, yellow media) under its thumbnail."""
    im, k = shot()
    px = im.load()
    y0 = STRIP_Y + 50
    rows = []
    for yc in range(int(y0 * k), min(im.size[1], int((y0 + 260) * k))):
        cols = range(int((x1 - 34) * k), int((x1 - 4) * k))
        hits = sum(1 for x in cols if px[x, yc][0] > 200 and px[x, yc][2] < 160)
        if hits > 0.3 * len(cols):
            rows.append(yc)
    return [((s + e) / 2) / k for s, e in runs(rows) if e - s > 10 * k]


def set_zoom(label):
    o = obs()
    if (find(o, "textbox", name="Set timeline zoom") or {}).get("value") == label:
        return o
    for _ in range(3):
        o = click(o, find(o, "textbox", name="Set timeline zoom"))
        opt = [n for n in o["nodes"] if n.get("role") == "option" and n.get("name") == label]
        if opt:
            return click(o, opt[-1], wait=1.5)
    stop("timeline zoom options did not open")


def replace_video(k, expect, mp4):
    """Replace the video of scene k. The scene then lasts max(clip, longest other layer) — frame-exact."""
    set_zoom("Fit")
    o, (x0, x1) = select_scene(k, expect)
    names = media(o)
    i = next(j for j, n in enumerate(names) if n.startswith(expect) and n.endswith(".mp4"))
    thumbs()
    rows = layer_rows(x1)
    if len(rows) < len(names):          # many layers: the video row is at the bottom of a scrolled list
        act("vids_scroll", None, x=x1 - 20, y=rows[len(rows) // 2], deltaX=0, deltaY=400)
        rows = layer_rows(x1)
        y = rows[-1]
    elif len(rows) == len(names):
        y = rows[i]
    else:
        stop(f"layer bars {[round(r) for r in rows]} do not match layers {names}")
    o = click_xy(x1 - 12, y)
    rv = find(o, "button", name="Replace video")
    if not rv:
        stop("Replace video not offered: the clicked bar is not the video")
    o = click(o, rv)
    up = find(o, "menuitem", prefix="Upload")
    r, _ = call("vids_upload_via_picker", {"snapshotId": o["snapshotId"], "operation_id": str(uuid.uuid4()),
                                           "nodeRef": up["ref"], "files": [str(Path(mp4).resolve())]})
    if not (r.get("result") or {}).get("performed"):
        stop("upload was not confirmed performed; inspect before continuing, never replay automatically")
    name = Path(mp4).name
    for _ in range(20):
        time.sleep(2)
        o = obs()
        if find(o, "StaticText", name=name):
            print(f"scene {k}: {media(o)} total {total(o)}")
            return o
    stop(f"{name} did not appear in scene {k}")


def delete_scene(k, expect):
    """Delete scene k after verifying its video name; checks that exactly one scene disappeared."""
    set_zoom("Fit")
    o, _ = select_scene(k, expect)
    before = len(scenes(o))
    o = click(o, find(o, "menuitem", name="Scene"), wait=1.5)
    o = obs()
    items = [n for n in o["nodes"] if n.get("role") == "menuitem" and (n.get("name") or "").startswith("Delete scene")
             and not (n.get("name") or "").startswith("Delete scenes")]
    if len(items) != 1:
        stop("Scene menu has no single 'Delete scene' item")
    o = click(o, items[0], wait=1.5)
    if len(scenes(o)) != before - 1:
        stop(f"scene count {before} -> {len(scenes(o))}; check with Undo")
    print(f"deleted scene {k} ({expect}*): {before} -> {len(scenes(o))}, total {total(o)}")
    return o


def _duration(text):
    """'78 milliseconds' / '1 minute 2 seconds' → seconds, None when no unit is found."""
    units = {"millisecond": 0.001, "second": 1, "minute": 60, "hour": 3600}
    parts = re.findall(r"(\d+(?:\.\d+)?) (millisecond|second|minute|hour)s?\b", text)
    return sum(float(v) * units[u] for v, u in parts) if parts else None


def playhead_seconds(o):
    """Playhead position from the AX 'Playhead at … out of …' node, or None."""
    n = find(o, "time", prefix="Playhead at ")
    if not n or " out of " not in n["name"]:
        return None
    return _duration(n["name"][len("Playhead at "):n["name"].index(" out of ")])


def playhead_zero(tolerance=0.2):
    """Put the playhead at the very start. Selecting scene 1 left it at 2–3 s, so music inserted 'at the
    start' began late; a click in the strip just left of the first thumbnail moved it to ~0."""
    set_zoom("Fit")
    x0, _ = thumbs()[0]
    o = click_xy(max(4, x0 - 20), STRIP_Y)
    t = playhead_seconds(o)
    if t is None or t > tolerance:
        stop(f"playhead is at {t} s, not at the start; check the timeline zoom and layout")
    return o


def add_scene(clip):
    """Append a scene and upload `clip` into it; like Replace video, the clip sets the scene length.
    Positions come from thumbnails, not from the AX "Scene N of M" buttons (they can point at a neighbour).
    Before uploading, the previous last scene must still be second-to-last and the new last scene empty;
    otherwise the append is not established and nothing is uploaded."""
    set_zoom("Fit")
    n = len(scenes(obs()))
    o, _ = select_thumb(n)
    last = media(o)
    if not last:
        stop("the last scene is already empty: a new empty scene could not be told apart from it")
    o = click(o, find(o, "button", name="New scene (Ctrl+M)"))
    if len(scenes(o)) != n + 1:
        stop(f"scene count {n} -> {len(scenes(o))}; check with Undo")
    o, _ = select_thumb(n)
    if media(o) != last:
        stop(f"scene {n} now shows {media(o)} instead of {last}: the new scene is not at the end; check with Undo")
    o, _ = select_thumb(n + 1)
    if media(o) or not find(o, "StaticText", name="This scene has no objects."):
        stop(f"the last scene shows {media(o)}, not the new empty scene; check with Undo")
    o = click(o, find(o, "menuitem", name="Insert"))
    up = find(o, "menuitem", prefix="Upload")
    if not up:
        stop("Insert menu has no Upload item")
    r, _ = call("vids_upload_via_picker", {"snapshotId": o["snapshotId"], "operation_id": str(uuid.uuid4()),
                                           "nodeRef": up["ref"], "files": [str(Path(clip).resolve())]})
    if not (r.get("result") or {}).get("performed"):
        stop("upload was not confirmed performed; inspect before continuing, never replay automatically")
    name = Path(clip).name
    for _ in range(20):
        time.sleep(2)
        o = obs()
        if find(o, "StaticText", name=name):
            print(f"scene {n + 1} of {len(scenes(o))}: {name}, total {total(o)}")
            return o
    stop(f"{name} did not appear in the new scene")


def full_frame(width=1920, height=1080):
    """Selected image/video to the full frame via Format → Format options: Width (aspect locked), X 0, Y 0.
    Inserted PNGs and AI clips arrived inset (about 1808×1017 at X=Y=32 for 16:9). The object must already
    have the frame's proportions: the result is checked against width×height at 0,0, and a mismatch stops
    without retrying (the input was delivered; inspect the object first)."""
    def values(o):
        return {k: (find(o, "spinbutton", name=k) or {}).get("value") for k in ("Width", "Height", "X", "Y")}
    o = obs()
    if values(o)["Width"] is None:
        o = click(o, find(o, "menuitem", name="Format"))
        o = click(o, find(o, "menuitem", prefix="Format options"))
        for section in ("Size & rotation", "Position"):
            b = find(o, "button", name=section)
            if b and (b.get("states") or {}).get("expanded") is False:
                o = click(o, b)
                if ((find(o, "button", name=section) or {}).get("states") or {}).get("expanded") is False:
                    o = act("vids_press_key", o, key="Enter")
    if values(o)["Width"] is None:
        stop("Format options show no Width field: select the image or video first")
    for field, value, key in (("Width", width, "Enter"), ("X", 0, "Tab"), ("Y", 0, "Tab")):
        current = values(o)[field]
        if current is not None and abs(float(current) - value) <= 1:
            continue
        o = click(o, find(o, "spinbutton", name=field))
        o = act("vids_type_text", o, nodeRef=find(o, "spinbutton", name=field)["ref"], text=str(value), replace=True)
        o = act("vids_press_key", o, key=key)
    got = values(o)
    want = {"Width": width, "Height": height, "X": 0, "Y": 0}
    if any(got[k] is None or abs(float(got[k]) - v) > 1 for k, v in want.items()):
        stop(f"geometry reads {got}, expected {want}; not retried — check the object's proportions and selection")
    print(f"geometry {got}")
    return o


def transition(k, kind, seconds=None):
    """Set the transition between scenes k and k+1 (Dissolve, Fade, Push, Slide, Scale, Spin, Flicker) or
    remove it with None. Checks the boundary's new name and the selected radio, plus the duration when one
    is given. A transition overlaps both scenes and shortens the total; re-check the cuts in the export."""
    def boundary(o):
        return next((n for n in o["nodes"] if n.get("role") == "button" and
                     (n.get("name") or "").endswith(f"between scene {k} and {k + 1}")), None)
    o = obs()
    if not boundary(o):
        stop(f"no transition button between scenes {k} and {k + 1}")
    o = click(o, boundary(o))
    o = click(o, find(o, "radio", name=kind))
    if kind != "None" and seconds is not None:
        field = find(o, "spinbutton", prefix="Transition duration")
        if not field:
            stop(f"{kind} offers no duration field")
        o = click(o, field)
        o = act("vids_type_text", o, nodeRef=find(o, "spinbutton", prefix="Transition duration")["ref"],
                text=str(seconds), replace=True)
        o = act("vids_press_key", o, key="Enter")
    label = (boundary(o) or {}).get("name") or ""
    expected = "Add transition" if kind == "None" else kind
    if not label.startswith(expected + " between"):
        stop(f"boundary reads '{label}', expected '{expected} between scene {k} and {k + 1}'")
    radio = ((find(o, "radio", name=kind) or {}).get("states") or {}).get("checked")
    if radio not in (None, "true", True):
        stop(f"the {kind} option is not selected (checked={radio})")
    if kind != "None" and seconds is not None:
        value = (find(o, "spinbutton", prefix="Transition duration") or {}).get("value")
        if value is None or not math.isclose(float(value), float(seconds), abs_tol=0.01):
            stop(f"transition duration reads {value}, expected {seconds}")
    print(f"{label}" + (f", {seconds} s" if seconds is not None and kind != "None" else "") + f", total {total(o)}")
    return o


def export_mp4(out, title, timeout=900):
    """Retained only to reject old scripts before any browser input or download lookup."""
    stop("filename-based export is disabled: use vids_job_start/status with this task's exact document/session and automatic-download evidence")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["acquire", "release", "scenes", "replace", "delete", "add", "fullframe", "transition", "playhead0", "export"])
    ap.add_argument("args", nargs="*")
    ap.add_argument("--control", default=os.environ.get("VIDS_CONTROL"), help="private control file (default $VIDS_CONTROL)")
    ap.add_argument("--label", default="Vids montage")
    ap.add_argument("--session", help="exact UUID of the attachment explicitly assigned to this chat")
    ap.add_argument("--document", help="exact authorized Google Vids document ID")
    ap.add_argument("--ticket-file", help="owned 0600 file containing the popup code, or - for stdin")
    ap.add_argument("--title", help="legacy argument; filename-based export is disabled")
    a = ap.parse_args()
    if a.command == "acquire":
        acquire(a.args[0] if a.args else a.control, a.session, a.document, a.ticket_file, a.label)
        return
    if a.command == "export":
        export_mp4(a.args[0] if a.args else None, a.title)
    if not a.control:
        stop("pass --control or set VIDS_CONTROL")
    use(a.control)
    if a.command == "release":
        print(call("vids_release_control")[0])
    elif a.command == "scenes":
        o = obs()
        print(f"{len(scenes(o))} scenes, readout {total(o)}, selected scene layers {media(o)}")
    elif a.command == "replace":
        replace_video(int(a.args[0]), a.args[1], a.args[2])
    elif a.command == "delete":
        delete_scene(int(a.args[0]), a.args[1])
    elif a.command == "add":
        add_scene(a.args[0])
    elif a.command == "fullframe":
        full_frame(*(int(v) for v in a.args[:2])) if a.args else full_frame()
    elif a.command == "transition":
        transition(int(a.args[0]), a.args[1], float(a.args[2]) if len(a.args) > 2 else None)
    elif a.command == "playhead0":
        playhead_zero()


if __name__ == "__main__":
    main()
