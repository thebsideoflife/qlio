#!/usr/bin/env python3
"""Tracker-independent containment. For every sampled frame, define the subject PER FRAME (most
central face at least half the height of the biggest face in that frame, and >= 0.12 of frame
height) and test it against the window the job would write. Unlike eval.subject_exit this does not
reuse the policy's own tracks, so it sees fast movers and late entrances.

  python -m eval.frame_containment --job subject-v3.l2.0c4.0h
"""

from __future__ import annotations

import argparse
import bisect
import json
import os
from pathlib import Path

from shothold.geometry import window

CACHE = Path(os.environ.get("SHOTHOLD_CACHE", "/tmp/shothold"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    a = ap.parse_args()
    job = json.loads((CACHE / "job" / f"{a.job}.json").read_text())
    fr = {int(k): v for k, v in json.loads((CACHE / "faces.json").read_text())["frames"].items()}
    keys = sorted(fr)
    n = bad = 0
    thirds = [[0, 0], [0, 0], [0, 0]]
    bad_shots = {}
    for i, sh in job["shots"].items():
        x, y = sh["frames"]
        l, r = window(sh["zoom"], sh["focusX"])
        for f in keys[bisect.bisect_left(keys, x + 2):bisect.bisect_left(keys, y - 2)]:
            faces = [b for b in fr[f] if b[3] >= 0.12]
            if not faces:
                continue
            big = max(b[3] for b in faces)
            subj = min((b for b in faces if b[3] >= 0.5 * big), key=lambda b: abs(b[0] + b[2] / 2 - 0.5))
            out = max(0.0, l - subj[0]) + max(0.0, subj[0] + subj[2] - r)
            t = min(2, int(3 * (f - x) / max(1, y - x)))
            n += 1
            thirds[t][0] += 1
            if out > 0.25 * subj[2]:
                bad += 1
                thirds[t][1] += 1
                bad_shots[i] = bad_shots.get(i, 0) + 1
    print(f"{a.job}: frames with a subject {n}; subject >25% outside window {bad} ({100 * bad / n:.1f}%); "
          f"by third of shot: " + ", ".join(f"{100 * b / max(1, t):.1f}%" for t, b in thirds) +
          f"; shots with >=2 bad samples: {sum(v >= 2 for v in bad_shots.values())} of {len(job['shots'])}")


if __name__ == "__main__":
    main()
