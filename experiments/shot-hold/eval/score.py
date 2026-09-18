#!/usr/bin/env python3
"""Automatic (no-human) scorecard. Runs the job layer over the 26 stored segments,
read-only, and prints what can be measured without eyes:

  density      holds per segment vs the stored Nashville track (351) and vs raw camera cuts
  smoothness   median / p10 hold length, holds under 1 s
  policy mix   TIGHT / widened / no-face share by time
  containment  share of sampled frames where the chosen subject's face box sits inside the window
  reference    1-D crop IoU vs the stored crop at 1 fps (a reference, NOT truth: the stored
               track is what Lionsgate called choppy)

  python -m eval.score [--min-hold 12] [--same-iou 0.9]
"""

from __future__ import annotations

import argparse
import bisect
import json
import os
import statistics as st
from pathlib import Path

from shothold.geometry import crop_iou, window
from shothold.job import frame_index, keyframes_for_segment

CACHE = Path(os.environ.get("SHOTHOLD_CACHE", "/tmp/shothold"))
GOLD = Path(os.environ.get("SHOTHOLD_GOLD", "/tmp/nashville-gold.json"))


def hold_at(kfs: list[dict], t: float) -> dict | None:
    cur = None
    for k in kfs:
        if k["time"] <= t + 1e-6:
            cur = k
    return cur


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-hold", type=int, default=12)
    ap.add_argument("--same-iou", type=float, default=0.9)
    ap.add_argument("--hold-through", action="store_true")
    ap.add_argument("--zoom-lambda", type=float, default=None)
    ap.add_argument("--loose-cost", type=float, default=1.0)
    ap.add_argument("--json", default=str(CACHE / "eval" / "scorecard.json"))
    a = ap.parse_args()

    shots = json.loads((CACHE / "shots.json").read_text())
    fps, cuts = shots["fps"], shots["cuts"]
    faces = {int(k): v for k, v in json.loads((CACHE / "faces.json").read_text())["frames"].items()}
    fkeys = sorted(faces)
    segs = json.loads(GOLD.read_text())["segments"]
    card = {"params": vars(a), "clock": shots["method"], "methods": {}, "segments": []}

    for path in sorted((CACHE / "crops").glob("*.json")):
        c = json.loads(path.read_text())
        crops = {int(i): (s["zoom"], s["focusX"]) for i, s in c["shots"].items()}
        subj = {int(i): s.get("subject_cx") for i, s in c["shots"].items()}
        needs = {int(i): tuple(s["need"]) for i, s in c["shots"].items() if s.get("need")}
        zoom_changes = 0
        clipped_s = 0.0
        holds, lens, ious, zt = 0, [], [], {"tight": 0.0, "widened": 0.0}
        inside = total = 0
        per_seg = []
        for s in segs:
            kfs = keyframes_for_segment(s["startTime"], s["endTime"], fps, cuts, crops,
                                        min_hold_frames=a.min_hold, same_crop_iou=a.same_iou,
                                        needs=needs, hold_through=a.hold_through, zoom_lambda=a.zoom_lambda, loose_cost=a.loose_cost)
            per_seg.append(len(kfs))
            sb = [f0_ for f0_ in [frame_index(s["startTime"], fps)]] + [x for x in cuts if frame_index(s["startTime"], fps) < x < frame_index(s["endTime"], fps)] + [frame_index(s["endTime"], fps)]
            for x, y in zip(sb, sb[1:]):
                nd = needs.get(bisect.bisect_right(cuts, x)); h = hold_at(kfs, x / fps - s["startTime"] + 1e-3)
                if nd and h:
                    l_, r_ = window(h["zoom"], h["focusX"])
                    if nd[0] < l_ - 0.01 or nd[1] > r_ + 0.01:
                        clipped_s += (y - x) / fps
            zoom_changes += sum(abs(x["zoom"] - y["zoom"]) > 0.02 for x, y in zip(kfs, kfs[1:]))
            holds += len(kfs)
            dur = s["endTime"] - s["startTime"]
            times = [k["time"] for k in kfs] + [dur]
            for k, (t0, t1) in zip(kfs, zip(times, times[1:])):
                lens.append(t1 - t0)
                zt["tight" if k["zoom"] >= 0.95 else "widened"] += t1 - t0
            gk = [k for k in (s.get("keyframes") or []) if k.get("zoom") is not None]
            t = 0.5
            while t < dur:
                h, g = hold_at(kfs, t), hold_at(gk, t)
                if h and g:
                    ious.append(crop_iou((h["zoom"], h["focusX"]), (g["zoom"], g["focusX"])))
                t += 1.0
            # containment of the policy's own subject on cached face samples
            f0, f1 = frame_index(s["startTime"], fps), frame_index(s["endTime"], fps)
            for f in fkeys[bisect.bisect_left(fkeys, f0):bisect.bisect_left(fkeys, f1)]:
                sh = bisect.bisect_right(cuts, f)
                cx = subj.get(sh)
                h = hold_at(kfs, f / fps - s["startTime"])
                if cx is None or h is None or not faces[f]:
                    continue
                face = min(faces[f], key=lambda b: abs(b[0] + b[2] / 2 - cx))
                if abs(face[0] + face[2] / 2 - cx) > 0.1:
                    continue
                l, r = window(h["zoom"], h["focusX"])
                total += 1
                inside += face[0] >= l - 0.005 and face[0] + face[2] <= r + 0.005
        tt = sum(zt.values()) or 1
        card["methods"][c["method"]] = {
            "holds": holds, "zoom_changes": zoom_changes, "subject_clipped_s": round(clipped_s, 1), "per_segment": per_seg,
            "median_hold_s": round(st.median(lens), 2), "p10_hold_s": round(sorted(lens)[len(lens) // 10], 2),
            "holds_under_1s": sum(x < 1 for x in lens),
            "tight_time_pct": round(100 * zt["tight"] / tt, 1),
            "subject_inside_pct": round(100 * inside / total, 1) if total else None,
            "iou_vs_stored_mean": round(st.mean(ious), 3) if ious else None,
        }

    gold_holds = [len(s.get("keyframes") or []) for s in segs]
    raw_cuts = [sum(1 for x in cuts if frame_index(s["startTime"], fps) < x < frame_index(s["endTime"], fps)) + 1 for s in segs]
    gl = []
    for s in segs:
        ts = [k["time"] for k in (s.get("keyframes") or [])] + [s["endTime"] - s["startTime"]]
        gl += [b - x for x, b in zip(ts, ts[1:])]
    card["stored"] = {"holds": sum(gold_holds), "median_hold_s": round(st.median(gl), 2),
                      "p10_hold_s": round(sorted(gl)[len(gl) // 10], 2), "holds_under_1s": sum(x < 1 for x in gl)}
    card["raw_shots_in_segments"] = sum(raw_cuts)
    for i, s in enumerate(segs):
        card["segments"].append({"id": s["id"], "title": s["title"], "dur": round(s["endTime"] - s["startTime"], 1),
                                 "stored": gold_holds[i], "shots": raw_cuts[i],
                                 **{m: v["per_segment"][i] for m, v in card["methods"].items()}})
    Path(a.json).parent.mkdir(parents=True, exist_ok=True)
    Path(a.json).write_text(json.dumps(card, indent=1))

    print(f"stored Nashville track: {card['stored']}")
    print(f"camera shots inside the 26 segments ({shots['method']}): {card['raw_shots_in_segments']}")
    for m, v in card["methods"].items():
        print(f"{m:18s}", {k: x for k, x in v.items() if k != "per_segment"})


if __name__ == "__main__":
    main()
