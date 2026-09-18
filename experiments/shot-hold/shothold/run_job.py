#!/usr/bin/env python3
"""Run the job layer over stored segments, READ-ONLY, and write proposed keyframes to the cache.

  python -m shothold.run_job --crops subject-v2 --zoom-lambda 2 --loose-cost 4 --hold-through

Output $CACHE/job/<job_id>.json:
  segments[]   {id, title, startTime, endTime (copied, never changed), keyframes[] in the persisted shape}
  shots{}      final crop per camera shot after smoothing, for the review UI
Nothing is written to DynamoDB or S3.
"""

from __future__ import annotations

import argparse
import bisect
import json
import os
from pathlib import Path

from .job import frame_index, keyframes_for_segment

CACHE = Path(os.environ.get("SHOTHOLD_CACHE", "/tmp/shothold"))
GOLD = Path(os.environ.get("SHOTHOLD_GOLD", "/tmp/nashville-gold.json"))
JOB_VERSION = "job-v1"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--crops", default="subject-v2")
    ap.add_argument("--min-hold", type=int, default=12)
    ap.add_argument("--same-iou", type=float, default=0.9)
    ap.add_argument("--hold-through", action="store_true")
    ap.add_argument("--zoom-lambda", type=float, default=None)
    ap.add_argument("--loose-cost", type=float, default=1.0)
    ap.add_argument("--tag", default="", help="suffix for the job id, e.g. a crop-policy variant")
    a = ap.parse_args()

    shots = json.loads((CACHE / "shots.json").read_text())
    fps, cuts = shots["fps"], shots["cuts"]
    c = json.loads((CACHE / "crops" / f"{a.crops}.json").read_text())
    crops = {int(i): (s["zoom"], s["focusX"]) for i, s in c["shots"].items()}
    needs = {int(i): tuple(s["need"]) for i, s in c["shots"].items() if s.get("need")}
    job_id = f"{a.crops}.l{a.zoom_lambda}c{a.loose_cost}{'h' if a.hold_through else ''}{'.' + a.tag if a.tag else ''}"
    out = {"job_id": job_id, "version": JOB_VERSION, "params": vars(a), "clock": shots["method"],
           "crop_method": a.crops, "crop_version": c["version"], "fps": fps, "segments": [], "shots": {}}
    for s in json.loads(GOLD.read_text())["segments"]:
        kfs = keyframes_for_segment(s["startTime"], s["endTime"], fps, cuts, crops,
                                    min_hold_frames=a.min_hold, same_crop_iou=a.same_iou, needs=needs,
                                    hold_through=a.hold_through, zoom_lambda=a.zoom_lambda, loose_cost=a.loose_cost)
        out["segments"].append({"id": s["id"], "title": s["title"], "startTime": s["startTime"],
                                "endTime": s["endTime"], "keyframes": kfs})
        f0, f1 = frame_index(s["startTime"], fps), frame_index(s["endTime"], fps)
        b = [f0] + [x for x in cuts if f0 < x < f1] + [f1]
        for x, y in zip(b, b[1:]):
            i = bisect.bisect_right(cuts, x)
            hold = [k for k in kfs if k["sourceFrame"] <= x][-1]
            base = c["shots"][str(i)]
            note = base["reason"]
            if abs(hold["zoom"] - base["zoom"]) > 0.02:
                note += f" · job: zoom {base['zoom']:.2f}→{hold['zoom']:.2f} (smoothed)"
            elif hold["sourceFrame"] != x:
                note += " · job: held through cut"
            out["shots"][str(i)] = {"zoom": hold["zoom"], "focusX": hold["focusX"], "reason": note,
                                    "frames": [x, y], "segment_id": s["id"], "reframed_here": hold["sourceFrame"] == x,
                                    "n_tracks": base.get("n_tracks"), "per_shot": [base["zoom"], base["focusX"]]}
    (CACHE / "job").mkdir(exist_ok=True)
    (CACHE / "job" / f"{job_id}.json").write_text(json.dumps(out, indent=1))
    n = sum(len(s["keyframes"]) for s in out["segments"])
    print(f"{job_id}: {n} keyframes over {len(out['segments'])} segments, {len(out['shots'])} shots")


if __name__ == "__main__":
    main()
