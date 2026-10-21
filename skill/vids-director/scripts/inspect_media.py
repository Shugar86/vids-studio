#!/usr/bin/env python3
"""Offline decode, loudness, amplitude-silence and visual-change inspection.

Requires existing ffmpeg/ffprobe; no installation, network media or source edits.
Observations are review prompts with timecodes, never an aesthetic pass/fail.
Amplitude silence is not absence of speech. Mix RMS is not isolated music level.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import sys

NUMBER = r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?"
LEVEL = r"[-+]?(?:\d+(?:\.\d*)?|\.\d+|inf|nan)"
ASTATS = "astats=metadata=0:reset=0:measure_perchannel=Peak_level+RMS_level:measure_overall=Peak_level+RMS_level+Number_of_NaNs+Number_of_Infs"


def finite(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Expected a finite number")
    return number


def nonnegative(value):
    number = finite(value)
    if number < 0:
        raise ValueError("Expected a nonnegative number")
    return number


def nullable_level(value):
    number = float(value)
    return number if math.isfinite(number) else None


def parse_cuts(value):
    cuts = [nonnegative(part.strip()) for part in value.split(",")]
    if cuts != sorted(set(cuts)) or any(cut == 0 for cut in cuts):
        raise ValueError("--cuts must be strictly increasing positive times")
    return cuts


def parse_windows(value):
    windows = []
    for part in value.split(","):
        start, end = (nonnegative(piece.strip()) for piece in part.split(":"))
        if start >= end or (windows and start < windows[-1][1]):
            raise ValueError("--pause-windows must be ordered, non-overlapping start:end pairs")
        windows.append((start, end))
    return windows


def interval(start, end):
    return {"start_seconds": start, "end_seconds": end, "duration_seconds": round(end - start, 6)}


def parse_audio(stderr, duration):
    sections, silence = {}, []
    section = start = None
    for line in stderr.splitlines():
        if "[Parsed_astats" in line:
            detail = line.split("]", 1)[1].strip()
            if detail == "Overall" or re.fullmatch(r"Channel: \d+", detail):
                section = detail
                sections[section] = {}
            elif section and ": " in detail:
                key, value = detail.split(": ", 1)
                sections[section][key] = value
        match = re.search(r"silence_start: (" + NUMBER + ")", line)
        if match:
            start = max(0.0, float(match[1]))
        match = re.search(r"silence_end: (" + NUMBER + ")", line)
        if match and start is not None:
            end = min(duration, float(match[1]))
            if end >= start:
                silence.append(interval(start, end))
            start = None
    if start is not None and start < duration:
        silence.append({**interval(start, duration), "end_inferred_from_duration": True})
    summary = stderr.rsplit("Summary:", 1)[-1]
    integrated = re.search(r"\bI:\s*(" + LEVEL + r")\s*LUFS", summary)
    peak = re.search(r"True peak:\s*Peak:\s*(" + LEVEL + r")\s*dBFS", summary)
    loudness = {
        "method": "FFmpeg ebur128=peak=true (oversampled true peak)",
        "analysis_ok": bool(integrated and peak),
        "integrated_lufs": nullable_level(integrated[1]) if integrated else None,
        "true_peak_dbtp": nullable_level(peak[1]) if peak else None,
        "true_peak_raw": peak[1] if peak else None,
        "integrated_at_meter_floor": bool(integrated and float(integrated[1]) <= -70),
        "caveat": "Integrated gated loudness is not dialogue loudness. Silence may yield the meter floor; non-finite levels are null. No automatic normalization is performed.",
    }
    return sections, silence, loudness


def parse_visual(stderr, duration):
    freezes, candidates, start = [], [], None
    for line in stderr.splitlines():
        match = re.search(r"lavfi\.freezedetect\.freeze_start: (" + NUMBER + ")", line)
        if match:
            start = max(0.0, float(match[1]))
        match = re.search(r"lavfi\.freezedetect\.freeze_end: (" + NUMBER + ")", line)
        if match and start is not None:
            freezes.append(interval(start, min(duration, float(match[1]))))
            start = None
        match = re.search(r"lavfi\.scd\.score: (" + NUMBER + r"), lavfi\.scd\.time: (" + NUMBER + ")", line)
        if match and 0 < float(match[2]) < duration:
            candidates.append({"time_seconds": float(match[2]), "change_score": float(match[1])})
    if start is not None and start < duration:
        freezes.append({**interval(start, duration), "end_inferred_from_duration": True})
    return freezes, candidates


def silence_observations(silence, duration, args):
    observations = []
    for span in silence:
        opening = span["start_seconds"] <= 0.02
        closing = span["end_seconds"] >= duration - 0.02
        kinds = []
        if opening:
            kinds.append(("opening_amplitude_silence", args.start_silence))
        if closing:
            kinds.append(("tail_amplitude_silence", args.tail_silence))
        if not opening and not closing:
            kinds.append(("internal_amplitude_silence", args.internal_silence))
        for kind, threshold in kinds:
            if span["duration_seconds"] > threshold:
                observations.append({"code": kind, **span, "threshold_seconds": threshold,
                                     "note": "Audio is below the amplitude threshold; inspect the timing in context. This is not speech-absence detection."})
    return observations


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def run_ffmpeg(executable, source, *options, level="info"):
    return subprocess.run([
        executable, "-nostdin", "-hide_banner", "-nostats", "-v", level,
        "-xerror", "-threads", "2", "-protocol_whitelist", "file,pipe", "-i", str(source),
        "-filter_threads", "1", *options, "-threads", "2", "-f", "null", "-",
    ], text=True, capture_output=True)


def make_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", required=True, type=Path, help="Fresh JSON path; input/existing files are never overwritten")
    parser.add_argument("--target-lufs", type=finite, help="Optional delivery target; choose for the actual platform, no universal default")
    parser.add_argument("--loudness-tolerance", type=nonnegative, default=1.0, help="LU deviation prompting review (default: 1)")
    parser.add_argument("--start-silence", type=nonnegative, default=0.3, help="Opening amplitude-silence review threshold, seconds")
    parser.add_argument("--internal-silence", type=nonnegative, default=0.7, help="Internal amplitude-silence review threshold, seconds")
    parser.add_argument("--tail-silence", type=nonnegative, default=0.5, help="Tail amplitude-silence review threshold, seconds")
    parser.add_argument("--silence-dbfs", type=finite, default=-45.0, help="Silencedetect amplitude threshold (default: -45 dBFS)")
    parser.add_argument("--silence-minimum", type=nonnegative, default=0.2, help="Shortest detected amplitude-silence interval, seconds")
    parser.add_argument("--freeze-minimum", type=nonnegative, default=0.7, help="Minimum low-change interval, seconds")
    parser.add_argument("--freeze-noise", type=nonnegative, default=0.001, help="Freezedetect normalized difference tolerance, 0..1")
    parser.add_argument("--cut-threshold", type=nonnegative, default=10.0, help="Scdet visual-cut candidate threshold, 0..100")
    parser.add_argument("--cuts", type=parse_cuts, help="Known edit times in seconds, e.g. 2.5,6,12; overrides candidate segment boundaries")
    parser.add_argument("--pause-windows", type=parse_windows, help="Caller-verified speech pauses, e.g. 0:0.8,8.5:9.6; measures MIX RMS, not isolated music")
    return parser


def inspect(source, ffmpeg, ffprobe, args):
    probe = json.loads(subprocess.run([
        ffprobe, "-v", "error", "-protocol_whitelist", "file,pipe", "-show_format", "-show_streams", "-of", "json", str(source),
    ], check=True, text=True, capture_output=True).stdout)
    streams = probe["streams"]
    audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    video = next((stream for stream in streams if stream.get("codec_type") == "video" and not stream.get("disposition", {}).get("attached_pic")), None)
    if audio is None:
        raise ValueError("Input has no audio stream to inspect")
    duration = finite(probe["format"]["duration"])
    if duration <= 0:
        raise ValueError("Media duration must be positive")
    audio_duration = finite(audio.get("duration", duration))
    video_duration = finite(video.get("duration", duration)) if video else duration
    if any(end > audio_duration + 0.001 for _, end in args.pause_windows or []):
        raise ValueError("A --pause-windows interval exceeds the audio duration")
    if args.cuts is not None and (not video or any(cut >= video_duration for cut in args.cuts)):
        raise ValueError("--cuts requires video and times strictly inside its duration")
    decode = run_ffmpeg(ffmpeg, source, "-map", "0:v:0?", "-map", "0:a:0", level="error")
    stats = run_ffmpeg(ffmpeg, source, "-map", "0:a:0", "-vn", "-af",
                       f"{ASTATS},silencedetect=noise={args.silence_dbfs}dB:d={args.silence_minimum},ebur128=peak=true:framelog=verbose")
    sections, silence, loudness = parse_audio(stats.stderr, audio_duration)
    decode_ok = decode.returncode == 0 and not decode.stderr.strip()
    signal_ok = stats.returncode == 0 and "Peak level dB" in sections.get("Overall", {}) and loudness["analysis_ok"]
    observations = silence_observations(silence, audio_duration, args)
    loudness.update({"target_lufs": args.target_lufs, "tolerance_lu": args.loudness_tolerance, "difference_from_target_lu": None})
    if args.target_lufs is not None and loudness["integrated_lufs"] is not None:
        delta = round(loudness["integrated_lufs"] - args.target_lufs, 3)
        loudness["difference_from_target_lu"] = delta
        if abs(delta) > args.loudness_tolerance:
            observations.append({"code": "loudness_below_target" if delta < 0 else "loudness_above_target",
                                 **interval(0, duration), "difference_lu": delta,
                                 "note": "Deviation from the caller's delivery target; review the mix and true peak before adjusting it."})
    visual = {"analysis_ok": None, "available": bool(video), "low_change_intervals": [], "cut_candidates": [], "segment_lengths": []}
    if video:
        analysis = run_ffmpeg(ffmpeg, source, "-map", f"0:{video['index']}", "-an", "-vf",
                              f"scale=w='min(480,iw)':h=-2,freezedetect=n={args.freeze_noise}:d={args.freeze_minimum},scdet=threshold={args.cut_threshold}")
        freezes, candidates = parse_visual(analysis.stderr, video_duration)
        cuts = args.cuts if args.cuts is not None else sorted({candidate["time_seconds"] for candidate in candidates})
        boundaries = [0.0, *cuts, video_duration]
        visual.update({
            "analysis_ok": analysis.returncode == 0,
            "diagnostics": analysis.stderr.strip() if analysis.returncode else "",
            "low_change_intervals": freezes, "cut_candidates": candidates,
            "segment_boundary_source": "caller_supplied_edit_times" if args.cuts is not None else "visual_change_candidates",
            "segment_lengths": [interval(start, end) for start, end in zip(boundaries, boundaries[1:])],
            "settings": {"maximum_analysis_width": 480, "frame_sampling": "all decoded frames", "freeze_noise": args.freeze_noise,
                         "freeze_minimum_seconds": args.freeze_minimum, "cut_threshold": args.cut_threshold},
            "caveat": "Low pixel change is a candidate freeze/static interval, not a boringness verdict. Visual cuts are heuristic: overlays, flashes and fades can add or hide candidates. Segment lengths are not verified Vids scene durations. Downscaling may hide small motion.",
        })
        observations.extend({"code": "low_visual_change", **span, "note": "Inspect intent and action in this interval; a deliberate hold may be appropriate."} for span in freezes)
    pause_levels = []
    for start, end in args.pause_windows or []:
        result = run_ffmpeg(ffmpeg, source, "-map", "0:a:0", "-vn", "-af", f"atrim=start={start}:end={end},asetpts=PTS-STARTPTS,{ASTATS}")
        window_stats, _, _ = parse_audio(result.stderr, end - start)
        raw_rms = window_stats.get("Overall", {}).get("RMS level dB")
        ok = result.returncode == 0 and raw_rms is not None
        pause_levels.append({**interval(start, end), "analysis_ok": ok,
                             "mix_rms_dbfs": nullable_level(raw_rms) if raw_rms is not None else None,
                             "mix_rms_raw": raw_rms,
                             "diagnostics": result.stderr.strip() if not ok else ""})
    subtitles = [{"index": stream["index"], "codec_name": stream.get("codec_name")} for stream in streams if stream.get("codec_type") == "subtitle"]
    if video:
        observations.append({"code": "subtitle_visibility_unverified", **interval(0, video_duration),
                             "note": "Soft subtitle streams are present; burned-in captions are unknown. Inspect frames with subtitle rendering disabled." if subtitles else "No subtitle stream was found; burned-in captions are still unknown. Inspect frames to verify sound-off comprehension."})
    return {
        "input": str(source), "sha256": sha256(source), "duration_seconds": duration,
        "streams": [{key: stream[key] for key in ("index", "codec_type", "codec_name", "width", "height", "sample_rate", "channels", "duration") if key in stream} for stream in streams],
        "decode_ok": decode_ok, "decode_exit_code": decode.returncode, "decode_diagnostics": decode.stderr.strip(),
        "signal_analysis_ok": signal_ok, "signal_diagnostics": stats.stderr.strip() if not signal_ok else "",
        "sample_levels": sections, "silence_threshold_dbfs": args.silence_dbfs,
        "silence_minimum_seconds": args.silence_minimum, "silence_intervals": silence,
        "silence_review_thresholds_seconds": {"opening": args.start_silence, "internal": args.internal_silence, "tail": args.tail_silence},
        "loudness": loudness, "visual_analysis": visual,
        "pause_window_mix_levels": pause_levels,
        "pause_window_caveat": "Windows are caller-supplied speech pauses, not independently detected. RMS includes ALL audio in the mix (music, noise, effects, any speech). No source separation or music audibility verdict.",
        "subtitles": {"soft_streams_present": bool(subtitles), "streams": subtitles, "burned_in": "unknown"},
        "observations": observations, "observation_policy": "Timed review prompts only; observations do not cause a technical failure or establish creative quality.",
        "caveat": "sample_levels contains sample peak, not true peak; true peak is separately measured by ebur128. Amplitude silence is not speech absence. No listening, timbre, lip-sync or creative-quality verdict.",
    }


def main():
    args = make_parser().parse_args()
    try:
        if args.freeze_noise > 1 or args.cut_threshold > 100:
            raise ValueError("--freeze-noise must be 0..1 and --cut-threshold 0..100")
        if args.silence_minimum == 0 or args.freeze_minimum == 0:
            raise ValueError("--silence-minimum and --freeze-minimum must be positive")
        source = args.input.expanduser().resolve(strict=True)
        if not source.is_file():
            raise ValueError(f"Input is not a regular file: {source}")
        output = args.output.expanduser()
        if output.resolve() == source or (output.exists() and output.samefile(source)):
            raise ValueError(f"Output would overwrite the input: {output}")
        if output.exists() or output.is_symlink():
            raise ValueError(f"Output already exists; choose a fresh --output path: {output}")
        ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
        if not ffmpeg or not ffprobe:
            raise ValueError("ffmpeg and ffprobe must already be available; this script does not install them")
        report = inspect(source, ffmpeg, ffprobe, args)
        serialized = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        output.parent.mkdir(parents=True, exist_ok=True)
        # Exclusive creation also refuses a destination created during analysis.
        with output.open("x", encoding="utf-8") as handle:
            handle.write(serialized)
        print(serialized, end="")
        if (not report["decode_ok"] or not report["signal_analysis_ok"]
                or report["visual_analysis"]["analysis_ok"] is False
                or any(not window["analysis_ok"] for window in report["pause_window_mix_levels"])):
            print(f"Error: media checks failed; inspect the saved report: {output}", file=sys.stderr)
            return 1
        return 0
    except subprocess.CalledProcessError as error:
        print(f"Error: {Path(error.cmd[0]).name} failed: {(error.stderr or '').strip() or error.returncode}", file=sys.stderr)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"Error: {error}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
