#!/usr/bin/env python3
"""Who is the subject? Use the stored HUMAN crops as weak labels (free, already paid for).

For every camera shot in a human-framed segment with >= 2 comparable faces, if the stored crop
at mid-shot contains exactly one of those faces, that face is the human's subject. Then ask which
cheap cue predicts the human's pick. Writes the examples as jsonl (finetune-ready pointers)."""

from __future__ import annotations

import bisect
import json
import os
import statistics as st
from pathlib import Path

from crop.policy import PARAMS, build_tracks, shot_bounds
from shothold.geometry import window

CACHE = Path(os.environ.get("SHOTHOLD_CACHE", "/tmp/shothold"))
GOLD = Path(os.environ.get("SHOTHOLD_GOLD", "/tmp/nashville-gold.json"))
OUT = Path(__file__).resolve().parent.parent / "labels" / "weak_subject_from_stored.jsonl"


def main() -> None:
    shots = json.loads((CACHE / "shots.json").read_text())
    fps = shots["fps"]
    fr = {int(k): v for k, v in json.loads((CACHE / "faces.json").read_text())["frames"].items()}
    mouth = {int(k): v for k, v in json.loads((CACHE / "mouth.json").read_text())["frames"].items()}
    keys = sorted(fr)
    segs = [s for s in json.loads(GOLD.read_text())["segments"] if not s.get("aiFraming")]
    rows = []
    for i, (a, b) in enumerate(shot_bounds(shots["cuts"], shots["n_frames"])):
        mid = (a + b) / 2 / fps
        seg = next((s for s in segs if s["startTime"] <= mid < s["endTime"]), None)
        if not seg or b - a < 18:
            continue
        kf = [k for k in seg["keyframes"] if k["time"] <= mid - seg["startTime"] and not k.get("ai") and k.get("zoom") is not None]
        if not kf:
            continue
        smp = [(f, fr[f]) for f in keys[bisect.bisect_left(keys, a + 2):bisect.bisect_left(keys, b - 2)]]
        tracks = build_tracks(smp, PARAMS)
        tracks = [t for t in tracks if t["salience"] >= 0.25 * tracks[0]["salience"]]
        if len(tracks) < 2:
            continue
        l, r = window(kf[-1]["zoom"], kf[-1]["focusX"])
        inside = [t for t in tracks if l <= t["cx"] <= r]
        if len(inside) != 1:
            continue
        # mouth-minus-eyes activity per track: nearest face per sample
        for t in tracks:
            vals = []
            for f, faces in smp:
                for j, face in enumerate(faces):
                    if abs(face[0] + face[2] / 2 - t["cx"]) < 0.06 and str(j) in mouth.get(f, {}):
                        m, e = mouth[f][str(j)]
                        vals.append(m - e)
            t["talk"] = st.mean(vals) if vals else -99.0
        rows.append({"shot": i, "frames": [a, b], "segment": seg["id"], "stored": [kf[-1]["zoom"], kf[-1]["focusX"]],
                     "tracks": [{k: round(t[k], 4) for k in ("cx", "h", "presence", "salience", "talk")} for t in tracks],
                     "human_pick": tracks.index(inside[0])})
    cues = {
        "largest face": lambda ts: max(range(len(ts)), key=lambda j: ts[j]["h"]),
        "salience (subject-v2)": lambda ts: 0,
        "most central": lambda ts: min(range(len(ts)), key=lambda j: abs(ts[j]["cx"] - 0.5)),
        "mouth-minus-eyes motion": lambda ts: max(range(len(ts)), key=lambda j: ts[j]["talk"]),
        "largest, tie(<15%)->mouth": lambda ts: (lambda big: max([j for j in range(len(ts)) if ts[j]["h"] >= 0.85 * ts[big]["h"]], key=lambda j: ts[j]["talk"]))(max(range(len(ts)), key=lambda j: ts[j]["h"])),
    }
    print(f"weak-labelled multi-face shots: {len(rows)}  (chance ≈ {st.mean(1 / len(r['tracks']) for r in rows):.2f})")
    for name, fn in cues.items():
        acc = st.mean(fn(r["tracks"]) == r["human_pick"] for r in rows)
        print(f"  {name:28s} {100 * acc:5.1f}%")
    OUT.parent.mkdir(exist_ok=True)
    with OUT.open("w") as f:
        for r in rows:
            f.write(json.dumps({"schema": "shothold.weak_subject.v1", "asset_id": "64b4881a-beef-4e43-b755-b01a4afe1322", **r}) + "\n")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
