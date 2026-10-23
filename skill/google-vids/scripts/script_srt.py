#!/usr/bin/env python3
"""Build candidate SRT from script text and blind ASR word timings.

Alignment can insert expected words the recognizer did not hear. This output is
not evidence of actual speech: resolve discrepancies against audio before use.
--shift adjusts candidate cue times after a known edit; verify the final export.
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
from pathlib import Path

END = re.compile(r"[.?!…]$|—$")
SOFT = re.compile(r"[,:;]$")
WEAK = {"что", "как", "это", "для", "над", "под", "при", "про", "без", "или", "так", "the", "and"}
ENCLITIC = {"ли", "же", "бы", "ж", "б", "то"}  # не начинают строку


def norm(word: str) -> str:
    return re.sub(r"[^\wё]", "", word.lower().replace("ё", "е"))


def timestamp(t: float) -> str:
    ms = max(0, round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def align(script: list[str], heard: list[dict]) -> list[tuple[float, float]]:
    """Время для каждого слова сценария; заменённые и вставленные куски делятся пропорционально."""
    a = [norm(w) for w in script]
    b = [norm(w["word"]) for w in heard]
    times: list[tuple[float, float] | None] = [None] * len(script)
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes():
        if op == "equal":
            for k in range(i2 - i1):
                times[i1 + k] = (heard[j1 + k]["start"], heard[j1 + k]["end"])
        elif op == "replace":  # «insert» — лишние слова ASR, их время не нужно
            t0, t1 = heard[j1]["start"], heard[j2 - 1]["end"]
            n = i2 - i1
            for k in range(n):
                times[i1 + k] = (t0 + (t1 - t0) * k / n, t0 + (t1 - t0) * (k + 1) / n)
    # слова сценария, которых ASR не услышал, получают время соседей
    for i, t in enumerate(times):
        if t is None:
            prev = next((times[j] for j in range(i - 1, -1, -1) if times[j]), None)
            nxt = next((times[j] for j in range(i + 1, len(times)) if times[j]), None)
            edge = prev[1] if prev else (nxt[0] if nxt else 0.0)
            times[i] = (edge, edge)
    return times  # type: ignore[return-value]


def cues(script: list[str], times: list[tuple[float, float]], max_chars: int) -> list[tuple[float, float, str]]:
    """Фраза (до . ? ! —) — одна реплика; длинная делится на равные по длине части, лучше после запятой."""
    phrases, cur = [], []
    for i, word in enumerate(script):
        cur.append(i)
        if END.search(word):
            phrases.append(cur)
            cur = []
    if cur:
        phrases.append(cur)
    def text(idx: list[int]) -> str:
        return " ".join(script[k] for k in idx)

    def split(idx: list[int]) -> list[list[int]]:
        # лучший разрез: части ровнее, после запятой лучше, после предлога или союза — нельзя
        if len(text(idx)) <= max_chars or len(idx) < 2:
            return [idx]
        best, cost = 1, float("inf")
        for k in range(1, len(idx)):
            left, right = text(idx[:k]), text(idx[k:])
            parts = -(-len(left) // max_chars) - (-len(right) // max_chars)
            c = parts * 100 + max(len(left), len(right)) - (8 if SOFT.search(script[idx[k - 1]]) else 0)
            if len(norm(script[idx[k - 1]])) <= 2 or norm(script[idx[k - 1]]) in WEAK:
                c += 1000
            if norm(script[idx[k]]) in ENCLITIC:
                c += 1000
            elif len(norm(script[idx[k]])) <= 2 or norm(script[idx[k]]) in WEAK:
                c -= 4  # перенос перед предлогом читается естественно
            if left.count("«") > left.count("»"):
                c += 60  # не разрывать цитату, если есть другой разрез
            if c < cost:
                best, cost = k, c
        return split(idx[:best]) + split(idx[best:])

    out = []
    for idx in phrases:
        for part in split(idx):
            out.append((times[part[0]][0], times[part[-1]][1], text(part)))
    return [(a, b, x) for a, b, x in out if x.strip(" —")]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("words", type=Path, help="*.words.json из asr_blind.py")
    ap.add_argument("script", type=Path, help="сценарий, тот же текст, что озвучен")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--max-chars", type=int, default=30)
    ap.add_argument("--hold", type=float, default=0.25, help="сколько реплика держится после последнего слова, с")
    ap.add_argument("--min", type=float, default=0.8, help="минимальная длительность реплики, с")
    ap.add_argument("--shift", action="append", default=[], help="T:+D — сдвинуть реплики после T на D секунд")
    args = ap.parse_args()

    heard = json.loads(args.words.read_text())
    text = re.sub(r"\[[^\]]*\]", " ", args.script.read_text())  # теги голоса вроде [pause] не показываем
    script = text.split()
    if not heard or not script:
        sys.exit("пустой сценарий или ASR")
    times = align(script, heard)
    lines = cues(script, times, args.max_chars)
    # Короткую реплику вроде «Так.» не успеть прочитать: склеиваем со следующей, если влезает.
    merged = []
    for a, b, x in lines:
        if merged:
            pa, pb, px = merged[-1]
            if pb - pa < 0.7 and len(px) <= 10 and len(px) + 1 + len(x) <= int(args.max_chars * 1.4):
                merged[-1] = (pa, b, f"{px} {x}")
                continue
        merged.append((a, b, x))
    lines = merged

    shifts = []
    for s in args.shift:
        t, d = s.split(":")
        shifts.append((float(t), float(d)))
    lines = [(a + sum(d for t, d in shifts if a >= t), b + sum(d for t, d in shifts if a >= t), x) for a, b, x in lines]

    blocks = []
    for k, (a, b, x) in enumerate(lines):
        nxt = lines[k + 1][0] if k + 1 < len(lines) else None
        end = max(b + args.hold, a + args.min)
        if nxt is not None:
            end = min(end, nxt - 0.02)
        blocks.append(f"{k + 1}\n{timestamp(a)} --> {timestamp(end)}\n{x.strip(' —')}\n")
    args.out.write_text("\n".join(blocks))
    print(f"{len(blocks)} реплик → {args.out}")
    for b in blocks:
        print(b)


if __name__ == "__main__":
    main()
