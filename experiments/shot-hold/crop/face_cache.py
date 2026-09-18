"""Face-detection cache over the 640x360 proxy (YuNet, every 6th frame).

Writes /tmp/shothold/faces.json (normalised coords) and, as a by-product of the
same pass, /tmp/shothold/mouth.json (cheap mouth-region frame-difference signal).

Usage: .venv/bin/python crop/face_cache.py [--upscale] [--out PATH] [--limit N]
"""
import argparse
import json
import os
import time

import cv2
import numpy as np

CACHE = os.environ.get("SHOTHOLD_CACHE", "/tmp/shothold")
PROXY = CACHE + "/proxy.mp4"
MODEL = "/tmp/shothold/models/face_detection_yunet_2023mar.onnx"
STRIDE = 6
SCORE_THR = 0.6
NMS_THR = 0.3


def make_detector(w, h):
    return cv2.FaceDetectorYN.create(MODEL, "", (w, h), SCORE_THR, NMS_THR, 5000)


def detect_norm(det, img):
    """Return list of 15-float rows normalised by image size."""
    h, w = img.shape[:2]
    _, faces = det.detect(img)
    out = []
    if faces is None:
        return out
    scale = np.array([w, h] * 2 + [1.0] + [w, h] * 5, dtype=np.float64)
    order = [0, 1, 2, 3, 14] + list(range(4, 14))
    for f in faces:
        row = (f.astype(np.float64)[order]) / scale
        out.append([round(float(v), 4) for v in row])
    out.sort(key=lambda r: (-r[4], r[0], r[1]))
    return out


def _roi(gray, cx, cy, hw, hh):
    H, W = gray.shape
    x0, x1 = int(max(0, cx - hw)), int(min(W, cx + hw))
    y0, y1 = int(max(0, cy - hh)), int(min(H, cy + hh))
    if x1 - x0 < 3 or y1 - y0 < 2:
        return None
    return (y0, y1, x0, x1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--upscale", action="store_true")
    ap.add_argument("--out", default=CACHE + "/faces.json")
    ap.add_argument("--mouth-out", default=CACHE + "/mouth.json")
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()

    cv2.setNumThreads(8)
    cap = cv2.VideoCapture(PROXY)
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    dw, dh = (W * 2, H * 2) if a.upscale else (W, H)
    det = make_detector(dw, dh)

    frames = {}
    mouth = {}
    active = []  # [(frame_key, face_idx, mouth_roi, upper_roi, prev_gray_m, prev_gray_u, mdiffs, udiffs)]
    t_det = 0.0
    n_det = 0
    t0 = time.time()
    i = 0
    prev_gray = None
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        # accumulate mouth / upper-face diffs for ROIs fixed at last detection
        if prev_gray is not None and active:
            d = cv2.absdiff(gray, prev_gray)
            for rec in active:
                y0, y1, x0, x1 = rec["m"]
                rec["md"].append(float(d[y0:y1, x0:x1].mean()))
                y0, y1, x0, x1 = rec["u"]
                rec["ud"].append(float(d[y0:y1, x0:x1].mean()))
        if i % STRIDE == 0:
            # flush previous window
            for rec in active:
                if rec["md"]:
                    mouth.setdefault(rec["k"], {})[str(rec["j"])] = [
                        round(float(np.mean(rec["md"])), 3),
                        round(float(np.mean(rec["ud"])), 3),
                    ]
            active = []
            ts = time.time()
            img = cv2.resize(frame, (dw, dh), interpolation=cv2.INTER_CUBIC) if a.upscale else frame
            rows = detect_norm(det, img)
            t_det += time.time() - ts
            n_det += 1
            frames[str(i)] = rows
            for j, r in enumerate(rows):
                mrx, mry, mlx, mly = r[11] * W, r[12] * H, r[13] * W, r[14] * H
                rex, rey, lex, ley = r[5] * W, r[6] * H, r[7] * W, r[8] * H
                mw = max(4.0, abs(mlx - mrx))
                m = _roi(gray, (mrx + mlx) / 2, (mry + mly) / 2 + 0.15 * mw, 0.75 * mw, 0.5 * mw)
                u = _roi(gray, (rex + lex) / 2, (rey + ley) / 2, 0.9 * mw, 0.4 * mw)
                if m and u:
                    active.append({"k": str(i), "j": j, "m": m, "u": u, "md": [], "ud": []})
        prev_gray = gray
        i += 1
        if a.limit and i >= a.limit:
            break
    for rec in active:
        if rec["md"]:
            mouth.setdefault(rec["k"], {})[str(rec["j"])] = [
                round(float(np.mean(rec["md"])), 3), round(float(np.mean(rec["ud"])), 3)]

    doc = {
        "model": "yunet_2023mar",
        "version": "faces-v1",
        "input": "proxy 640x360 upscaled 2x to 1280x720 (INTER_CUBIC)" if a.upscale else "proxy 640x360",
        "stride": STRIDE,
        "score_thr": SCORE_THR,
        "frames": frames,
    }
    with open(a.out, "w") as f:
        json.dump(doc, f, separators=(",", ":"))
    with open(a.mouth_out, "w") as f:
        json.dump({
            "version": "mouth-v1",
            "desc": "per sampled frame k, per face index j (same order as faces.json): "
                    "[mean abs gray diff in mouth ROI, same in eye-band ROI] over frames k+1..k+5, "
                    "ROIs fixed at frame k, 640x360 proxy, 8-bit levels. Speaker proxy = mouth - eyes (or ratio).",
            "stride": STRIDE, "frames": mouth}, f, separators=(",", ":"))
    el = time.time() - t0
    print(f"frames_read={i} detections={n_det} total_s={el:.1f} det_ms={1000*t_det/max(1,n_det):.2f} "
          f"upscale={a.upscale} out={a.out}")


if __name__ == "__main__":
    main()
