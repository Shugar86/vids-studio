#!/usr/bin/env python3
"""Offline cut candidates and caption-band review sheets for a local video export.

These pixel heuristics identify moments to inspect; they do not prove a scene
boundary, caption correctness, speech quality or delivery readiness. Frame
numbers are exact decode indices, while times assume constant frame rate.

    python3 cut_check.py exports/v5.mp4 --out qa/v5-cuts --plan 86,258,299
    python3 cut_check.py exports/v4.mp4 --out qa/v4-onsets --around 2.37,8.6

--plan takes cut frames (or seconds with --seconds); --span sets the frames shown around each cut. --around writes onsets.png: the caption band
frame by frame (±12 frames) around the given seconds, to inspect a candidate
caption onset and choose a cut in context. Writes report.json, cuts.png and onsets.png into a new
--out directory. Requires existing ffmpeg/ffprobe and Pillow. The source file is
not modified and no dependency is installed. All decoder work shares the same
cross-profile local media budget as export verification. Limits: 18,000 frames,
600 seconds, 64 MiB of analysis pixels, 48 candidate review points and 128 MiB
per decoded sheet set.
"""
import argparse
import importlib.util
import json
import math
import operator
import statistics
import subprocess
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    Image = ImageDraw = None

if "vids_media_guard" not in sys.modules:
    _spec = importlib.util.spec_from_file_location("vids_media_guard", Path(__file__).with_name("media_guard.py"))
    _guard = importlib.util.module_from_spec(_spec)
    sys.modules[_spec.name] = _guard
    _spec.loader.exec_module(_guard)
from vids_media_guard import media_budget, media_tool, MediaBudgetError

SMALL_W = 54           # analysis width; height keeps the aspect
STRIP_W = 360          # width of one caption-band tile in the sheets
CUT_SPAN = 3           # default frames shown on each side of a cut (--span)
ONSET_SPAN = 12        # frames shown on each side of an --around time
MATCH = 6              # a planned cut matches a detected one within this many frames
MAX_FRAMES = 18000
MAX_POINTS = 48
MAX_GRAY_BYTES = 64 * 1024 * 1024
MAX_SHEET_BYTES = 128 * 1024 * 1024


def probe(video, guard):
    out = guard.run([media_tool("ffprobe"), "-v", "error", "-protocol_whitelist", "file,pipe",
                     "-select_streams", "v:0", "-show_entries",
                     "stream=width,height,r_frame_rate,avg_frame_rate:format=duration", "-of", "json", str(video)],
                    capture_output=True, text=True, check=True, timeout=30).stdout
    data = json.loads(out)
    s = data["streams"][0]
    num, den = (int(x) for x in s["r_frame_rate"].split("/"))
    avg_num, avg_den = (int(x) for x in s["avg_frame_rate"].split("/"))
    fps, avg = num / den, avg_num / avg_den
    duration = float(data["format"]["duration"])
    if not 0 < fps <= 120 or not math.isfinite(duration) or not 0 < duration <= 600:
        raise ValueError("Expected a video up to 600 seconds and 120 fps")
    if not math.isclose(fps, avg, rel_tol=.001):
        raise ValueError("Variable/uncertain frame rate: normalize a copy before frame-to-time cut review")
    if not 2 <= s["width"] <= 8192 or not 2 <= s["height"] <= 8192 or not .25 <= s["width"] / s["height"] <= 4:
        raise ValueError("Expected dimensions 2..8192 and aspect ratio between 1:4 and 4:1")
    return s["width"], s["height"], fps


