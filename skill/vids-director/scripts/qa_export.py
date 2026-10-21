#!/usr/bin/env python3
"""Viewer-oriented QA of an exported video: contact sheets plus timed findings.

Uses only existing ffmpeg/ffprobe and the Python stdlib; never edits the input.
Findings point at moments worth looking at. They are measurements, not
listening, not a judgement of the idea, and not a score.
"""
import argparse
import json
import re
import shutil
import statistics
import subprocess
import sys
from pathlib import Path

PROFILES = {
    # Approximate overlay zones of Reels/Shorts/TikTok UI; verify per platform.
    "social": {"lufs": -14.0, "tol": 2.0, "tp_max": -1.0, "max_shot": 5.0,
               "unsafe": {"top": 0.12, "bottom": 0.22, "left": 0.05, "right": 0.12}},
    "web": {"lufs": -16.0, "tol": 2.0, "tp_max": -1.0, "max_shot": 8.0, "unsafe": None},
    "broadcast": {"lufs": -23.0, "tol": 1.0, "tp_max": -1.0, "max_shot": 10.0, "unsafe": None},
}
ACTIVE_BELOW = 10.0   # LU under integrated loudness: program is "on"
GAP_BELOW = 18.0      # LU under integrated loudness: a pause the viewer notices
GAP_MIN = 0.8         # s; sentence breaks of 0.3–0.7 s are normal speech
LEAD_MAX = 0.3        # s before the first sound
TAIL_MAX = 0.6        # s after the last sound
QUIET_BED = 25.0      # LU: a music bed this far under the program is inaudible on phones
STILL_DIFF = 0.25     # 0.5 s mean abs frame difference (0..255, 270x480 gray): barely moving
FROZEN_DIFF = 0.08    # same measure: the picture stands still
STILL_MIN = 0.8       # s
TRANSITION_DIFF = 3.0
GENERATOR_LENGTHS = (8.0, 10.0, 20.0)
GENERATOR_TOL = 0.25


THREADS = ["-threads", "2", "-filter_threads", "2"]  # stay light on the user's machine


def run(cmd):
    if cmd and Path(cmd[0]).name == "ffmpeg":
        cmd = cmd[:1] + THREADS + cmd[1:]
    if cmd and Path(cmd[0]).name in {"ffmpeg", "ffprobe"}:
        cmd = cmd[:1] + ["-protocol_whitelist", "file,pipe"] + cmd[1:]
    return subprocess.run(cmd, text=True, capture_output=True)


