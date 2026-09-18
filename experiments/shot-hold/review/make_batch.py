#!/usr/bin/env python3
"""Generate small review batches (cards + stills). Never the whole episode.

  python -m review.make_batch crop --method subject-v2 --job <job_id> --n 36 [--seed 0] [--tag r1]
  python -m review.make_batch cut  --n 30

A card is self-describing: asset, source frames, proposal, method + version. Stills are
regenerable from (asset, source_frames), so labels stay valid if /tmp is wiped.
"""

from __future__ import annotations

import argparse
import bisect
import json
import os
import random
import re
from pathlib import Path

import cv2

from shothold.geometry import crop_iou

CACHE = Path(os.environ.get("SHOTHOLD_CACHE", "/tmp/shothold"))
ASSET = "64b4881a-beef-4e43-b755-b01a4afe1322"
GOLD = Path(os.environ.get("SHOTHOLD_GOLD", "/tmp/nashville-gold.json"))
IMG = CACHE / "review" / "img"
BATCHES = CACHE / "review" / "batches"


def grab(frames: list[int]) -> dict[int, "cv2.Mat"]:
    cap = cv2.VideoCapture(str(CACHE / "proxy.mp4"))
    out = {}
    for f in sorted(set(frames)):
        cap.set(cv2.CAP_PROP_POS_FRAMES, f)
        ok, img = cap.read()
        if ok:
            out[f] = img
    cap.release()
    return out


def save(img, rel: str) -> str:
    p = IMG / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(p), img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return rel


def gold_segments() -> list[dict]:
    return json.loads(GOLD.read_text())["segments"]


def stored_crop(segs: list[dict], t: float) -> tuple[dict | None, dict | None]:
    for s in segs:
        if s["startTime"] <= t < s["endTime"]:
            kf = None
            for k in s.get("keyframes") or []:
                if k["time"] <= t - s["startTime"] + 1e-6:
                    kf = k
            crop = {"zoom": kf["zoom"], "focusX": kf["focusX"], "ai": kf.get("ai")} if kf and kf.get("zoom") is not None else None
            return s, crop
    return None, None


