#!/usr/bin/env python3
"""Score any clock against the human cut labels (prove-gate for the clock layer).

  python -m eval.clock_labels

Reading of the cut cards (checked on the stills, 18 Sep): the reviewer answered "is this a cut?" on
every card, including miss-candidate and missed-by-ours cards whose card text said Approve = "the
clock is right that there is NO cut". Evidence: 16243 is an unmistakable cut and was Approved;
869 / 7546 / 21046 / 47965 are one continuous shot and were Denied; 52720 / 53051 / 59687 are
lightning or photo flashes and were Denied. So truth = (verdict == approve) on every cut card.
13710 is excluded: all four stills are blank white, nothing to judge.
Dissolve cards: Approve = two different setups = a (soft) cut.
Extra truth from crop-card notes, confirmed by eye: 3830 is a whip-blur cut inside a held shot.

Gate: every true hard cut within +-2 frames, no false one within +-2; dissolves within +-16.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np

CACHE = Path(os.environ.get("SHOTHOLD_CACHE", "/tmp/shothold"))
LABELS = Path(__file__).resolve().parent.parent / "labels" / "labels.jsonl"
EXCLUDE = {13710}
EXTRA = [(3830, True, "hard", "crop note 3806-3887: whip-blur cut")]
CLOCKS = {
    "hist-adaptive-v1": "clock/hist-adaptive-v1.json",
    "hist-adaptive-v2": "clock/v2/hist-adaptive-v2.json",
    "union-v1": "clock/v2/union-v1.json",
    "clock-v3": "clock/v3/clock-v3.json",
}


def truth() -> list[tuple[int, bool, str, str]]:
    last = {}
    for line in LABELS.read_text().splitlines():
        if line.strip():
            r = json.loads(line)
            last[r["card_id"]] = r
    out = []
    for r in last.values():
        if r["kind"] != "cut" or r["verdict"] == "skip":
            continue
        f = r["proposal"]["cut_frame"]
        if f in EXCLUDE:
            continue
        cat = r["context"]["category"]
        out.append((f, r["verdict"] == "approve", "soft" if cat == "dissolve" else "hard", cat))
    return sorted(out + EXTRA)


def score(cuts: np.ndarray, gold) -> dict:
    res = {"tp": [], "fn": [], "fp": [], "tn": []}
    for f, is_cut, kind, cat in gold:
        tol = 16 if kind == "soft" else 2
        hit = len(cuts) and np.abs(cuts - f).min() <= tol
        res[("tp" if hit else "fn") if is_cut else ("fp" if hit else "tn")].append(f)
    return res


def main() -> None:
    gold = truth()
    print(f"{len(gold)} labelled points: {sum(g[1] for g in gold)} cuts, {sum(not g[1] for g in gold)} not cuts\n")
    for name, rel in CLOCKS.items():
        p = CACHE / rel
        if not p.exists():
            continue
        d = json.loads(p.read_text())
        s = score(np.array(d["cuts"]), gold)
        print(f"{name:18s} cuts={len(d['cuts']):4d}  real found {len(s['tp'])}/{len(s['tp']) + len(s['fn'])}"
              f"  false kept {len(s['fp'])}/{len(s['fp']) + len(s['tn'])}   missed={s['fn']}  false={s['fp']}")


if __name__ == "__main__":
    main()