def decode_gray(video, w, h, guard):
    """Frames as bytes of w×h gray pixels."""
    maximum = min(MAX_FRAMES, MAX_GRAY_BYTES // (w * h))
    raw = guard.run([media_tool("ffmpeg"), "-nostdin", "-v", "error", "-threads", "2", "-filter_threads", "2",
                     "-protocol_whitelist", "file,pipe", "-i", str(video), "-map", "0:v:0", "-an",
                     "-vf", f"scale={w}:{h},format=gray", "-frames:v", str(maximum + 1),
                     "-vsync", "0", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                    capture_output=True, check=True).stdout
    n = w * h
    if not raw or len(raw) % n or len(raw) // n > maximum:
        raise ValueError("Incomplete video, more than 18,000 frames or 64 MiB of analysis pixels; inspect a shorter copy")
    return [raw[i:i + n] for i in range(0, len(raw) - n + 1, n)]


def runs(idx):
    out = []
    for i in idx:
        if out and i == out[-1][1] + 1:
            out[-1][1] = i
        else:
            out.append([i, i])
    return [tuple(r) for r in out]


WHITE = bytes(1 if v > 235 else 0 for v in range(256))
BLACK = bytes(1 if v < 12 else 0 for v in range(256))


def detect(gray, w, band):
    """Cut frames (first frame of the new shot) and short white/black runs."""
    # captions change on their own: keep the caption band out of the difference
    keep = [f[:band[0] * w] + f[band[1] * w:] for f in gray]
    if not keep or not keep[0]:
        raise ValueError("No decoded pixels remain outside the caption band")
    n = len(keep[0])
    d = [sum(map(abs, map(operator.sub, a, b))) / n for a, b in zip(keep, keep[1:])]
    thr = max(6 * statistics.median(d), 4.0) if d else 4.0
    cuts = [{"frame": i + 1, "diff": round(d[i], 1)} for i in range(len(d))
            if d[i] > thr and d[i] == max(d[max(0, i - 3):i + 4])]
    white = [sum(f.translate(WHITE)) / len(f) > 0.5 for f in gray]
    black = [sum(f.translate(BLACK)) / len(f) > 0.97 for f in gray]
    flashes = []
    for kind, mask in (("white", white), ("black", black)):
        for s, e in runs([i for i, m in enumerate(mask) if m]):
            if e - s + 1 <= 6:                # a long black/white stretch is a shot, not a flash
                flashes.append({"kind": kind, "from": int(s), "to": int(e)})
    # A partly white frame can still contain foreground image layers.
    mean = [sum(f) / len(f) for f in gray]
    covered = {i for fl in flashes for i in range(fl["from"], fl["to"] + 1)}
    for length in (1, 2, 3):
        for i in range(1, len(mean) - length):
            inner = sum(mean[i:i + length]) / length
            lo, hi = sorted((inner - mean[i - 1], inner - mean[i + length]))
            kind = "bright" if lo > 40 else "dark" if hi < -40 else None
            if kind and not covered & set(range(i, i + length)):
                flashes.append({"kind": kind, "from": i, "to": i + length - 1})
                covered |= set(range(i, i + length))
    return cuts, sorted(flashes, key=lambda f: f["from"]), thr


def compare(plan, cuts):
    found = [c["frame"] for c in cuts]
    rows, used = [], set()
    for p in plan:
        near = min((f for f in found if f not in used), key=lambda f: abs(f - p), default=None)
        if near is not None and abs(near - p) <= MATCH:
            rows.append({"plan": p, "actual": near, "delta": near - p}); used.add(near)
        else:
            rows.append({"plan": p, "actual": None, "delta": None})
    extra = [f for f in found if f not in used]
    return rows, extra


def band_frames(video, frames, w, h, band_px, guard):
    """Caption-band crops of the given frame numbers, scaled to STRIP_W."""
    frames = sorted(set(f for f in frames if f >= 0))
    if not frames:
        return {}
    y0, y1 = band_px
    sh = max(2, round((y1 - y0) * STRIP_W / w / 2) * 2)
    if len(frames) * sh * STRIP_W * 3 > MAX_SHEET_BYTES:
        raise ValueError("Caption crops exceed 128 MiB; reduce --span or the number of points")
    sel = "+".join(f"eq(n\\,{f})" for f in frames)
    vf = f"select='{sel}',crop={w}:{y1 - y0}:0:{y0},scale={STRIP_W}:{sh}"
    raw = guard.run([media_tool("ffmpeg"), "-nostdin", "-v", "error", "-threads", "2", "-filter_threads", "2",
                          "-protocol_whitelist", "file,pipe", "-i", str(video), "-map", "0:v:0", "-an", "-vf", vf, "-vsync", "0",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    n = sh * STRIP_W * 3
    if len(raw) != len(frames) * n:
        raise ValueError("Caption decode did not return exactly the requested frame set")
    tiles = [raw[i:i + n] for i in range(0, len(raw) - n + 1, n)]
    return {f: Image.frombytes("RGB", (STRIP_W, sh), t) for f, t in zip(frames, tiles)}


def sheet(rows, tiles, path, title):
    """rows: list of (label, [frame, ...]); one line of labelled tiles per row."""
    if not rows or not tiles:
        return None
    th = next(iter(tiles.values())).height
    cols = max(len(fr) for _, fr in rows)
    if cols * STRIP_W * (len(rows) * (th + 14) + 16) * 3 > MAX_SHEET_BYTES:
        raise ValueError("Review sheet exceeds 128 MiB; reduce --span or review points")
    img = Image.new("RGB", (cols * STRIP_W, len(rows) * (th + 14) + 16), (24, 24, 24))
    dr = ImageDraw.Draw(img)
    dr.text((4, 2), title, fill=(255, 220, 0))
    for r, (label, frames) in enumerate(rows):
        y = 16 + r * (th + 14)
        dr.text((4, y), label, fill=(200, 200, 200))
        for c, f in enumerate(frames):
            if f in tiles:
                img.paste(tiles[f], (c * STRIP_W, y + 12))
                dr.text((c * STRIP_W + 3, y + 14), f"f{f}", fill=(255, 255, 0))
    img.save(path)
    return str(path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video", type=Path)
    ap.add_argument("--out", type=Path, required=True, help="new output directory")
    ap.add_argument("--plan", default="", help="planned cut points, comma separated")
    ap.add_argument("--seconds", action="store_true", help="--plan is in seconds, not frames")
    ap.add_argument("--around", default="", help="seconds to show frame by frame for word onsets")
    ap.add_argument("--span", type=int, default=CUT_SPAN,
                    help="frames on each side of a cut (1..12)")
    ap.add_argument("--band", default="0.76:0.115",
                    help="caption band as top:height fractions of frame height; adjust for this video's layout")
    a = ap.parse_args()
    if Image is None:
        raise ValueError("Pillow is required for sheets; configure it separately in the Python environment")
    a.video = a.video.expanduser().resolve(strict=True)
    if not a.video.is_file():
        raise ValueError("Input must be an existing local regular video file")
    top, height = (float(x) for x in a.band.split(":"))
    if not all(math.isfinite(x) for x in (top, height)) or not 0 <= top < 1 or not 0 < height < 1 or top + height > 1:
        raise ValueError("--band requires finite top:height fractions within the frame")
    if not 1 <= a.span <= 12:
        raise ValueError("--span must be between 1 and 12")
    plan = [float(x) for x in a.plan.split(",") if x.strip()]
    times = [float(x) for x in a.around.split(",") if x.strip()]
    if len(plan) + len(times) > MAX_POINTS or any(not math.isfinite(x) or x < 0 for x in plan + times):
        raise ValueError("Use up to 48 finite, nonnegative review points")
    if plan != sorted(set(plan)) or (not a.seconds and any(not p.is_integer() for p in plan)):
        raise ValueError("Planned cuts must be unique, increasing frame indices (or use --seconds)")
    if a.out.exists() and any(a.out.iterdir()):
        sys.exit(f"{a.out} is not empty; choose a fresh --out")
    a.out.mkdir(parents=True, exist_ok=True)

    with media_budget("cut-check") as guard:
        return inspect(a, top, height, plan, times, guard)


def inspect(a, top, height, plan, times, guard):
    w, h, fps = probe(a.video, guard)
    band_px = (int(top * h), min(h, int((top + height) * h)))
    if band_px[1] <= band_px[0]:
        raise ValueError("Caption band is smaller than one pixel")
    sh = max(2, round(SMALL_W * h / w / 2) * 2)
    gray = decode_gray(a.video, SMALL_W, sh, guard)
    small_band = (int(top * sh), int((top + height) * sh) + 1)
    cuts, flashes, thr = detect(gray, SMALL_W, small_band)
    for c in cuts:
        c["time"] = round(c["frame"] / fps, 3)

    plan = [round(p * fps) for p in plan] if a.seconds else [int(p) for p in plan]
    if any(p >= len(gray) for p in plan) or any(t * fps >= len(gray) for t in times):
        raise ValueError("A requested point lies beyond the decoded video")
    rows, extra = compare(plan, cuts) if plan else ([], [])

    points = [r["actual"] if r["actual"] is not None else r["plan"] for r in rows] or [c["frame"] for c in cuts]
    around = [round(t * fps) for t in times]
    if len(points) + len(around) > MAX_POINTS:
        raise ValueError("More than 48 candidate cuts; specify a shorter --plan or inspect a shorter copy")
    want = [f for p in points for f in range(p - a.span, p + a.span + 1)]
    want += [f for p in around for f in range(p - ONSET_SPAN, p + ONSET_SPAN + 1)]
    tiles = band_frames(a.video, [f for f in want if f < len(gray)], w, h, band_px, guard)
    cut_rows = [(f"cut {p} ({p / fps:.3f} s)", list(range(p - a.span, p + a.span + 1))) for p in points]
    cuts_png = sheet(cut_rows, tiles, a.out / "cuts.png",
                     "caption band at each cut: the first line of the new scene must not repeat the last word")
    onset_rows = []
    for p in around:
        fr = list(range(p - ONSET_SPAN, p + ONSET_SPAN + 1))
        onset_rows += [(f"around {p / fps:.3f} s", fr[i:i + 9]) for i in range(0, len(fr), 9)]
    onsets_png = sheet(onset_rows, tiles, a.out / "onsets.png",
                       "frame by frame: cut on the first frame where the new word is highlighted")

    report = {"video": str(a.video), "fps": fps, "frames": len(gray), "size": [w, h], "threshold": round(thr, 2),
              "assessment": "Heuristic candidates for human review, not a quality or caption correctness verdict.",
              "timeBasis": "Decoded frame index divided by nominal frame rate; CFR assumed, matching rate metadata is not proof of uniform timestamps.",
              "cuts": cuts, "flashes": flashes, "plan": rows, "unplanned_changes": extra,
              "sheets": [p for p in (cuts_png, onsets_png) if p]}
    (a.out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"{len(gray)} frames @ {fps:g} fps; cuts: {[c['frame'] for c in cuts]}")
    off = [r for r in rows if r["delta"] != 0]
    for r in off:
        print(f"plan {r['plan']}: " + (f"actual {r['actual']} ({r['delta']:+d})" if r["actual"] is not None else "not found"))
    if rows and not off:
        print("all planned cuts on their frames")
    if extra and rows:
        print(f"changes outside the plan (layer animation or stray cut): {extra}")
    for fl in flashes:
        print(f"{fl['kind']} candidate frames {fl['from']}–{fl['to']}: inspect in context")
    print("sheets:", ", ".join(report["sheets"]) or "none")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, IndexError, ZeroDivisionError, MediaBudgetError, subprocess.SubprocessError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
