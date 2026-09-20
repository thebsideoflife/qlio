"""clock-v3: union clock (hist-adaptive-v2 + PySceneDetect-adaptive) minus a lighting veto.

  python clock/clock_v3.py [--veto 0.6] [--out-cache /tmp/shothold-v3]

Why each piece, from human review (labels/labels.jsonl, 18 Sep):
  union    16243 is a real cut v1 missed; v2 and PySceneDetect-adaptive both have it. Extra hard cuts are
           nearly free in the job layer (+15 cuts changed 0 holds), missed cuts are not.
  veto     every denied clock cut (8 of 8 suspicious / hist-only) was a stage-light or gain change on an
           unchanged composition. The gradient FIELD survives a light change and does not survive a cut
           (clock/struct_features.py). A candidate is vetoed only if all three consecutive pairs around it
           (N-2..N+1) keep the same structure, so an off-by-one cut frame can never veto a real cut.
           Nashville: 0 of 799 three-detector consensus cuts vetoed except 2949, itself a light change.
  gradual  midpoints of gradual transitions are exempt (consecutive frames of a dissolve always match).
  dissolve clock/dissolve.py proposals are merged: the reviewer approved 3 of 4 as two different setups. The
           false one (an occluder) costs at most one pan split inside a shot, which the exit split may do anyway.

Writes $CACHE/clock/v3/clock-v3.json, and a shots.json for a separate cache so the reviewed v1 run stays put.
"""
import argparse, json, os
import numpy as np

CACHE = os.environ.get("SHOTHOLD_CACHE", "/tmp/shothold")
C = CACHE + "/clock/"


def build(veto: float = 0.6, tol: int = 2) -> dict:
    v2 = json.load(open(C + "v2/hist-adaptive-v2.json"))
    pa = json.load(open(C + "pyscene-adaptive.json"))
    g1 = np.load(C + "struct.npz")["gcos1"]
    grad = {(a + b) // 2 for a, b in v2.get("gradual", [])}
    dis = [d["frame"] for d in json.load(open(C + "dissolves.json"))["dissolves"]] if os.path.exists(C + "dissolves.json") else []
    grad |= set(dis)
    cuts = sorted(set(v2["cuts"]) | set(dis))
    base = np.array(cuts)
    cuts += [int(c) for c in pa["cuts"] if not len(base) or np.abs(base - c).min() > tol]  # prefer v2's frame
    cuts = sorted(set(cuts))
    kept, vetoed = [], []
    for c in cuts:
        s = float(g1[max(1, c - 1):c + 2].min())
        (vetoed if s > veto and c not in grad else kept).append((c, round(s, 3)))
    return {"method": "clock-v3", "version": "3.0", "fps": v2["fps"], "n_frames": v2["n_frames"],
            "params": {"sources": ["hist-adaptive-v2", "pyscene-adaptive", "long-dissolve-v1"], "dedup_tol": tol, "prefer": "hist-adaptive-v2",
                       "veto": "min gcos1[N-1..N+1] > %.2f (lighting: same gradient field across the cut)" % veto,
                       "veto_exempt": "gradual midpoints"},
            "cuts": [c for c, _ in kept], "gradual": v2.get("gradual", []), "dissolves": dis, "vetoed": vetoed}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--veto", type=float, default=0.6)
    ap.add_argument("--out-cache", default="/tmp/shothold-v3")
    a = ap.parse_args()
    d = build(a.veto)
    os.makedirs(C + "v3", exist_ok=True)
    json.dump(d, open(C + "v3/clock-v3.json", "w"))
    oc = a.out_cache
    os.makedirs(oc, exist_ok=True)
    for f in ("proxy.mp4", "master.mp4", "faces.json", "face_sharp.json", "clock", "review"):
        if not os.path.lexists(os.path.join(oc, f)) and os.path.exists(os.path.join(CACHE, f)):
            os.symlink(os.path.join(CACHE, f), os.path.join(oc, f))
    json.dump({k: d[k] for k in ("method", "version", "params", "fps", "n_frames", "cuts", "gradual")},
              open(os.path.join(oc, "shots.json"), "w"))
    print(f"clock-v3: {len(d['cuts'])} cuts, {len(d['vetoed'])} vetoed -> {oc}/shots.json")


if __name__ == "__main__":
    main()
