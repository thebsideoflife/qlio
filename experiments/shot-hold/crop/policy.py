#!/usr/bin/env python3
"""Crop layer: one (zoom, focusX) per shot from cached faces. No pixels decoded.

  python -m crop.policy            # reads $CACHE/shots.json + faces.json, writes $CACHE/crops/<method>.json

Methods (all deterministic, all thresholds in PARAMS):
  center-tight   zoom 1, focusX 0.5                       (floor baseline)
  allfaces-v2    widen until every tracked face fits      (the YuNet-PoC objective, but per shot)
  subject-v2     pan to the dominant face, keep 9:16; widen only if the subject's own
                 travel, or an equally-weighted second face that nearly fits, needs it
  subject-v3     as v2, but the subject is the most CENTRAL persistent face, not the largest.
                 Weak labels mined from stored human crops (eval/subject_weak_labels.py): largest
                 face picks the human's subject 46% of the time (chance), most-central 75%.
                 Over-the-shoulder coverage puts the biggest face on the wrong person.
  subject-v2+setup   subject-v2, then shots that return to the same camera setup
                 (A-B-A coverage) share one crop, so the hold does not wobble between visits
"""

from __future__ import annotations

import json
import os
import statistics as st
from pathlib import Path

import numpy as np

from shothold.geometry import TIGHT, focus_for_center, window, window_width, zoom_for_width

CACHE = Path(os.environ.get("SHOTHOLD_CACHE", "/tmp/shothold"))

PARAMS = {
    "edge_guard_frames": 2,      # ignore samples this close to a cut (blend / detector slop)
    "track_dx": 0.08,            # same face if centre-x moves less than this between samples
    "min_presence": 0.3,         # track must be seen in this fraction of the shot's samples
    "min_face_h": 0.07,          # ignore background faces smaller than this (fraction of frame height)
    "second_face_ratio": 0.6,    # a second face "matters" if its salience >= ratio * top salience
    "margin_face_w": 0.6,        # breathing room each side, in subject face widths (soft: never forces a widen)
    "hard_margin_face_w": 0.1,   # margin that CAN force a widen
    "zoom_stops": [1.0, 0.635, 0.36],  # 9:16, 3:4, 1:1 windows. Few letterbox sizes = fewer visible jumps
    "min_zoom_two_shot": 0.635,    # never widen past 3:4 to keep two people; pick one instead
    "min_zoom_travel": 0.36,     # never widen past 1:1 to absorb subject travel
    "noface_zoom": 0.635,        # 3:4 window, centred. Not FULL.
    "zoom_snap": 0.05,           # treat zoom within this of TIGHT as TIGHT
    "central_min_h_ratio": 0.5,  # v3: a face this much smaller than the biggest cannot be the subject
    "setup_thumb_corr": 0.7,    # same setup if mid-shot thumbnails correlate this much ...
    "setup_dx": 0.06,            # ... and the subject centre agrees this closely
    "setup_lookback": 12,        # only match against this many previous shots
}
VERSION = "crop-v3.1"


def shot_bounds(cuts: list[int], n_frames: int) -> list[tuple[int, int]]:
    b = [0] + list(cuts) + [n_frames]
    return list(zip(b, b[1:]))


def build_tracks(samples: list[tuple[int, list[list[float]]]], p: dict) -> list[dict]:
    """Greedy centre-x association. Faces are [x,y,w,h,score, 10 landmark coords]."""
    tracks: list[dict] = []
    for frame, faces in samples:
        used = set()
        for f in sorted(faces, key=lambda f: -f[2] * f[3]):
            cx = f[0] + f[2] / 2
            best, bd = None, p["track_dx"]
            for ti, t in enumerate(tracks):
                if ti in used:
                    continue
                d = abs(t["cx"][-1] - cx)
                if d < bd:
                    best, bd = ti, d
            if best is None:
                tracks.append({"cx": [], "l": [], "r": [], "h": [], "w": [], "mouth": [], "frames": []})
                best = len(tracks) - 1
            used.add(best)
            t = tracks[best]
            t["cx"].append(cx); t["l"].append(f[0]); t["r"].append(f[0] + f[2])
            t["h"].append(f[3]); t["w"].append(f[2]); t["frames"].append(frame)
            if len(f) >= 15 and f[3] > 0:  # mouth-corner midpoint to nose, in face heights
                t["mouth"].append(((f[12] + f[14]) / 2 - f[10]) / f[3])
    n = max(1, len(samples))
    out = []
    for t in tracks:
        pres = len(t["cx"]) / n
        h = st.median(t["h"])
        if pres < p["min_presence"] or h < p["min_face_h"]:
            continue
        cx = st.median(t["cx"])
        out.append(
            {
                "cx": cx, "h": h, "w": st.median(t["w"]), "presence": pres,
                "left": min(t["l"]), "right": max(t["r"]),
                "mouth_std": float(np.std(t["mouth"])) if len(t["mouth"]) >= 3 else 0.0,
                "salience": h * h * pres * (1 - 0.5 * abs(cx - 0.5)),
            }
        )
    return sorted(out, key=lambda t: -t["salience"])


