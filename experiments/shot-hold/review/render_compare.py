#!/usr/bin/env python3
"""Side-by-side 9:16 preview of ONE segment: stored track (left) vs a job's proposal (right).
Stills cannot show choppiness; this can. Local file only, read-only on the project.

  python -m review.render_compare --segment s3 --job subject-v2.l2.0c4.0h [--max-sec 70]
  python -m review.render_compare --segment s3 --job B --vs A --from-frame 3790 --to-frame 3900 --out x.mp4
      two jobs (left = --vs, right = --job) over a short frame range, e.g. one shot with an exit split
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path

import cv2
import numpy as np

from shothold.geometry import window
from shothold.job import frame_index

CACHE = Path(os.environ.get("SHOTHOLD_CACHE", "/tmp/shothold"))
GOLD = Path(os.environ.get("SHOTHOLD_GOLD", "/tmp/nashville-gold.json"))
W, H = 405, 720


def pane(img: np.ndarray, zoom: float, fx: float, label: str, changed: int) -> np.ndarray:
    h, w = img.shape[:2]
    l, r = window(zoom, fx)
    crop = img[:, int(round(l * w)): int(round(r * w))]
    ch = int(round(W * crop.shape[0] / crop.shape[1]))
    crop = cv2.resize(crop, (W, min(H, ch)), interpolation=cv2.INTER_AREA)
    out = np.zeros((H, W, 3), np.uint8)
    y = (H - crop.shape[0]) // 2
    out[y:y + crop.shape[0]] = crop
    cv2.putText(out, label, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
    if changed < 4:  # flash a marker for 4 frames whenever the crop changes
        cv2.rectangle(out, (0, 0), (W - 1, H - 1), (80, 200, 255), 4)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--segment", required=True)
    ap.add_argument("--job", required=True)
    ap.add_argument("--max-sec", type=float, default=70)
    ap.add_argument("--vs", default=None, help="job id for the LEFT pane instead of the stored track")
    ap.add_argument("--from-frame", type=int, default=None)
    ap.add_argument("--to-frame", type=int, default=None)
    ap.add_argument("--out", default=None, help="file name under review/clips")
    ap.add_argument("--labels", default=None, help="left|right pane labels")
    a = ap.parse_args()
    job = json.loads((CACHE / "job" / f"{a.job}.json").read_text())
    fps = job["fps"]
    seg = next(s for s in json.loads(GOLD.read_text())["segments"] if s["id"] == a.segment)
    prop = next(s for s in job["segments"] if s["id"] == a.segment)["keyframes"]
    s0 = frame_index(seg["startTime"], fps)
    f0 = max(s0, a.from_frame) if a.from_frame is not None else s0
    f1 = min(frame_index(seg["endTime"], fps), a.to_frame if a.to_frame is not None else f0 + int(a.max_sec * fps))

    def track(kfs):
        t = sorted((s0 + max(0, frame_index(seg["startTime"] + k["time"], fps) - s0), k["zoom"] if k["zoom"] is not None else 1.0, k["focusX"]) for k in kfs)
        return t

    left = seg["keyframes"]
    if a.vs:
        left = next(s for s in json.loads((CACHE / "job" / f"{a.vs}.json").read_text())["segments"] if s["id"] == a.segment)["keyframes"]
    tracks = [track(left), track(prop)]
    labels = a.labels.split("|") if a.labels else [f"{'stored' if not a.vs else 'A'} ({len(left)} holds)", f"proposed ({len(prop)} holds)"]
    out_dir = CACHE / "review" / "clips"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / (a.out or f"{a.segment}__{a.job}.mp4")
    # decode the segment from the master at 720p through ffmpeg (accurate seek), compose, encode
    dec = subprocess.Popen(["ffmpeg", "-v", "error", "-ss", f"{f0 / fps:.6f}", "-i", str(CACHE / "master.mp4"),
                            "-frames:v", str(f1 - f0), "-vf", "scale=1280:720", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                           stdout=subprocess.PIPE)
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{2 * W + 10}x{H}",
                            "-r", f"{fps}", "-i", "-", "-ss", f"{f0 / fps:.6f}", "-t", f"{(f1 - f0) / fps:.3f}",
                            "-i", str(CACHE / "master.mp4"), "-map", "0:v", "-map", "1:a?", "-c:v", "libx264", "-crf", "20",
                            "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(out)], stdin=subprocess.PIPE)
    for f in range(f0, f1):
        raw = dec.stdout.read(1280 * 720 * 3)
        if len(raw) < 1280 * 720 * 3:
            break
        img = np.frombuffer(raw, np.uint8).reshape(720, 1280, 3)
        panes = []
        for tr, lab in zip(tracks, labels):
            cur = [k for k in tr if k[0] <= f][-1] if any(k[0] <= f for k in tr) else tr[0]
            panes.append(pane(img, cur[1], cur[2], lab, f - cur[0] if cur[0] != s0 else 99))
        enc.stdin.write(np.hstack([panes[0], np.zeros((H, 10, 3), np.uint8), panes[1]]).tobytes())
    enc.stdin.close(); enc.wait(); dec.kill()
    print(out)


if __name__ == "__main__":
    main()
