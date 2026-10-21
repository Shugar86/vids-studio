#!/usr/bin/env python3
"""Offline English/Russian ASR with an existing whisper.cpp CLI and local model.

No installation, model download, expected-text prompt or remote transcription.
Writes WAV/TXT/SRT/token JSON/run metadata under the explicit --output prefix.
"""
import argparse
import hashlib
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import json


def existing_file(path, description):
    resolved = path.expanduser().resolve(strict=True)
    if not resolved.is_file():
        raise ValueError(f"{description} is not a regular file: {resolved}")
    return resolved


def check_outputs(paths, source):
    for path in paths:
        if path.resolve() == source or (path.exists() and path.samefile(source)):
            raise ValueError(f"Output would overwrite the input: {path}")
        if path.exists() or path.is_symlink():
            raise ValueError(f"Output already exists; choose a fresh --output prefix: {path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", required=True, type=Path, help="Explicit output prefix, e.g. work/qa/scene1")
    parser.add_argument("--whisper-cli", type=Path, help="Existing whisper.cpp executable; otherwise try the local HyperFrames cache")
    parser.add_argument("--model-path", type=Path, help="Existing GGML model file; no model is downloaded")
    parser.add_argument("--model", choices=["small", "base"], default="small", help="Cached model to try when --model-path is omitted")
    parser.add_argument("--language", choices=["en", "ru"], default="ru", help="Spoken language; no expected-text prompt")
    parser.add_argument("--offset", type=float, default=0, help="Start in seconds; output timestamps are relative to this crop")
    parser.add_argument("--duration", type=float, help="Optional positive crop length in seconds")
    args = parser.parse_args()
    try:
        if not math.isfinite(args.offset) or args.offset < 0 or (
            args.duration is not None and (not math.isfinite(args.duration) or args.duration <= 0)
        ):
            raise ValueError("Offset must be finite and nonnegative; duration must be finite and positive")
        source = existing_file(args.input, "Input")
        prefix = args.output.expanduser().resolve()
        outputs = {suffix: Path(f"{prefix}.{suffix}") for suffix in ("wav", "txt", "srt", "json", "run.json")}
        check_outputs(outputs.values(), source)
        cache = Path.home() / ".cache/hyperframes/whisper"
        cli_candidate = args.whisper_cli or cache / "whisper.cpp/build/bin/whisper-cli"
        model_candidate = args.model_path or cache / f"models/ggml-{args.model}.bin"
        if not cli_candidate.expanduser().is_file():
            raise ValueError("whisper.cpp CLI not found. Supply an existing executable with --whisper-cli; nothing will be installed")
        if not model_candidate.expanduser().is_file():
            raise ValueError("Local model not found. Supply an existing GGML file with --model-path; nothing will be downloaded")
        cli = existing_file(cli_candidate, "whisper.cpp CLI")
        model = existing_file(model_candidate, "Model")
        if not os.access(cli, os.X_OK):
            raise ValueError(f"whisper.cpp CLI is not executable: {cli}")
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            raise ValueError("ffmpeg is not available; this script does not install it")
        prefix.parent.mkdir(parents=True, exist_ok=True)
        command = [ffmpeg, "-nostdin", "-v", "error", "-n", "-threads", "2", "-protocol_whitelist", "file,pipe", "-i", str(source), "-map", "0:a:0"]
        if args.offset:
            command += ["-ss", str(args.offset)]
        if args.duration is not None:
            command += ["-t", str(args.duration)]
        command += ["-vn", "-filter_threads", "1", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(outputs["wav"])]
        subprocess.run(command, check=True)
        command = [str(cli), "-m", str(model), "-f", str(outputs["wav"]), "-l", args.language, "-t", "2", "-p", "1", "-ng",
                   "-ojf", "-osrt", "-otxt", "-of", str(prefix)]
        environment = dict(os.environ, OMP_NUM_THREADS="2", OPENBLAS_NUM_THREADS="2")
        subprocess.run(command, env=environment, check=True)
        missing = [str(outputs[suffix]) for suffix in ("txt", "srt", "json") if not outputs[suffix].is_file()]
        if missing:
            raise ValueError("whisper.cpp did not produce expected outputs: " + ", ".join(missing))
        metadata = {
            "input": str(source), "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "tool": str(cli), "model": str(model), "language": args.language, "threads": 2,
            "offset_seconds": args.offset, "duration_seconds": args.duration,
            "initial_prompt": None, "transcript": str(outputs["txt"]),
            "caveat": "Local ASR only, not listening. Token probabilities are not calibrated accuracy; timestamps are approximate and relative to the crop.",
        }
        outputs["run.json"].write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return 0
    except subprocess.CalledProcessError as error:
        print(f"Error: {Path(error.cmd[0]).name} failed with exit code {error.returncode}. Partial outputs may remain; use a fresh --output prefix.", file=sys.stderr)
    except (OSError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
