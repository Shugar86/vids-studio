#!/usr/bin/env python3
"""Blind English/Russian ASR of an export or a take with an existing whisper.cpp, then optional script diff.

Transcribes first, with no prompt and no expected text; the script is only read afterwards for a
mechanical word diff (audio tags like [пауза] are ignored). Installs and downloads nothing, sends
nothing anywhere. ASR is not listening: it can smooth over extra syllables, odd intonation and
mispronunciations.

Outputs under --out PREFIX: .wav, .txt, .json (whisper), .srt (caption-length lines, times shifted by
--offset to the file timeline), .words.json (approximate per-word times for timing animations to
words) and .report.json.
"""
import argparse
import difflib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

CACHE = Path.home() / ".cache/hyperframes/whisper"


def words(text):
    text = re.sub(r"\[[^\]]*\]", " ", text)   # audio tags of Vids avatar scripts are not spoken words
    return re.sub(r"[^0-9a-zа-я]+", " ", text.lower().replace("ё", "е")).split()


def srt_time(seconds):
    ms = max(0, round(seconds * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", type=Path)
    parser.add_argument("--out", required=True, type=Path, help="Fresh output prefix, e.g. $WORK/qa/v2-asr")
    parser.add_argument("--model", default="small", help="small | base | path to an existing GGML model")
    parser.add_argument("--whisper-cli", type=Path, default=CACHE / "whisper.cpp/build/bin/whisper-cli")
    parser.add_argument("--language", choices=["en", "ru"], default="ru", help="Spoken language; no expected-text prompt")
    parser.add_argument("--offset", type=float, default=0.0, help="Start, seconds")
    parser.add_argument("--duration", type=float, help="Length, seconds")
    parser.add_argument("--compare", type=Path, help="Plain-text script, read only after transcription")
    parser.add_argument("--caption-chars", type=int, default=42, help="Max characters per subtitle line (0 = sentence segments)")
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()

    source = args.input.expanduser().resolve(strict=True)
    model = Path(args.model).expanduser()
    if not model.is_file():
        model = CACHE / f"models/ggml-{args.model}.bin"
    for path, what in ((args.whisper_cli, "whisper.cpp CLI"), (model, "model")):
        if not path.is_file():
            raise ValueError(f"{what} not found at {path}; pass an existing one — nothing is installed")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise ValueError("ffmpeg is not available")
    prefix = args.out.expanduser().resolve()
    names = ("wav", "txt", "srt", "json", "words.json", "report.json")
    out = {n: Path(f"{prefix}.{n}") for n in names}
    if any(p.exists() for p in out.values()):
        raise ValueError(f"Outputs for prefix {prefix} already exist; choose a fresh --out")
    prefix.parent.mkdir(parents=True, exist_ok=True)

    cut = ["-ss", str(args.offset)] + (["-t", str(args.duration)] if args.duration else [])
    subprocess.run([ffmpeg, "-nostdin", "-v", "error", "-threads", "2", "-protocol_whitelist", "file,pipe", "-i", str(source), *cut, "-map", "0:a:0",
                    "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(out["wav"])], check=True)
    split = ["-ml", str(args.caption_chars), "-sow"] if args.caption_chars > 0 else []
    subprocess.run([str(args.whisper_cli), "-m", str(model), "-f", str(out["wav"]), "-l", args.language,
                    "-t", str(args.threads), "-p", "1", "-ng", *split, "-ojf", "-otxt", "-of", str(prefix)],
                   check=True, capture_output=True)

    segments = json.loads(out["json"].read_text(encoding="utf-8"))["transcription"]
    # Per-word times from tokens: a token starting with a space opens a word. Approximate (±0.3 s).
    timed = []
    for seg in segments:
        for tok in seg.get("tokens", []):
            text = tok["text"]
            if text.startswith("[_") or not text.strip():
                continue
            a = tok["offsets"]["from"] / 1000 + args.offset
            b = tok["offsets"]["to"] / 1000 + args.offset
            if text.startswith(" ") or not timed:
                timed.append({"word": text.strip(), "start": round(a, 2), "end": round(b, 2)})
            else:
                timed[-1]["word"] += text
                timed[-1]["end"] = round(b, 2)
    out["words.json"].write_text(json.dumps(timed, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    lines = []
    for n, seg in enumerate((s for s in segments if s["text"].strip()), 1):
        a = seg["offsets"]["from"] / 1000 + args.offset
        b = seg["offsets"]["to"] / 1000 + args.offset
        lines += [str(n), f"{srt_time(a)} --> {srt_time(b)}", seg["text"].strip(), ""]
    out["srt"].write_text("\n".join(lines), encoding="utf-8")

    heard = [w for item in timed for w in words(item["word"])]
    spoken = [item for item in timed if words(item["word"])]
    transcript = " ".join(seg["text"].strip() for seg in segments).strip()
    span = (spoken[-1]["end"] - spoken[0]["start"]) if spoken else 0
    report = {
        "input": str(source), "model": str(model), "offset": args.offset, "duration": args.duration,
        "prompt": None, "transcript": transcript, "words": len(heard),
        "words_per_second": round(len(heard) / span, 2) if span else None,
        "caveat": "Blind ASR, not listening. Word and line timings are approximate.",
    }
    print(f"Распознано ({len(heard)} слов, ≈{report['words_per_second']} сл/с):\n{transcript}\n")

    if args.compare:
        expected = words(args.compare.read_text(encoding="utf-8"))
        times = [item["start"] for item in timed for _ in words(item["word"])]
        diffs = []
        matcher = difflib.SequenceMatcher(None, heard, expected, autojunk=False)
        for op, i1, i2, j1, j2 in matcher.get_opcodes():
            if op != "equal":
                at = times[min(i1, len(times) - 1)] if times else 0
                diffs.append({"op": op, "about_seconds": at, "heard": " ".join(heard[i1:i2]), "script": " ".join(expected[j1:j2])})
        matched = sum(b.size for b in matcher.get_matching_blocks())
        report["compare"] = {"script_words": len(expected), "matched": matched, "differences": diffs}
        print(f"Совпало {matched}/{len(expected)} слов сценария.")
        for d in diffs:
            print(f"  ≈{d['about_seconds']} с · {d['op']}: услышано «{d['heard']}» / в сценарии «{d['script']}»")
        if diffs:
            print("Каждое расхождение проверь кадрами и, если сомневаешься, вторым прогоном (--model base) на коротком фрагменте.")
    out["report.json"].write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as error:
        print(f"Error: {Path(error.cmd[0]).name} failed ({error.returncode}); use a fresh --out", file=sys.stderr)
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"Error: {error}", file=sys.stderr)
    raise SystemExit(1)