def rolling_mean(points, window):
    """Smooth per-frame values: fps-conversion duplicates read as zero motion, cut spikes are clipped."""
    values = [min(v, 1.0) for _, v in points]
    half = max(1, window // 2)
    return [(t, statistics.fmean(values[max(0, i - half):i + half + 1])) for i, (t, _) in enumerate(points)]


def runs(points, predicate, step):
    """Merge consecutive (t, value) samples matching predicate into [start, end] spans."""
    spans, start, last = [], None, None
    for t, value in points:
        if predicate(value):
            if start is None:
                start = t
            last = t
        elif start is not None:
            spans.append((start, last + step))
            start = None
    if start is not None:
        spans.append((start, last + step))
    return spans


def probe(path, ffprobe):
    data = json.loads(run([ffprobe, "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)]).stdout)
    video = next((s for s in data["streams"] if s["codec_type"] == "video"), None)
    if not video:
        raise ValueError("No video stream")
    num, den = video.get("r_frame_rate", "30/1").split("/")
    return {
        "duration": float(data["format"]["duration"]),
        "width": int(video["width"]), "height": int(video["height"]),
        "fps": float(num) / float(den or 1),
        "audio": [s.get("codec_name") for s in data["streams"] if s["codec_type"] == "audio"],
        "subtitles": [s.get("codec_name") for s in data["streams"] if s["codec_type"] == "subtitle"],
    }


def loudness(path, ffmpeg):
    out = run([ffmpeg, "-nostdin", "-hide_banner", "-nostats", "-i", str(path), "-map", "0:a:0",
               "-af", "ebur128=peak=true", "-f", "null", "-"]).stderr
    series = []
    for line in out.splitlines():
        m = re.search(r"\bt:\s*([\d.]+).*?\bM:\s*(-?inf|-?[\d.]+)", line)
        if m:
            value = float(m.group(2)) if "inf" not in m.group(2) else -120.0
            series.append((float(m.group(1)), value))
    summary = out.split("Summary:")[-1]
    grab = lambda pattern: float(re.search(pattern, summary).group(1))
    return {"integrated": grab(r"I:\s*(-?[\d.]+) LUFS"), "lra": grab(r"LRA:\s*(-?[\d.]+) LU"),
            "true_peak": grab(r"Peak:\s*(-?[\d.]+) dBFS"), "momentary": series}


def frame_metrics(path, ffmpeg, scene):
    """Per-frame scene score or mean abs difference from the previous frame."""
    chain = ("scale=270:480,select='gte(scene\\,0)',metadata=print:key=lavfi.scene_score" if scene else
             "scale=270:480,format=gray,tblend=all_mode=difference,signalstats,"
             "metadata=print:key=lavfi.signalstats.YAVG")
    out = run([ffmpeg, "-nostdin", "-hide_banner", "-nostats", "-i", str(path), "-an", "-vf", chain,
               "-f", "null", "-"]).stderr
    values, t = [], None
    for line in out.splitlines():
        m = re.search(r"pts_time:([\d.]+)", line)
        if m:
            t = float(m.group(1))
        m = re.search(r"(?:scene_score|YAVG)=([\d.]+)", line)
        if m and t is not None:
            values.append((t, float(m.group(1))))
    return values


def boundaries(diffs, scenes):
    """Shot boundaries: hard cuts (scene score) plus the centres of dissolves (difference spikes)."""
    marks = [t for t, v in scenes if v >= 0.3]
    # A dissolve is a short burst of change between calmer stretches, not continuous fast motion.
    for start, end in runs(diffs, lambda v: v >= TRANSITION_DIFF, 1 / 30):
        before = [v for t, v in diffs if start - 1.0 <= t < start]
        after = [v for t, v in diffs if end < t <= end + 1.0]
        burst = statistics.fmean(v for t, v in diffs if start <= t <= end)
        calm = max(statistics.median(before or [0]), statistics.median(after or [0]))
        if 0.1 <= end - start <= 1.5 and burst >= 3 * max(calm, 0.3):
            marks.append((start + end) / 2)
    merged = []
    for t in sorted(marks):
        if merged and t - merged[-1] < 0.4:
            merged[-1] = (merged[-1] + t) / 2
        else:
            merged.append(t)
    return merged


def sheet(ffmpeg, src, out, start, end, fps, cols, rows, size, extra=""):
    vf = (f"trim=start={start:.3f}:end={end:.3f},fps={fps},scale={size},{extra}"
          "drawtext=text='%{pts\\:hms}':x=6:y=6:fontsize=20:fontcolor=yellow:box=1:boxcolor=black@0.7,"
          f"tile={cols}x{rows}:padding=4:color=gray")
    result = run([ffmpeg, "-nostdin", "-v", "error", "-i", str(src), "-vf", vf, "-frames:v", "1", "-update", "1", str(out)])
    if result.returncode:
        raise RuntimeError(f"ffmpeg sheet failed: {result.stderr.strip()[:400]}")
    return out


def safe_zone_sheet(ffmpeg, src, out, times, info, unsafe):
    frame_ids = "+".join(f"eq(n\\,{round(t * info['fps'])})" for t in times)
    boxes = ",".join([
        f"drawbox=x=0:y=0:w=iw:h=ih*{unsafe['top']}:color=red@0.35:t=fill",
        f"drawbox=x=0:y=ih*{1 - unsafe['bottom']}:w=iw:h=ih*{unsafe['bottom']}:color=red@0.35:t=fill",
        f"drawbox=x=0:y=0:w=iw*{unsafe['left']}:h=ih:color=red@0.25:t=fill",
        f"drawbox=x=iw*{1 - unsafe['right']}:y=0:w=iw*{unsafe['right']}:h=ih:color=red@0.25:t=fill",
    ])
    vf = (f"select='{frame_ids}',scale=432:768,{boxes},"
          "drawtext=text='%{pts\\:hms}':x=6:y=6:fontsize=22:fontcolor=yellow:box=1:boxcolor=black@0.7,"
          f"tile={len(times)}x1:padding=6:color=gray")
    result = run([ffmpeg, "-nostdin", "-v", "error", "-i", str(src), "-vf", vf, "-frames:v", "1", "-update", "1", str(out)])
    if result.returncode:
        raise RuntimeError(f"ffmpeg safe-zone sheet failed: {result.stderr.strip()[:400]}")
    return out


def fmt(a, b=None):
    return f"{a:.2f} с" if b is None else f"{a:.2f}–{b:.2f} с"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", type=Path)
    parser.add_argument("--out", required=True, type=Path, help="New or empty directory for sheets and findings")
    parser.add_argument("--profile", choices=sorted(PROFILES), default="social")
    args = parser.parse_args()
    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        print("Error: ffmpeg/ffprobe must already be installed; this script installs nothing", file=sys.stderr)
        return 1
    src = args.input.expanduser().resolve(strict=True)
    out = args.out.expanduser().resolve()
    if out.exists() and any(out.iterdir()):
        print(f"Error: {out} is not empty; choose a fresh --out", file=sys.stderr)
        return 1
    (out / "sheets").mkdir(parents=True, exist_ok=True)
    profile = PROFILES[args.profile]
    info = probe(src, ffprobe)
    dur = info["duration"]
    findings = []

    def add(level, when, what, look):
        findings.append({"level": level, "time": when, "what": what, "look": look})

    # --- audio -------------------------------------------------------------
    audio = None
    gaps = []
    audio_first, audio_last = 0.0, dur
    if not info["audio"]:
        add("высокий", "весь ролик", "В файле нет аудиодорожки.", "Проверь экспорт и дорожки в Vids.")
    else:
        audio = loudness(src, ffmpeg)
        i_lufs = audio["integrated"]
        series = audio["momentary"]
        active = [t for t, m in series if m >= i_lufs - ACTIVE_BELOW]
        if active:
            first = audio_first = max(0.0, active[0] - 0.15)   # momentary window is 400 ms
            last = audio_last = min(dur, active[-1])
            if first > LEAD_MAX:
                add("высокий", fmt(0, first), f"Звук начинается только через {first:.1f} с.",
                    "Первые кадры без звука теряют зрителя ленты: подрежь начало клипа, речь или звук с 0.0–0.3 с.")
            if dur - last > TAIL_MAX:
                add("средний", fmt(last, dur), f"Хвост без звука {dur - last:.1f} с.",
                    "Закончи ролик на последнем слове или удержании контакта; посмотри конец на листе ending.")
            inner = [(t, m) for t, m in series if first + 0.3 < t < last]
            for a, b in runs(inner, lambda m: m < i_lufs - GAP_BELOW, 0.1):
                a = max(first, a - 0.3)   # the 400 ms window lags the start of silence
                if b - a >= GAP_MIN:
                    level = statistics.median(m for t, m in inner if a <= t <= b)
                    gaps.append((a, b))
                    note = (" В паузе полная тишина." if level <= -70 else
                            f" Фон в паузе ≈{i_lufs - level:.0f} LU ниже программы — на телефоне не слышен."
                            if i_lufs - level > QUIET_BED else "")
                    add("средний", fmt(a, b), f"Пауза {b - a:.1f} с.{note}",
                        "Это задуманная пауза или хвост генерации? Сопоставь с листом таймлайна.")
        target, tol = profile["lufs"], profile["tol"]
        if abs(i_lufs - target) > tol:
            level = "высокий" if abs(i_lufs - target) > 2 * tol + 2 else "средний"
            ceiling = i_lufs + profile["tp_max"] - audio["true_peak"]   # plain gain, no limiter
            limit = (f" Простым усилением без лимитера достижимо лишь ≈{ceiling:.0f} LUFS: пик упрётся в {profile['tp_max']:.0f} dBTP."
                     if i_lufs < target and ceiling < target - tol else "")
            add(level, "весь ролик", f"Громкость {i_lufs:.1f} LUFS при ориентире {target:.0f} ±{tol:.0f} ({args.profile}).{limit}",
                "Подними/опусти уровень дорожек в Vids и измерь новый экспорт; цифра не заменяет прослушивание.")
        if audio["true_peak"] > profile["tp_max"]:
            add("средний", "весь ролик", f"Пик {audio['true_peak']:.1f} dBTP выше {profile['tp_max']:.0f}.",
                "Риск перегруза после перекодирования площадкой.")

    # --- picture -----------------------------------------------------------
    diffs = frame_metrics(src, ffmpeg, scene=False)
    scenes = frame_metrics(src, ffmpeg, scene=True)
    cuts = boundaries(diffs, scenes)
    edges = [0.0] + cuts + [dur]
    shots = [(a, b) for a, b in zip(edges, edges[1:]) if b - a > 0.2]
    for a, b in shots:
        length = b - a
        if length > profile["max_shot"]:
            add("средний", fmt(a, b), f"План {length:.1f} с без смены картинки (ориентир ≤{profile['max_shot']:.0f} с для {args.profile}).",
                "Есть ли перебивка показом, деталью или графикой?")
        near = [g for g in GENERATOR_LENGTHS if abs(length - g) <= GENERATOR_TOL]
        if near:
            add("средний", fmt(a, b), f"Длина плана {length:.2f} с ≈ типичной длине генерации ({near[0]:.0f} с).",
                "Проверь, не задал ли генератор монтажную сетку: сцена должна кончаться у последнего слова/действия.")
    smooth = rolling_mean(diffs, round(info["fps"] / 2))
    frame = 1 / max(info["fps"], 1)
    quiet = gaps + ([(0.0, audio_first)] if audio_first > LEAD_MAX else []) + \
        ([(audio_last, dur)] if audio and dur - audio_last > TAIL_MAX else [])
    frozen = []
    for a, b in runs(smooth, lambda v: v < STILL_DIFF, frame):
        if b - a < STILL_MIN:
            continue
        stands = min(v for t, v in smooth if a <= t <= b) < FROZEN_DIFF
        frozen.append((a, b))
        silent = any(min(b, qb) - max(a, qa) >= 0.5 for qa, qb in quiet)
        add("высокий" if silent else "средний", fmt(a, b),
            ("Картинка стоит" if stands else "Картинка почти неподвижна") + f" {b - a:.1f} с" +
            (" и звука почти нет — мёртвый момент." if silent else "."),
            "Добавь движение/смену или сократи; проверь на листе таймлайна.")

    # --- subtitles and checks a machine cannot do --------------------------
    if args.profile == "social":
        if info["subtitles"]:
            add("высокий", "весь ролик", f"Субтитры только дорожкой ({', '.join(info['subtitles'])}) — в соцсетях и мессенджерах их обычно не видно.",
                "Нужны вшитые субтитры (styled captions или текст на canvas); проверь по листам, видны ли они.")
        else:
            add("инфо", "весь ролик", "Отдельной дорожки субтитров нет; вшиты ли они — не определяется автоматически.",
                "Проверь по листам таймлайна, что ключевая мысль читается без звука.")
    if info["width"] > info["height"] and args.profile == "social":
        add("инфо", "весь ролик", "Горизонтальный кадр при профиле social.", "Нужна ли вертикаль 9:16 для площадки?")

    # --- sheets ------------------------------------------------------------
    vertical = info["height"] >= info["width"]
    size, cols = ("216:384", 10) if vertical else ("384:216", 6)
    made = []
    page_len = 15.0
    page = 0
    while page * page_len < dur:
        a, b = page * page_len, min(dur, (page + 1) * page_len)
        made.append(sheet(ffmpeg, src, out / "sheets" / f"timeline_{page + 1:02d}.png", a, b, 2, cols, 3, size))
        page += 1
    made.append(sheet(ffmpeg, src, out / "sheets" / "opening_0-3s.png", 0, min(3, dur), 10, cols, 3, size))
    made.append(sheet(ffmpeg, src, out / "sheets" / "ending_last3s.png", max(0, dur - 3), dur, 10, cols, 3, size))
    for n, t in enumerate(cuts, 1):
        made.append(sheet(ffmpeg, src, out / "sheets" / f"transition_{n:02d}_{t:.2f}s.png",
                          max(0, t - 0.5), min(dur, t + 0.5), 10, 10, 1, size))
    if profile["unsafe"] and vertical:
        mids = [(a + b) / 2 for a, b in shots]
        for n in range(0, len(mids), 6):
            made.append(safe_zone_sheet(ffmpeg, src, out / "sheets" / f"safezones_{n // 6 + 1:02d}.png",
                                        mids[n:n + 6], info, profile["unsafe"]))

    report = {
        "input": str(src), "profile": args.profile, "probe": info,
        "loudness": None if not audio else {k: audio[k] for k in ("integrated", "lra", "true_peak")},
        "cuts_seconds": [round(t, 2) for t in cuts],
        "shots": [{"start": round(a, 2), "end": round(b, 2), "length": round(b - a, 2)} for a, b in shots],
        "pauses": [{"start": round(a, 2), "end": round(b, 2)} for a, b in gaps],
        "frozen": [{"start": round(a, 2), "end": round(b, 2)} for a, b in frozen],
        "findings": findings, "sheets": [str(p.relative_to(out)) for p in made],
        "caveat": "Measurements and frames, not listening or watching motion. Thresholds are orientation, not a verdict.",
    }
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    order = {"высокий": 0, "средний": 1, "инфо": 2}
    # No file name in the heading: findings.md goes to the blind viewer-critic.
    lines = ["# QA экспорта", "",
             f"{dur:.2f} с · {info['width']}×{info['height']} · {info['fps']:.0f} к/с · профиль {args.profile}"]
    if audio:
        lines.append(f"Громкость {audio['integrated']:.1f} LUFS · LRA {audio['lra']:.1f} LU · пик {audio['true_peak']:.1f} dBTP")
    lines += ["", "Планы: " + ", ".join(f"{a:.1f}–{b:.1f} ({b - a:.1f})" for a, b in shots), "", "## Находки", ""]
    for f in sorted(findings, key=lambda f: order[f["level"]]):
        lines.append(f"- **{f['level']}** · {f['time']} · {f['what']} → {f['look']}")
    if not findings:
        lines.append("- Измерения ничего не отметили. Это не значит, что ролик хороший.")
    lines += ["", "## Посмотри глазами (машина этого не видит)", "",
              "- `opening_0-3s.png`: понятно ли без звука, что предлагают и кому, к 2–3 с?",
              "- Каждый `transition_*.png`: нет ли наложения текстов, полупрозрачного текста поверх лица, латиницы и псевдотекста.",
              "- `safezones_*.png`: текст, лица, контакт и кнопки не заходят в красные зоны.",
              "- `ending_last3s.png`: контакт/действие на экране, читается, держится ≥3 с.",
              "- Все `timeline_*.png`: один стиль текста, нет пустых кадров и плейсхолдеров, показ услуги — а не только слова.",
              "", "Листы: " + ", ".join(f"`{p.relative_to(out)}`" for p in made), "",
              "_Это измерения и кадры, а не прослушивание и не просмотр движения._"]
    (out / "findings.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, KeyError, AttributeError, json.JSONDecodeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1)