def crop_batch(a) -> None:
    a.crops_name = a.method
    c = json.loads((CACHE / "crops" / f"{a.method}.json").read_text())
    if a.job:  # review what the job would actually write (after zoom smoothing / hold-through)
        j = json.loads((CACHE / "job" / f"{a.job}.json").read_text())
        for i, sh in j["shots"].items():
            c["shots"][i] = {**c["shots"][i], **sh}
        a.method, c["version"] = j["job_id"], f"{c['version']}+{j['version']}"
    fps = json.loads((CACHE / "shots.json").read_text())["fps"]
    segs = gold_segments()
    rng = random.Random(a.seed)
    base_shots = json.loads((CACHE / "crops" / f"{a.crops_name}.json").read_text())["shots"]
    other = json.loads((CACHE / "crops" / f"{a.disagree_with}.json").read_text()) if a.disagree_with else None
    risky = json.loads(Path(a.shots_file).read_text()) if a.shots_file else None
    if risky:
        for i, n in risky.items():
            c["shots"][i]["flags"] = [f"{n} samples with a subject-sized untracked face outside the window"]
    strata: dict[str, list[int]] = {}
    for i, (s, e) in enumerate(c["bounds"]):
        seg, _ = stored_crop(segs, (s + e) / 2 / fps)
        if seg is None or (e - s) < 18:
            continue
        if risky is not None and str(i) not in risky:
            continue
        if other is not None:  # only shots where two crop methods disagree: highest-value labels
            o = other["shots"][str(i)]
            if crop_iou((o["zoom"], o["focusX"]), (base_shots[str(i)]["zoom"], base_shots[str(i)]["focusX"])) >= 0.5:
                continue
        key = re.split(r"[:·]", c["shots"][str(i)]["reason"])[0].strip()
        key = re.sub(r"^\d+ ", "N ", key)
        strata.setdefault(key, []).append(i)
    picks: list[int] = []
    keys = sorted(strata)
    for k in keys:
        rng.shuffle(strata[k])
    while len(picks) < a.n and any(strata.values()):
        for k in keys:
            if strata[k] and len(picks) < a.n:
                picks.append(strata[k].pop())
    picks.sort()
    want = {}
    for i in picks:
        s, e = c["bounds"][i]
        want[i] = [min(e - 1, s + 3), (s + e) // 2, max(s, e - 4)]
    imgs = grab([f for fs in want.values() for f in fs])
    cards = []
    for i in picks:
        s, e = c["bounds"][i]
        sh = c["shots"][str(i)]
        seg, gold = stored_crop(segs, (s + e) / 2 / fps)
        rels = [save(imgs[f], f"{ASSET[:8]}/f{f:06d}.jpg") for f in want[i]]
        cards.append({
            "card_id": f"crop:{ASSET[:8]}:{s}-{e}:{a.method}:{c['version']}",
            "kind": "crop", "asset_id": ASSET, "method": a.method, "method_version": c["version"],
            "input": {"fps": fps, "shot_frames": [s, e], "source_frames": want[i], "images": rels,
                      "image_notes": ["open", "mid", "close"], "clock": c["clock"], "faces": c["faces"]},
            "proposal": {"zoom": sh["zoom"], "focusX": sh["focusX"], "reason": sh["reason"]},
            "context": {"shot_index": i, "start_sec": s / fps, "end_sec": e / fps,
                        "segment_id": seg["id"], "segment_title": seg["title"], "stored_crop": gold,
                        "n_tracks": sh.get("n_tracks"), "setup": sh.get("setup"),
                        "flags": sh.get("flags", [])},
        })
    write(f"crop-{a.method}-{a.tag}", f"Crop · {a.method} · {a.tag}", cards)


def cut_batch(a) -> None:
    shots = json.loads((CACHE / "shots.json").read_text())
    fps = shots["fps"]
    segs = gold_segments()
    rng = random.Random(a.seed)
    cats: dict[str, list[int]] = {}
    for p in sorted((CACHE / "clock" / "pairs").glob("*.jpg")):
        m = re.match(r"([a-z]+)_(\d+)\.jpg", p.name)
        if m:
            cats.setdefault(m.group(1), []).append(int(m.group(2)))
    picks: list[tuple[str, int]] = []
    keys = sorted(cats)
    cats_all = {k: list(v) for k, v in cats.items()}
    for k in keys:
        rng.shuffle(cats[k])
    while len(picks) < a.n and any(cats.values()):
        for k in keys:
            if cats[k] and len(picks) < a.n:
                picks.append((k, cats[k].pop()))
    offs = lambda cat: (-30, -10, 10, 30) if cat == "dissolve" else (-2, -1, 0, 1)
    picks = [(c, n) for c in keys for n in cats_all[c] if c == "dissolve"] + [p for p in picks if p[0] != "dissolve"]
    imgs = grab([n + d for c, n in picks for d in offs(c)])
    cuts = shots["cuts"]
    cards = []
    for cat, n in sorted(picks, key=lambda x: x[1]):
        fr = [n + d for d in offs(cat) if n + d in imgs]
        rels = [save(imgs[f], f"{ASSET[:8]}/f{f:06d}.jpg") for f in fr]
        j = bisect.bisect_left(cuts, n)
        in_clock = j < len(cuts) and cuts[j] == n
        seg, _ = stored_crop(segs, n / fps)
        cards.append({
            "card_id": f"cut:{ASSET[:8]}:{n}:{shots['method']}:{shots['version']}",
            "kind": "cut", "asset_id": ASSET, "method": shots["method"], "method_version": shots["version"],
            "input": {"fps": fps, "source_frames": fr, "images": rels,
                      "image_notes": (["N-30", "N-10", "N+10", "N+30"] if cat == "dissolve" else ["N-2", "N-1 (old shot)", "N (new shot)", "N+1"])[: len(fr)]},
            "proposal": {"cut_frame": n, "is_cut": in_clock,
                         "reason": "long-dissolve detector proposes a soft cut at the midpoint. Approve = two different setups" if cat == "dissolve" else "clock says CUT here" if in_clock else "clock says NO cut here (candidate miss). Approve = the clock is right"},
            "context": {"cut_sec": n / fps, "category": cat, "segment_title": seg["title"] if seg else None},
        })
    write(f"cut-{shots['method']}-{a.tag}", f"Cut · {shots['method']} · {a.tag}", cards)


def clip_batch(a) -> None:
    j = json.loads((CACHE / "job" / f"{a.job}.json").read_text())
    segs = {s["id"]: s for s in gold_segments()}
    cards = []
    for p in sorted((CACHE / "review" / "clips").glob(f"*__{a.job}.mp4")):
        sid = p.name.split("__")[0]
        prop = next(s for s in j["segments"] if s["id"] == sid)
        cards.append({
            "card_id": f"clip:{ASSET[:8]}:{sid}:{j['job_id']}:{j['version']}",
            "kind": "clip", "asset_id": ASSET, "method": j["job_id"], "method_version": j["version"],
            "input": {"fps": j["fps"], "clip": p.name, "segment_id": sid, "images": [], "source_frames": [],
                      "source_range_sec": [segs[sid]["startTime"], segs[sid]["endTime"]]},
            "proposal": {"keyframes": prop["keyframes"],
                         "reason": f"{len(segs[sid]['keyframes'])} stored holds vs {len(prop['keyframes'])} proposed, all on cut frames"},
            "context": {"segment_title": segs[sid]["title"], "stored_keyframes": segs[sid]["keyframes"]},
        })
    write(f"clip-{a.job}-{a.tag}", f"Clip A/B · {a.job} · {a.tag}", cards)


def write(batch_id: str, title: str, cards: list[dict]) -> None:
    BATCHES.mkdir(parents=True, exist_ok=True)
    (BATCHES / f"{batch_id}.json").write_text(json.dumps({"batch_id": batch_id, "title": title, "cards": cards}))
    print(f"{batch_id}: {len(cards)} cards")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=["crop", "cut", "clip"])
    ap.add_argument("--method", default="subject-v2")
    ap.add_argument("--n", type=int, default=36)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--tag", default="r1")
    ap.add_argument("--shots-file", default=None, help="json {shotIndex: n}; restrict the batch to these shots and show the flag")
    ap.add_argument("--disagree-with", default=None, help="crop method; keep only shots where it disagrees with --method")
    ap.add_argument("--job", default=None, help="job id from shothold.run_job; overrides per-shot crops")
    a = ap.parse_args()
    {"crop": crop_batch, "cut": cut_batch, "clip": clip_batch}[a.kind](a)
