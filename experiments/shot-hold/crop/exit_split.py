#!/usr/bin/env python3
"""Exit split: let a long shot carry up to three pan-only holds when the subject leaves a static window.

  python -m crop.exit_split --crops subject-v4 [--min-gain 3] [--max-pieces 3]

Human review (18 Sep): of 12 crop cards noted "should have been split", 7 were ONE continuous shot where
the subject walks, stands or is pushed out of a static window (20806, 34972, 43601, 52240, 53672, 53870,
7562), 2 were clock misses, 2 the wrong subject. Spec open question 3 answered by the reviewer: a second
hold is wanted. Kept deliberately narrow so it cannot reintroduce 1 fps chatter:

  - only when the per-frame subject is >25% outside the shot's window on >= min_gain more samples
    (4 per second) than the best split leaves; each piece >= 1 s; at most max_pieces pieces
  - pan only: every piece keeps the shot's zoom (the split frames are written as "tied" so the job
    layer cannot move the letterbox mid-shot)
  - the new hold starts on the frame of largest picture change between the two samples, so the jump
    rides existing motion instead of landing on a still frame

The subject is the one the crop policy chose for the shot, followed sample to sample by nearest face
(jumps up to 0.2 of frame width per 0.25 s, so fast movers the policy's tracker drops still count).
A shot with no persistent face is seeded by its first face (late entrance). Shots with no face at all
never split: that needs a body or saliency signal.
Writes $CACHE/crops/<method>+split.json and $CACHE/shots_split.json (cuts + split frames, with "tied").
"""

from __future__ import annotations

import argparse
import bisect
import json
import os
import statistics as st
from pathlib import Path

import numpy as np

from shothold.geometry import focus_for_center, window, window_width

CACHE = Path(os.environ.get("SHOTHOLD_CACHE", "/tmp/shothold"))
SP = {"min_piece": 24, "min_gain": 3, "max_pieces": 3, "min_face_h": 0.07, "out_frac": 0.25, "guard": 2,
      "seed_dx": 0.12, "max_jump": 0.2, "max_size_ratio": 1.6}


def subject_path(smp: list, seed_cx: float) -> list:
    """Follow THE shot's subject (seeded at the crop policy's subject_cx) sample to sample: nearest face
    within max_jump whose size is consistent. Never switches to whoever is most central in one frame:
    a first version did, and panned A-B-A across approved two-shots (19391: 0.91 -> 0.11 -> 0.85)."""
    out, cx, h = [], seed_cx, None
    for f, faces in smp:
        fs = [b for b in faces if b[3] >= SP["min_face_h"]]
        near = [b for b in fs if abs(b[0] + b[2] / 2 - cx) <= (SP["seed_dx"] if h is None else SP["max_jump"])
                and (h is None or max(h, b[3]) / min(h, b[3]) < SP["max_size_ratio"])]
        if not near:
            out.append((f, None))
            continue
        b = min(near, key=lambda b: abs(b[0] + b[2] / 2 - cx))
        cx, h = b[0] + b[2] / 2, b[3]
        out.append((f, (b[0], b[0] + b[2])))
    return out


def bad(boxes: list, zoom: float, fx: float) -> int:
    l, r = window(zoom, fx)
    return sum(1 for bl, br in boxes if max(0.0, l - bl) + max(0.0, br - r) > SP["out_frac"] * (br - bl))


def piece_crop(boxes: list, zoom: float, need_w: float | None = None) -> tuple[float, list[float]]:
    """Pan for a piece: centre on the median subject centre. need = the parent shot's need WIDTH re-centred
    here, so the job layer sees the same zoom requirement as before the split (the whole window would stop
    it tightening a 3:4 shot back to 9:16)."""
    cx = st.median((l + r) / 2 for l, r in boxes)
    fx = focus_for_center(cx, zoom)
    l, r = window(zoom, fx)
    if need_w is not None:
        l, r = max(0.0, cx - need_w / 2), min(1.0, cx + need_w / 2)
    else:  # parent had no persistent face (need None): the piece's own subject extent, as the policy builds one
        w = st.median(r - l for l, r in boxes)
        l = float(np.percentile([b[0] for b in boxes], 10)) - 0.1 * w
        r = float(np.percentile([b[1] for b in boxes], 90)) + 0.1 * w
    return fx, [round(max(0.0, l), 4), round(min(1.0, r), 4)]


