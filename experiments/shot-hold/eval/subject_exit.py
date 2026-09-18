#!/usr/bin/env python3
"""Does a constant per-shot hold actually keep the subject? (spec open question 3)

Follows the policy's own subject TRACK through each shot (not "nearest face to a fixed x", which
hides travel) and tests every sampled face box against the window the job would write.

  python -m eval.subject_exit --job subject-v3.l2.0c4.0h --crops subject-v3
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
    ap.add_argument("--central", action="store_true", default=True)
    a = ap.parse_args()
    job = json.loads((CACHE / "job" / f"{a.job}.json").read_text())
    fps = job["fps"]
    fr = {int(k): v for k, v in json.loads((CACHE / "faces.json").read_text())["frames"].items()}
    keys = sorted(fr)
    p = PARAMS
    n_s = cut_s = bad_s = 0
    shots_with_subject = exit_shots = 0
    where = {"open third": 0, "middle": 0, "close third": 0}
    sev = []
    exit_secs = 0.0
    worst = []
    for i, sh in job["shots"].items():
        x, y = sh["frames"]
        smp = [(f, fr[f]) for f in keys[bisect.bisect_left(keys, x + 2):bisect.bisect_left(keys, y - 2)]]
        tracks = build_tracks(smp, p)
        if not tracks:
            continue
        big = max(t["h"] for t in tracks)
        tracks = sorted(tracks, key=lambda t: (t["h"] < p["central_min_h_ratio"] * big, abs(t["cx"] - 0.5)))
        top = tracks[0]
        l, r = window(sh["zoom"], sh["focusX"])
        shots_with_subject += 1
        shot_bad = 0
        for f, bl, br in top["boxes"]:
            n_s += 1
            w = br - bl
            out = max(0.0, l - bl) + max(0.0, br - r)
            if out > 0.005:
                cut_s += 1
            if out > 0.25 * w:  # more than a quarter of the face is outside: a visible failure
                bad_s += 1
                shot_bad += 1
                pos = (f - x) / max(1, y - x)
                where["open third" if pos < 1 / 3 else "close third" if pos > 2 / 3 else "middle"] += 1
                sev.append(out / w)
        if shot_bad:
            exit_shots += 1
            exit_secs += shot_bad * 6 / fps
            worst.append((shot_bad * 6 / fps, int(i), sh["zoom"], sh["reason"][:60]))
    print(f"subject-track samples: {n_s};  face touched by window edge: {100 * cut_s / n_s:.1f}%;  "
          f">25% of face outside: {100 * bad_s / n_s:.1f}%")
    print(f"shots with a subject: {shots_with_subject};  shots where the subject visibly exits at some point: "
          f"{exit_shots} ({100 * exit_shots / shots_with_subject:.1f}%), about {exit_secs:.0f} s of screen time")
    print("where in the shot the exits happen:", where)
    worst.sort(reverse=True)
    print("worst shots (sec outside, shot, zoom, reason):")
    for w in worst[:10]:
        print("  ", round(w[0], 1), w[1], w[2], w[3])
    (CACHE / "eval").mkdir(exist_ok=True)
    (CACHE / "eval" / f"subject_exit__{a.job}.json").write_text(json.dumps(
        {"samples": n_s, "edge_touch_pct": 100 * cut_s / n_s, "visible_exit_pct": 100 * bad_s / n_s,
         "shots": shots_with_subject, "exit_shots": exit_shots, "exit_secs": exit_secs, "where": where,
         "worst": worst[:40]}, indent=1))


if __name__ == "__main__":
    main()
