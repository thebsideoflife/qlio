#!/usr/bin/env python3
"""What sits inside the holds the reviewer said "should have been split"?

  python -m eval.split_probe [--sheet DIR]

For every crop label whose note mentions split / zoom out, list what each detector says inside the
held shot (any cut the v1 clock did not use), the strongest in-shot score, and how far the subject
moved. With --sheet, writes one 8-frame strip per card with the proposed window drawn, so the
answer (missed cut vs moving subject) is checked by eye on ~100 small frames, not by a model."""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path

import cv2
import numpy as np

from clock.detect import score_of
from shothold.geometry import window

CACHE = Path(os.environ.get("SHOTHOLD_CACHE", "/tmp/shothold"))
LABELS = Path(__file__).resolve().parent.parent / "labels" / "labels.jsonl"
DETECTORS = {
    "pyA": "clock/pyscene-adaptive.json",
    "pyC": "clock/pyscene-content.json",
    "v2": "clock/v2/hist-adaptive-v2.json",
    "ff.2": "clock/ffscene-0.2.json",
}


def split_cards() -> list[dict]:
    last = {}
    for line in LABELS.read_text().splitlines():
        if line.strip():
            r = json.loads(line)
            last[r["card_id"]] = r
    return [r for r in last.values() if r["kind"] == "crop" and re.search(r"split|zoom", r.get("notes", ""), re.I)]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", default="")
    a = ap.parse_args()
    F = dict(np.load(CACHE / "clock" / "features.npz"))
    s = score_of(F)
    det = {k: np.array(json.load(open(CACHE / v))["cuts"]) for k, v in DETECTORS.items()}
    cap = cv2.VideoCapture(str(CACHE / "proxy.mp4")) if a.sheet else None
    out = []
    for r in split_cards():
        a0, b0 = r["input"]["shot_frames"]
        inner = {k: [int(c) for c in v[(v > a0 + 2) & (v < b0 - 2)]] for k, v in det.items()}
        inner = {k: v for k, v in inner.items() if v}
        pk = int(a0 + 3 + np.argmax(s[a0 + 3:b0 - 2])) if b0 - a0 > 6 else a0
        row = {"frames": [a0, b0], "sec": round((b0 - a0) / 23.976, 1), "verdict": r["verdict"], "note": r["notes"],
               "branch": r["proposal"]["reason"][:40], "detectors_inside": inner, "peak_frame": pk,
               "peak_score": round(float(s[pk]), 3)}
        out.append(row)
        print(json.dumps(row))
        if cap is not None:
            fr = np.linspace(a0 + 1, b0 - 2, 8).astype(int)
            tiles = []
            L, R = window(r["proposal"]["zoom"], r["proposal"]["focusX"])
            for f in fr:
                cap.set(cv2.CAP_PROP_POS_FRAMES, int(f))
                ok, im = cap.read()
                im = cv2.resize(im, (192, 108))
                cv2.rectangle(im, (int(L * 192), 0), (int(R * 192) - 1, 107), (0, 255, 255), 2)
                cv2.putText(im, str(f), (3, 104), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (255, 255, 255), 1)
                tiles.append(im)
            Path(a.sheet).mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(Path(a.sheet) / f"split_{a0}.jpg"), np.hstack(tiles), [cv2.IMWRITE_JPEG_QUALITY, 80])
    json.dump(out, open(CACHE / "eval" / "split_probe.json", "w"), indent=1)


if __name__ == "__main__":
    main()
