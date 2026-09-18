#!/usr/bin/env python3
"""Zoom-class agreement with HUMAN stored holds, per shot (human-framed segments only, shots >= 1 s).
Classes: 9:16 (>=0.9), mid (0.5-0.9), wide (<0.5). A reference, not truth.  python -m eval.human_zoom_agreement --job <id>"""
import argparse, collections, json, os
from pathlib import Path
CACHE = Path(os.environ.get("SHOTHOLD_CACHE", "/tmp/shothold")); GOLD = Path(os.environ.get("SHOTHOLD_GOLD", "/tmp/nashville-gold.json"))
cls = lambda z: "9:16" if z >= 0.9 else "mid" if z >= 0.5 else "wide"
ap = argparse.ArgumentParser(); ap.add_argument("--job", required=True); a = ap.parse_args()
job = json.loads((CACHE / "job" / f"{a.job}.json").read_text()); fps = job["fps"]
segs = {s["id"]: s for s in json.loads(GOLD.read_text())["segments"] if not s.get("aiFraming")}
conf = collections.Counter()
for sh in job["shots"].values():
    s = segs.get(sh["segment_id"]); x, y = sh["frames"]
    if not s or y - x < 24: continue
    t = (x + y) / 2 / fps - s["startTime"]; k = None
    for q in s["keyframes"]:
        if q["time"] <= t and q.get("zoom") is not None and not q.get("ai"): k = q
    if k: conf[(cls(k["zoom"]), cls(sh["zoom"]))] += 1
n = sum(conf.values()); agree = sum(v for (h, m), v in conf.items() if h == m)
print(f"{a.job}: zoom class agrees with human on {agree}/{n} shots ({100*agree/n:.1f}%)")
for h in ("9:16", "mid", "wide"): print(f"  human {h:5s} -> ours " + ", ".join(f"{m}: {conf[(h, m)]}" for m in ("9:16", "mid", "wide")))