def best_split(smp: list, zoom: float, fx0: float) -> tuple[int, list[int]]:
    """Exhaustive over <= max_pieces-1 split points at sample boundaries. Returns (bad samples, split indices)."""
    boxes = [s[1] for s in smp]
    idx = [k for k, s in enumerate(smp) if s[1] is not None]

    def cost(lo: int, hi: int) -> int:
        bx = [boxes[k] for k in range(lo, hi) if boxes[k] is not None]
        return bad(bx, zoom, piece_crop(bx, zoom)[0]) if bx else 0

    n = len(smp)
    frames = [s[0] for s in smp]
    ok = lambda lo, hi: frames[hi - 1] - frames[lo] >= SP["min_piece"] if hi > lo else False  # sample span; the piece itself is longer
    base = bad([boxes[k] for k in idx], zoom, fx0)
    best = (base, [])
    for i in range(1, n):
        if not (ok(0, i) and ok(i, n)):
            continue
        c = cost(0, i) + cost(i, n)
        if c < best[0]:
            best = (c, [i])
        if SP["max_pieces"] >= 3:
            for j in range(i + 1, n):
                if not (ok(i, j) and ok(j, n)):
                    continue
                c3 = cost(0, i) + cost(i, j) + cost(j, n)
                if c3 < best[0] and c3 <= c - SP["min_gain"]:  # a third piece must earn its own keep
                    best = (c3, [i, j])
    return best if base - best[0] >= SP["min_gain"] else (base, [])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--crops", default="subject-v4")
    ap.add_argument("--min-gain", type=int, default=SP["min_gain"])
    ap.add_argument("--max-pieces", type=int, default=SP["max_pieces"])
    a = ap.parse_args()
    SP["min_gain"], SP["max_pieces"] = a.min_gain, a.max_pieces
    shots = json.loads((CACHE / "shots.json").read_text())
    crops = json.loads((CACHE / "crops" / f"{a.crops}.json").read_text())
    fr = {int(k): v for k, v in json.loads((CACHE / "faces.json").read_text())["frames"].items()}
    mad = np.load(CACHE / "clock" / "features.npz")["mad"]
    keys = sorted(fr)
    cuts, n_frames = shots["cuts"], shots["n_frames"]
    bnds = list(zip([0] + cuts, cuts + [n_frames]))
    new_cuts, tied, out_shots = [], [], {}
    n_split_shots = 0
    for i, (x, y) in enumerate(bnds):
        c = crops["shots"][str(i)]
        pieces = [(x, c)]
        if y - x >= 2 * SP["min_piece"]:
            raw = [(f, fr[f]) for f in keys[bisect.bisect_left(keys, x + SP["guard"]):bisect.bisect_left(keys, y - SP["guard"])]]
            seed = c.get("subject_cx")
            if seed is None:  # no persistent face: a late entrance (a face over a dissolve, a walk-in) seeds the path
                first = next((fs for _, fs in raw if any(b[3] >= SP["min_face_h"] for b in fs)), None)
                seed = None if first is None else max((b for b in first if b[3] >= SP["min_face_h"]), key=lambda b: b[3])
                seed = None if seed is None else seed[0] + seed[2] / 2
            smp = subject_path(raw, seed) if seed is not None else []
            if sum(s[1] is not None for s in smp) >= 4:
                _, sp = best_split(smp, c["zoom"], c["focusX"])
                if sp:
                    n_split_shots += 1
                    edges = [0] + sp + [len(smp)]
                    pieces = []
                    for lo, hi in zip(edges, edges[1:]):
                        bx = [s[1] for s in smp[lo:hi] if s[1] is not None]
                        start = x
                        if lo:
                            f0, f1 = smp[lo - 1][0] + 1, smp[lo][0] + 1  # largest picture change between the samples
                            start = int(f0 + np.argmax(mad[f0:f1]))
                        nw = c["need"][1] - c["need"][0] if c.get("need") else None
                        fx, need = piece_crop(bx, c["zoom"], nw) if bx else (c["focusX"], c.get("need"))
                        pieces.append((start, dict(c, focusX=round(fx, 4), need=need,
                                                   reason=c["reason"] + (f" · exit split {len(edges) - 1}" if bx else ""))))
        for k, (start, pc) in enumerate(pieces):
            if start != 0:
                new_cuts.append(start)
            if k:
                tied.append(start)
            out_shots[str(len(out_shots))] = pc
    assert new_cuts == sorted(new_cuts) and len(new_cuts) == len(set(new_cuts))
    tag = f"{a.crops}+split"
    (CACHE / "crops" / f"{tag}.json").write_text(json.dumps(
        {**{k: crops[k] for k in ("method", "version", "clock", "faces")}, "method": tag, "params": {**crops["params"], "split": SP},
         "bounds": list(zip([0] + new_cuts, new_cuts + [n_frames])), "shots": out_shots}, indent=0))
    (CACHE / "shots_split.json").write_text(json.dumps(
        {**{k: shots[k] for k in ("method", "version", "params", "fps", "n_frames")}, "method": shots["method"] + "+exit-split",
         "cuts": new_cuts, "tied": tied, "gradual": shots.get("gradual", [])}))
    print(f"{tag}: {n_split_shots} of {len(bnds)} shots split, {len(tied)} mid-shot holds added")


if __name__ == "__main__":
    main()