def fit(left: float, right: float, min_zoom: float, p: dict) -> tuple[float, float, bool]:
    """Smallest widening that contains [left, right]. Returns zoom, focusX, fits."""
    need = right - left
    stops = [z for z in p["zoom_stops"] if z >= min_zoom - 1e-9] or [min_zoom]
    zoom = next((z for z in stops if need <= window_width(z)), stops[-1])
    return zoom, focus_for_center((left + right) / 2, zoom), need <= window_width(zoom) + 1e-9


def crop_subject(tracks: list[dict], p: dict, central: bool = False) -> dict:
    if not tracks:
        return {"zoom": p["noface_zoom"], "focusX": 0.5, "reason": "no face: centred 3:4", "n_tracks": 0}
    if central:  # v3: re-rank by centrality among faces of comparable size; rivals judged on size
        big = max(t["h"] for t in tracks)
        tracks = sorted(tracks, key=lambda t: (t["h"] < p["central_min_h_ratio"] * big, abs(t["cx"] - 0.5)))
        tracks = [dict(t, salience=t["h"] * t["presence"]) for t in tracks]
    top = tracks[0]
    m = p["hard_margin_face_w"] * top["w"]
    zoom, fx, _ = fit(top["left"] - m, top["right"] + m, p["min_zoom_travel"], p)
    reason = "single subject" if zoom == TIGHT else "subject travel: widened"
    need = [top["left"] - m, top["right"] + m]
    rivals = [t for t in tracks[1:] if t["salience"] >= p["second_face_ratio"] * top["salience"]]
    if rivals:
        grp = [top] + rivals
        l = min(t["left"] for t in grp) - m
        r = max(t["right"] for t in grp) + m
        z2, fx2, ok = fit(l, r, p["min_zoom_two_shot"], p)
        if ok:
            zoom, fx, need = z2, fx2, [l, r]
            reason = f"{len(grp)} comparable faces fit" + ("" if z2 == TIGHT else ": widened slightly")
        else:
            reason = f"{len(grp)} comparable faces do not fit by 3:4: kept dominant"
    return {"zoom": zoom, "focusX": fx, "reason": reason, "n_tracks": len(tracks), "subject_cx": top["cx"],
            "need": [round(max(0.0, need[0]), 4), round(min(1.0, need[1]), 4)]}


def crop_allfaces(tracks: list[dict], p: dict) -> dict:
    if not tracks:
        return {"zoom": p["noface_zoom"], "focusX": 0.5, "reason": "no face: centred 3:4", "n_tracks": 0}
    m = 0.3 * tracks[0]["w"]
    l, r = min(t["left"] for t in tracks) - m, max(t["right"] for t in tracks) + m
    zoom, fx, _ = fit(l, r, 0.0, p)
    return {"zoom": zoom, "focusX": fx, "reason": f"all {len(tracks)} faces", "n_tracks": len(tracks),
            "subject_cx": tracks[0]["cx"], "need": [round(max(0.0, l), 4), round(min(1.0, r), 4)]}


