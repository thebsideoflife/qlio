#!/usr/bin/env python3
"""Flag shots where a constant hold is most likely to fail: subject-sized faces that the tracker
dropped (fast movers, camera pans, late entrances) and that fall outside the held window.
Writes $CACHE/eval/risky_shots__<job>.json = {shotIndex: samples_outside}.

  python -m eval.risky_holds --job subject-v3.l2.0c4.0h
"""

from __future__ import annotations

import argparse
import bisect
import json
import os
from pathlib import Path

from crop.policy import PARAMS, build_tracks
from shothold.geometry import window

CACHE = Path(os.environ.get("SHOTHOLD_CACHE", "/tmp/shothold"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    a = ap.parse_args()
    job = json.loads((CACHE / "job" / f"{a.job}.json").read_text())
    fr = {int(k): v for k, v in json.loads((CACHE / "faces.json").read_text())["frames"].items()}
    keys = sorted(fr)
    risky, total = {}, 0
    for i, sh in job["shots"].items():
        x, y = sh["frames"]
        smp = [(f, fr[f]) for f in keys[bisect.bisect_left(keys, x + 2):bisect.bisect_left(keys, y - 2)]]
        tracks = build_tracks(smp, PARAMS)
        kept = {(f, round(l, 4)) for t in tracks for f, l, _ in t["boxes"]}
        big = max((t["h"] for t in tracks), default=0.0)
        l, r = window(sh["zoom"], sh["focusX"])
        n = 0
        for f, faces in smp:
            for b in faces:
                if b[3] < max(0.12, 0.6 * big) or (f, round(b[0], 4)) in kept:
                    continue
                n += b[0] < l - 0.25 * b[2] or b[0] + b[2] > r + 0.25 * b[2]
        total += 1
        if n >= 2:
            risky[i] = n
    out = CACHE / "eval" / f"risky_shots__{a.job}.json"
    out.write_text(json.dumps(risky))
    print(f"{len(risky)} of {total} shots flagged ({100 * len(risky) / total:.1f}%) -> {out}")


if __name__ == "__main__":
    main()
