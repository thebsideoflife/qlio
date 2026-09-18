#!/usr/bin/env python3
"""Long-dissolve detector (features only). The hard-cut detector's gradual rule looks 16 frames
across; a 40-frame cross-dissolve slips through and leaves two setups in one "shot" (found by eye
in Nashville shot 59135-59355). Signature that separates a dissolve from a pan or a walk-through:

    stable picture A  ->  smooth change  ->  stable picture B,   A and B unrelated

  python clock/dissolve.py            # prints candidates, writes $CACHE/clock/dissolves.json
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np

CACHE = Path(os.environ.get("SHOTHOLD_CACHE", "/tmp/shothold"))
P = {"half": 24, "side": 12, "min_dx": 25.0, "max_ncc": 0.4, "max_side_dx": 9.0, "max_step": 12.0, "guard": 4}


def ncc(a: np.ndarray, b: np.ndarray) -> float:
    a = a - a.mean(); b = b - b.mean()
    return float((a * b).sum() / (np.sqrt((a * a).sum() * (b * b).sum()) + 1e-6))


def main() -> None:
    z = np.load(CACHE / "clock" / "features.npz")
    th = z["thumbs"].astype(np.float32)
    mad = z["mad"]
    cuts = np.array(json.loads((CACHE / "shots.json").read_text())["cuts"])
    n, h, s = len(th), P["half"], P["side"]
    cand = []
    for i in range(h + s, n - h - s):
        lo, hi = i - h, i + h
        if ((cuts > lo - s - P["guard"]) & (cuts < hi + s + P["guard"])).any():
            continue  # a hard cut nearby explains the change
        if mad[lo:hi].max() > P["max_step"]:
            continue  # not smooth
        a0, a1 = th[lo - s:lo - s + 4].mean(0), th[lo - 4:lo].mean(0)
        b0, b1 = th[hi:hi + 4].mean(0), th[hi + s - 4:hi + s].mean(0)
        if np.abs(a0 - a1).mean() > P["max_side_dx"] or np.abs(b0 - b1).mean() > P["max_side_dx"]:
            continue  # sides not stable: camera move, not a dissolve
        dx = float(np.abs(a1 - b0).mean())
        c = ncc(a1, b0)
        if dx >= P["min_dx"] and c <= P["max_ncc"]:
            cand.append((i, dx, c))
    # one per run of consecutive frames: the middle
    out, run = [], []
    for i, dx, c in cand:
        if run and i - run[-1][0] > 1:
            out.append(run[len(run) // 2]); run = []
        run.append((i, dx, c))
    if run:
        out.append(run[len(run) // 2])
    # Framing informs the clock: if the same face (place and size) is there before and after, the
    # picture did not change setup; it was an occluder or a drift. Needs faces.json; skipped without it.
    fpath = CACHE / "faces.json"
    if fpath.exists():
        fr = {int(k): v for k, v in json.loads(fpath.read_text())["frames"].items()}
        keys = np.array(sorted(fr))

        def faces_at(f):
            return [b for b in fr[int(keys[np.abs(keys - f).argmin()])] if b[3] >= 0.1]

        def same_face(i):
            A, B = faces_at(i - h - 2), faces_at(i + h + 2)
            return any(abs((a[0] + a[2] / 2) - (b[0] + b[2] / 2)) < 0.12 and max(a[3], b[3]) / min(a[3], b[3]) < 1.4 for a in A for b in B)

        rejected = [o for o in out if same_face(o[0])]
        out = [o for o in out if not same_face(o[0])]
        print("rejected because the same face persists:", [r[0] for r in rejected])
    res = [{"frame": int(i), "dx": round(dx, 1), "ncc": round(c, 2)} for i, dx, c in out]
    (CACHE / "clock" / "dissolves.json").write_text(json.dumps({"method": "long-dissolve-v1", "params": P, "dissolves": res}, indent=1))
    print(len(res), "long dissolves:", res)


if __name__ == "__main__":
    main()