def assign_setups(bounds, crops: dict, thumbs: np.ndarray | None, p: dict) -> dict[int, int]:
    """Setup id per shot: a shot joins an earlier shot's setup when mid-shot thumbnails
    correlate and the subject sits in the same place. Cheap A-B-A coverage detector."""
    setup: dict[int, int] = {}
    if thumbs is None:
        return {i: i for i in range(len(bounds))}
    mids = [thumbs[min(len(thumbs) - 1, (a + b) // 2)].astype(np.float32).ravel() for a, b in bounds]
    mids = [(m - m.mean()) / (m.std() + 1e-6) for m in mids]
    for i in range(len(bounds)):
        setup[i] = i
        for j in range(i - 1, max(-1, i - 1 - p["setup_lookback"]), -1):
            corr = float(np.dot(mids[i], mids[j]) / mids[i].size)
            ci, cj = crops[i].get("subject_cx"), crops[j].get("subject_cx")
            same_subject = (ci is None and cj is None) or (ci is not None and cj is not None and abs(ci - cj) < p["setup_dx"])
            if corr >= p["setup_thumb_corr"] and same_subject:
                setup[i] = setup[j]
                break
    return setup


def main() -> None:
    shots = json.loads((CACHE / "shots.json").read_text())
    faces = json.loads((CACHE / "faces.json").read_text())
    fr = {int(k): v for k, v in faces["frames"].items()}
    sampled = sorted(fr)
    bounds = shot_bounds(shots["cuts"], shots["n_frames"])
    p = PARAMS
    g = p["edge_guard_frames"]

    per_shot_tracks = []
    import bisect
    for a, b in bounds:
        lo, hi = bisect.bisect_left(sampled, a + g), bisect.bisect_left(sampled, b - g)
        smp = [(f, fr[f]) for f in sampled[lo:hi]] or [(f, fr[f]) for f in sampled[bisect.bisect_left(sampled, a):bisect.bisect_left(sampled, b)]]
        per_shot_tracks.append((build_tracks(smp, p), len(smp)))

    methods = {
        "center-tight": lambda tr: {"zoom": 1.0, "focusX": 0.5, "reason": "baseline", "n_tracks": len(tr)},
        "allfaces-v2": lambda tr: crop_allfaces(tr, p),
        "subject-v2": lambda tr: crop_subject(tr, p),
        "subject-v3": lambda tr: crop_subject(tr, p, central=True),
    }
    out = {}
    for name, fn in methods.items():
        out[name] = {i: {**fn(tr), "n_samples": n} for i, (tr, n) in enumerate(per_shot_tracks)}

    # setup pooling on top of subject-v2
    thumbs = None
    fpath = CACHE / "clock" / "features.npz"
    if fpath.exists():
        z = np.load(fpath)
        key = next((k for k in z.files if "thumb" in k.lower()), None)
        thumbs = z[key] if key else None
    base = out["subject-v2"]
    setup = assign_setups(bounds, base, thumbs, p)
    members: dict[int, list[int]] = {}
    for i, s in setup.items():
        members.setdefault(s, []).append(i)
    pooled = {}
    for s, idxs in members.items():
        wts = [bounds[i][1] - bounds[i][0] for i in idxs]
        order = sorted(idxs, key=lambda i: window(base[i]["zoom"], base[i]["focusX"])[0])
        # duration-weighted median member: a real crop, not an average of two people
        acc, half = 0, sum(wts) / 2
        pick = order[-1]
        for i in order:
            acc += bounds[i][1] - bounds[i][0]
            if acc >= half:
                pick = i
                break
        for i in idxs:
            pooled[i] = {**base[i], "zoom": base[pick]["zoom"], "focusX": base[pick]["focusX"],
                         "setup": s, "setup_size": len(idxs),
                         "reason": base[i]["reason"] + (f" · setup {s} ×{len(idxs)}" if len(idxs) > 1 else "")}
    out["subject-v2+setup"] = pooled

    (CACHE / "crops").mkdir(exist_ok=True)
    for name, crops in out.items():
        (CACHE / "crops" / f"{name}.json").write_text(json.dumps(
            {"method": name, "version": VERSION, "params": p, "clock": shots["method"],
             "faces": faces.get("version"), "bounds": bounds, "shots": crops}, indent=0))
        zs = [c["zoom"] for c in crops.values()]
        print(f"{name:18s} shots={len(zs)} tight={sum(z >= 0.95 for z in zs)} "
              f"mid={sum(0.3 <= z < 0.95 for z in zs)} wide={sum(z < 0.3 for z in zs)} "
              f"noface={sum(c['n_tracks'] == 0 for c in crops.values())}")
    print("setups:", len(members), "of", len(bounds), "shots")


if __name__ == "__main__":
    main()
