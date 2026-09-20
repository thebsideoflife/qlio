#!/usr/bin/env python3
"""One line per written job: what the viewer would see. Reads $CACHE/job/*.json only.

  python -m eval.job_summary [job_id ...]

holds          keyframes written (incl. segment opens)
zoom chg       interior keyframes that change zoom (the letterbox moves)
mid-shot       interior keyframes on an exit split rather than a camera cut (pan only, by construction)
<1 s           holds shorter than one second
9:16           share of framed time at zoom 1
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

CACHE = Path(os.environ.get("SHOTHOLD_CACHE", "/tmp/shothold"))


def summary(job: dict) -> dict:
    fps = job["fps"]
    split = {s["frames"][0] for s in job["shots"].values() if s.get("split")}
    holds = zc = mid = short = 0
    tight = total = 0.0
    for seg in job["segments"]:
        k = seg["keyframes"]
        dur = seg["endTime"] - seg["startTime"]
        holds += len(k)
        for a, b in zip(k, k[1:] + [None]):
            end = b["time"] if b else dur
            short += end - a["time"] < 1.0
            total += end - a["time"]
            tight += (end - a["time"]) * (a["zoom"] >= 0.95)
        for a, b in zip(k, k[1:]):
            zc += abs(a["zoom"] - b["zoom"]) > 0.02
            mid += b["sourceFrame"] in split
            assert not (b["sourceFrame"] in split and abs(a["zoom"] - b["zoom"]) > 0.02), "letterbox moved mid-shot"
    return {"holds": holds, "zoom_changes": zc, "mid_shot": mid, "under_1s": short, "tight_share": round(tight / total, 3)}


def main() -> None:
    ids = sys.argv[1:] or sorted(p.stem for p in (CACHE / "job").glob("*.json"))
    print(f"{'job':40s} {'holds':>6s} {'zoom chg':>9s} {'mid-shot':>9s} {'<1 s':>5s} {'9:16':>6s}")
    for j in ids:
        s = summary(json.loads((CACHE / "job" / f"{j}.json").read_text()))
        print(f"{j:40s} {s['holds']:6d} {s['zoom_changes']:9d} {s['mid_shot']:9d} {s['under_1s']:5d} {100 * s['tight_share']:5.0f}%")


if __name__ == "__main__":
    main()
