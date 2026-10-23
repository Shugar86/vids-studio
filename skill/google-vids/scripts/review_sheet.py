#!/usr/bin/env python3
"""Make offline video contact sheets with verified source-frame timestamps.

Requires existing ffmpeg/ffprobe and a local TrueType/OpenType font. Samples the
whole video at 2 fps, enlarges the first 3 seconds, and samples supplied cuts at
10 fps within +/-0.5 seconds. Does not edit the input or assess motion/audio.
"""
import argparse
import bisect
from fractions import Fraction
import hashlib
import html
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap

MAX_DURATION = 300
MAX_SOURCE_FRAMES = 36001
MAX_SELECTED_FRAMES = 1000
MAX_PAGES = 80
MAX_CUTS = 20
THREADS = 2


def run(command, *, cwd=None, timeout=180):
    result = subprocess.run(command, cwd=cwd, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise ValueError(f"{Path(command[0]).name} failed: {result.stderr[-4000:].strip()}")
    return result


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def no_symlinks(path):
    absolute = Path(path.expanduser().absolute())
    for component in (absolute, *absolute.parents):
        if component.is_symlink():
            raise ValueError(f"Symlink paths are not accepted: {component}")
    return absolute


def parse_cuts(value):
    if not value:
        return []
    if isinstance(value, list):
        value = ",".join(value)
    try:
        result = sorted(set(float(part) for part in value.split(",")))
    except ValueError as error:
        raise ValueError("--cuts must contain seconds separated by commas or spaces") from error
    if len(result) > MAX_CUTS or any(not math.isfinite(v) or v < 0 for v in result):
        raise ValueError(f"Supply at most {MAX_CUTS} finite, nonnegative cut times")
    return result


def parse_safe_area(value, label):
    if (value is None) != (label is None):
        raise ValueError("--safe-area and --safe-area-label must be supplied together")
    if value is None:
        return None
    try:
        insets = [float(part) for part in value.split(",")]
    except ValueError as error:
        raise ValueError("--safe-area requires left,top,right,bottom fractional insets") from error
    if (len(insets) != 4 or any(not math.isfinite(v) or v < 0 or v >= 1 for v in insets)
            or insets[0] + insets[2] >= 1 or insets[1] + insets[3] >= 1):
        raise ValueError("Safe-area insets must leave a positive rectangle inside the image")
    if not label.strip() or len(label) > 100 or any(ord(c) < 32 for c in label):
        raise ValueError("Safe-area label must be 1–100 visible characters on one line")
    return insets


def font_path(explicit):
    if explicit:
        candidate = no_symlinks(explicit)
        if not candidate.is_file():
            raise ValueError(f"Font does not exist: {candidate}")
        return candidate
    if shutil.which("fc-match"):
        result = run(["fc-match", "-f", "%{file}", "sans"], timeout=10).stdout
        if result and Path(result).is_file():
            return Path(result)
    for candidate in ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                      "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
                      "/System/Library/Fonts/Supplemental/Arial.ttf"):
        if Path(candidate).is_file():
            return Path(candidate)
    raise ValueError("No local font found; pass --font PATH (no fonts are downloaded)")


def targets(start, end, step):
    return [round(start + n * step, 9) for n in range(math.floor((end - start) / step + 1e-8) + 1)]


def select_frames(timestamps, requested):
    """First decoded source frame at/after each requested time; no invented frames."""
    result = []
    for target in requested:
        index = bisect.bisect_left(timestamps, target - 1e-8)
        if index < len(timestamps) and (not result or index != result[-1]):
            result.append(index)
    return result


def timestamp(seconds):
    milliseconds = round(seconds * 1000)
    minutes, rest = divmod(milliseconds, 60000)
    whole, millis = divmod(rest, 1000)
    return f"{minutes:02d}:{whole:02d}.{millis:03d}"


