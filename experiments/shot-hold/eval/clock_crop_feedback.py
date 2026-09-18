#!/usr/bin/env python3
"""Clock <-> crop cross-check, from caches only.

A. Framing says the clock MISSED a cut: inside one shot, between two consecutive face samples
   (6 frames apart) the dominant face teleports (centre-x jump AND size change) — people do not
   do that in 0.25 s, cameras do.
B. Framing says a cut is HARMLESS or FALSE: the face layout is the same on both sides, so the
   per-shot crops agree and the job layer writes no keyframe. Measures how forgiving the design
   is to clock false positives.
"""

from __future__ import annotations

import bisect
import json
import os
from pathlib import Path

from shothold.geometry import crop_iou

CACHE = Path(os.environ.get("SHOTHOLD_CACHE", "/tmp/shothold"))


def dom(faces):
    return max(faces, key=lambda f: f[2] * f[3]) if faces else None


def main() -> None:
    shots = json.loads((CACHE / "shots.json").read_text())
    cuts = shots["cuts"]
    fr = {int(k): v for k, v in json.loads((CACHE / "faces.json").read_text())["frames"].items()}
    keys = sorted(fr)
    other = set()
    for m in ("pyscene-adaptive", "pyscene-content", "ffscene-0.2"):
        other |= set(json.loads((CACHE / "clock" / f"{m}.json").read_text())["cuts"])
    other = sorted(other)

    teleports = []
    for a, b in zip(keys, keys[1:]):
        if bisect.bisect_right(cuts, a) != bisect.bisect_right(cuts, b):
            continue  # a known cut sits between the samples
        da, db = dom(fr[a]), dom(fr[b])
        if not da or not db or da[3] < 0.12 or db[3] < 0.12:
            continue
        dx = abs((da[0] + da[2] / 2) - (db[0] + db[2] / 2))
        ratio = max(da[3], db[3]) / min(da[3], db[3])
        def has_match(face, pool):  # same person still present on the other side?
            return any(abs((g[0] + g[2] / 2) - (face[0] + face[2] / 2)) < 0.08 and max(g[3], face[3]) / min(g[3], face[3]) < 1.3 for g in pool)
        if dx > 0.2 and ratio > 1.35 and not has_match(da, fr[b]) and not has_match(db, fr[a]):
            j = bisect.bisect_left(other, a)
            backed = j < len(other) and other[j] <= b + 2
            teleports.append({"between": [a, b], "dx": round(dx, 3), "size_ratio": round(ratio, 2), "other_detector_agrees": backed})

    c = json.loads((CACHE / "crops" / "subject-v2.json").read_text())["shots"]
    same = sum(1 for i in range(1, len(cuts) + 1)
               if crop_iou((c[str(i - 1)]["zoom"], c[str(i - 1)]["focusX"]), (c[str(i)]["zoom"], c[str(i)]["focusX"])) >= 0.9)
    susp = shots.get("suspicious", [])
    susp_frames = [s if isinstance(s, int) else s.get("frame", s[0] if isinstance(s, list) else None) for s in susp]
    susp_same = 0
    for f in susp_frames:
        if f in cuts:
            i = cuts.index(f) + 1
            susp_same += crop_iou((c[str(i - 1)]["zoom"], c[str(i - 1)]["focusX"]), (c[str(i)]["zoom"], c[str(i)]["focusX"])) >= 0.9
    out = {"teleports_inside_shots": len(teleports), "teleports_backed_by_other_detector": sum(t["other_detector_agrees"] for t in teleports),
           "teleports": teleports[:40], "cuts_total": len(cuts), "cuts_where_crop_unchanged": same,
           "suspicious_cuts": len(susp_frames), "suspicious_cuts_where_crop_unchanged": int(susp_same)}
    (CACHE / "eval").mkdir(exist_ok=True)
    (CACHE / "eval" / "clock_crop_feedback.json").write_text(json.dumps(out, indent=1))
    print({k: v for k, v in out.items() if k != "teleports"})
    for t in teleports[:12]:
        print(t)


if __name__ == "__main__":
    main()