def save_json(path, data):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(data, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def build(args):
    source = no_symlinks(args.input)
    output = no_symlinks(args.output_dir)
    if not source.is_file():
        raise ValueError(f"Input is not a regular file: {source}")
    if output.exists():
        raise ValueError(f"Output path already exists; choose a NEW directory: {output}")
    cuts = parse_cuts(args.cuts)
    insets = parse_safe_area(args.safe_area, args.safe_area_label)
    font = font_path(args.font)
    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        raise ValueError("ffmpeg and ffprobe must already be available; nothing is installed")
    probe = json.loads(run([ffprobe, "-v", "error", "-protocol_whitelist", "file,pipe", "-threads", str(THREADS),
                           "-show_format", "-show_streams", "-of", "json", str(source)]).stdout)
    video = next((stream for stream in probe["streams"] if stream.get("codec_type") == "video"
                  and not stream.get("disposition", {}).get("attached_pic")), None)
    if video is None:
        raise ValueError("Input has no video stream")
    duration = float(video.get("duration", probe["format"].get("duration", "nan")))
    if not math.isfinite(duration) or not 0 < duration <= MAX_DURATION:
        raise ValueError(f"Video duration must be known and at most {MAX_DURATION} seconds; split longer reviews explicitly")
    if any(cut >= duration for cut in cuts):
        raise ValueError("Every cut must be inside the video duration")
    frame_probe = json.loads(run([ffprobe, "-v", "error", "-protocol_whitelist", "file,pipe", "-threads", str(THREADS),
                                 "-select_streams", str(video["index"]), "-show_frames",
                                 "-read_intervals", f"%+#{MAX_SOURCE_FRAMES + 1}",
                                 "-show_entries", "frame=best_effort_timestamp_time,pkt_duration_time,duration_time",
                                 "-of", "json", str(source)]).stdout)
    frames = frame_probe.get("frames", [])
    if not frames or len(frames) > MAX_SOURCE_FRAMES:
        raise ValueError(f"Video must have 1–{MAX_SOURCE_FRAMES} decoded frames")
    try:
        pts = [float(frame["best_effort_timestamp_time"]) for frame in frames]
    except (KeyError, ValueError) as error:
        raise ValueError("All decoded frames must have a usable presentation timestamp") from error
    if any(not math.isfinite(t) for t in pts) or any(b <= a for a, b in zip(pts, pts[1:])):
        raise ValueError("Non-increasing or invalid presentation timestamps; inspect the source separately")
    relative = [t - pts[0] for t in pts]
    last = relative[-1]
    try:
        rate = Fraction(video.get("avg_frame_rate", "0/1"))
    except (ValueError, ZeroDivisionError):
        rate = 0  # PTS and decoded frame duration remain authoritative when FPS is unknown.
    last_duration = float(frames[-1].get("duration_time", frames[-1].get("pkt_duration_time", 1 / rate if rate else 0)))
    if last + last_duration < duration - .05:
        raise ValueError("Frame probe did not reach the video end within resource limits; coverage would be incomplete")
    groups = [{"id": "opening", "title": "Opening: first 3 seconds, enlarged", "rate_fps": 2,
               "requested_range": [0, min(3, duration)], "frames": select_frames(relative, targets(0, min(last, 3 - .000001), .5)),
               "large": True},
              {"id": "overview", "title": "Whole video: 2 fps + final decoded frame", "rate_fps": 2,
               "requested_range": [0, duration], "frames": select_frames(relative, targets(0, last, .5)),
               "large": False}]
    if groups[1]["frames"][-1] != len(pts) - 1:
        groups[1]["frames"].append(len(pts) - 1)
    for n, cut in enumerate(cuts, 1):
        start, end = max(0, cut - .5), min(last, cut + .5)
        groups.append({"id": f"cut-{n:02d}", "title": f"Cut {timestamp(cut)}: +/-0.5 s, 10 fps",
                       "rate_fps": 10, "cut_seconds": cut, "requested_range": [start, end],
                       "frames": select_frames(relative, targets(start, end, .1)), "large": False})
    selected = sorted(set(index for group in groups for index in group["frames"]))
    page_count = sum(math.ceil(len(g["frames"]) / (6 if g["large"] else 12)) for g in groups)
    if len(selected) > MAX_SELECTED_FRAMES or page_count > MAX_PAGES:
        raise ValueError(f"Review exceeds limit: {MAX_SELECTED_FRAMES} selected frames / {MAX_PAGES} pages")
    # Use display aspect ratio, including pixel aspect and quarter-turn metadata.
    sar = video.get("sample_aspect_ratio", "1:1")
    try:
        pixel_aspect = float(Fraction(sar.replace(":", "/"))) if sar not in ("N/A", "0:1") else 1
    except (ValueError, ZeroDivisionError) as error:
        raise ValueError("Unusable pixel aspect ratio; inspect source dimensions separately") from error
    if not math.isfinite(pixel_aspect) or pixel_aspect <= 0:
        raise ValueError("Pixel aspect ratio must be positive and finite")
    aspect = video["width"] * pixel_aspect / video["height"]
    rotation = next((float(d["rotation"]) for d in video.get("side_data_list", []) if "rotation" in d), 0)
    if round(rotation) % 180:
        if round(rotation) % 90:
            raise ValueError("Non-quarter-turn rotation requires separate review preparation")
        aspect = 1 / aspect
    def size(max_width, max_height):
        return (max(2, round(min(max_width, max_height * aspect) / 2) * 2),
                max(2, round(min(max_height, max_width / aspect) / 2) * 2))
    large_size, small_size = size(360, 640), size(240, 360)
    source_hash = digest(source)
    output.mkdir(parents=True, exist_ok=False)
    (output / "frames").mkdir()
    manifest = {"version": 1, "input": str(source), "sha256": source_hash,
                "duration_seconds": duration, "source_first_pts_seconds": pts[0],
                "last_decoded_time_seconds": last, "source_frame_count": len(pts),
                "timestamp_basis": "Decoded best_effort_timestamp_time minus first source PTS; verified against extraction showinfo. Labels rounded to milliseconds.",
                "selection": "First source frame at or after each requested target; deduplicated; overview also includes final frame.",
                "safe_area": {"fractional_insets_left_top_right_bottom": insets, "label": args.safe_area_label,
                              "meaning": "User-supplied guide only; no platform compliance claim"} if insets else None,
                "limits": {"max_duration_seconds": MAX_DURATION, "max_source_frames": MAX_SOURCE_FRAMES,
                           "max_selected_frames": MAX_SELECTED_FRAMES, "max_pages": MAX_PAGES,
                           "threads": THREADS, "command_timeout_seconds": 180},
                "caveats": ["Sampled stills cannot establish smooth motion, lip sync, sound quality or absence of defects between frames.",
                            "No automatic cut detection: only explicitly supplied cut times receive dense sampling.",
                            "Low-frame-rate or variable-frame-rate input can produce fewer distinct samples than requested.",
                            "These sheets are review aids, not an automatic visual-quality pass."],
                "frames": [], "groups": groups, "pages": [], "status": "building"}
    try:
        with tempfile.TemporaryDirectory(prefix=".render-", dir=output) as temporary:
            temp = Path(temporary)
            shutil.copyfile(font, temp / "font.ttf")
            expression = "+".join(f"eq(n\\,{n})" for n in selected)
            extraction = run([ffmpeg, "-nostdin", "-hide_banner", "-nostats", "-n", "-copyts", "-protocol_whitelist", "file,pipe", "-threads", str(THREADS),
                              "-i", str(source), "-map", f"0:{video['index']}", "-an", "-sn", "-dn",
                              "-filter_threads", str(THREADS), "-vf",
                              f"select='{expression}',showinfo,scale={large_size[0]}:{large_size[1]},setsar=1",
                              "-fps_mode", "passthrough", "-threads", str(THREADS), str(output / "frames/%06d.png")])
            observed = [float(value) for value in re.findall(r"\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:([-+.\deE]+)", extraction.stderr)]
            if len(observed) != len(selected) or any(abs(actual - pts[index]) > .00005 for actual, index in zip(observed, selected)):
                raise ValueError("Extracted-frame timestamps did not match ffprobe; sheets were not accepted")
            frame_files = {}
            for number, index in enumerate(selected, 1):
                filename = f"frames/{number:06d}.png"
                if not (output / filename).is_file():
                    raise ValueError("Selected frame image is missing")
                frame_files[index] = filename
                manifest["frames"].append({"source_frame_index": index, "source_pts_seconds": pts[index],
                                           "time_seconds": relative[index], "label": timestamp(relative[index]), "file": filename})
            for group in groups:
                capacity, columns = (6, 3) if group["large"] else (12, 4)
                width, height = large_size if group["large"] else small_size
                label_height, margin, gap = 30, 8, 8
                for offset in range(0, len(group["frames"]), capacity):
                    chunk = group["frames"][offset:offset + capacity]
                    page_no = offset // capacity + 1
                    name = f"{group['id']}-{page_no:02d}.png"
                    rows = math.ceil(len(chunk) / columns)
                    concat = temp / "page.txt"
                    concat.write_text("".join(f"file '../{frame_files[index]}'\nduration 1\n" for index in chunk), encoding="utf-8")
                    page_width = columns * width + (columns - 1) * gap + 2 * margin
                    title_lines = [f"{group['title']} | page {page_no}"]
                    title_lines += textwrap.wrap((f"Yellow guide: {args.safe_area_label}" if insets else
                                                  "No safe-area guide supplied"), width=max(20, (page_width - 16) // 11))
                    header_height = 16 + 27 * len(title_lines)
                    filters = [f"scale={width}:{height}", "setsar=1"]
                    rectangle = None
                    if insets:
                        left, top, right, bottom = insets
                        x, y = round(width * left), round(height * top)
                        rect_w, rect_h = round(width * (1 - right)) - x, round(height * (1 - bottom)) - y
                        rectangle = {"x": x, "y": y, "width": rect_w, "height": rect_h, "stroke_px": 2}
                        filters.append(f"drawbox=x={x}:y={y}:w={rect_w}:h={rect_h}:color=yellow:t=2")
                    filters.append(f"pad=iw:ih+{label_height}:0:0:color=0x151820")
                    for n, index in enumerate(chunk):
                        # Colon-free text makes labels independent of ffmpeg filter escaping.
                        label = temp / f"label-{n:02d}.txt"
                        label.write_text(timestamp(relative[index]), encoding="utf-8")
                        filters.append(f"drawtext=fontfile=font.ttf:textfile={label.name}:expansion=none:fontsize=20:fontcolor=white:x=8:y={height + 2}:enable='eq(n,{n})'")
                    filters.extend([f"tile={columns}x{rows}:nb_frames={len(chunk)}:margin={margin}:padding={gap}:color=0x151820",
                                    f"pad=iw:ih+{header_height}:0:{header_height}:color=0x151820"])
                    for n, line in enumerate(title_lines):
                        title = temp / f"title-{n:02d}.txt"
                        title.write_text(line, encoding="utf-8")
                        filters.append(f"drawtext=fontfile=font.ttf:textfile={title.name}:expansion=none:fontsize=20:fontcolor=white:x=8:y={8 + n * 27}")
                    run([ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-n", "-protocol_whitelist", "file,pipe", "-threads", str(THREADS),
                         "-safe", "0", "-f", "concat", "-i", "page.txt", "-filter_threads", str(THREADS),
                         "-vf", ",".join(filters), "-frames:v", "1", "-threads", str(THREADS), "-update", "1", str(output / name)], cwd=temp)
                    manifest["pages"].append({"file": name, "group": group["id"], "source_frame_indices": chunk,
                                              "columns": columns, "rows": rows, "image_size": [width, height],
                                              "label_height": label_height, "header_height": header_height,
                                              "margin": margin, "gap": gap, "safe_rectangle_in_image": rectangle})
        if digest(source) != source_hash:
            raise ValueError("Source changed during review; do not rely on this report")
        manifest["status"] = "complete"
        manifest["coverage"] = {"selected_unique_frames": len(selected), "pages": len(manifest["pages"]),
                                "first_time_seconds": relative[selected[0]], "last_time_seconds": relative[selected[-1]],
                                "source_unchanged": True, "extraction_pts_verified": True}
        save_json(output / "manifest.json", manifest)
        sections = "\n".join(f'<section><h2>{html.escape(p["file"])}</h2><a href="{p["file"]}"><img src="{p["file"]}" alt="{html.escape(p["file"])}"></a></section>' for p in manifest["pages"])
        text = ("<!doctype html><meta charset='utf-8'><title>Video review contact sheets</title>"
                "<style>body{background:#151820;color:#f3f5fa;font:16px sans-serif;margin:24px}img{max-width:100%;height:auto}section{margin:32px 0}a{color:#bcdcff}</style>"
                f"<h1>{html.escape(source.name)}</h1><p>{len(selected)} unique frames; {len(manifest['pages'])} pages. "
                "Whole video 2 fps; opening enlarged; supplied cuts sampled at 10 fps.</p>"
                "<p>Labels show actual selected frame timestamps. Stills do not prove motion, lip sync or sound quality. "
                "A yellow rectangle, if present, is a user-supplied guide, not a platform guarantee.</p>"
                f'<p><a href="manifest.json">Coverage, exact source PTS and limits</a></p>{sections}')
        with (output / "index.html").open("x", encoding="utf-8") as stream:
            stream.write(text)
        return manifest
    except Exception:
        manifest["status"] = "failed"
        save_json(output / "failure.json", manifest)
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path, help="New directory; existing paths and symlinks are refused")
    parser.add_argument("--cuts", nargs="+", default=[], help="Actual cut times in seconds, separated by commas or spaces; no automatic cut detection")
    parser.add_argument("--safe-area", help="Explicit left,top,right,bottom fractional insets (e.g. 0.08,0.10,0.08,0.15)")
    parser.add_argument("--safe-area-label", help="Your source/meaning for the guide; no platform defaults are assumed")
    parser.add_argument("--font", type=Path, help="Existing local font if automatic font discovery fails")
    args = parser.parse_args(argv)
    try:
        result = build(args)
        print(json.dumps({"status": result["status"], "output_dir": str(args.output_dir.absolute()),
                          "coverage": result["coverage"]}, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
