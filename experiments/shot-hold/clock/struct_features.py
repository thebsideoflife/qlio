"""Second sequential pass over proxy.mp4 -> lighting-invariant structure similarity per frame.

Human review: every clock false positive was a stage-light or gain change on an unchanged composition
(8 of 8 denied suspicious / hist-only cuts). Histograms and luma differences see a light change as a cut.
The gradient FIELD (direction of edges, not their strength) survives a light change and does not survive
a camera cut. Per frame i, against frames i-1 and i-2 (skips a one-frame blend):

  gcos1[i], gcos2[i]  cosine similarity of the two frames' Sobel gradient fields, 128x72 grey, each frame
                      contrast-normalised first; |dot| so a polarity flip (light behind vs in front) still counts.
  gcell1[i]           same, per 4x4 grid cell, then the 25th percentile over cells: a local match everywhere,
                      not a global average that one bright flare can dominate.

Deterministic, single thread. ~90 s on the Nashville proxy.
"""
import argparse, os, sys
import numpy as np, cv2

CACHE = os.environ.get("SHOTHOLD_CACHE", "/tmp/shothold")
cv2.setNumThreads(1)


def grad(g):
    g = cv2.GaussianBlur(g.astype(np.float32), (3, 3), 0)
    g = (g - g.mean()) / (g.std() + 1.0)
    return cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)


def gcos(a, b, cells=4):
    ax, ay = a; bx, by = b
    dot = np.abs(ax * bx + ay * by)
    na, nb = ax * ax + ay * ay, bx * bx + by * by
    glob = float(dot.sum() / (np.sqrt(na.sum() * nb.sum()) + 1e-6))
    H, W = ax.shape; h, w = H // cells, W // cells
    loc = []
    for r in range(cells):
        for c in range(cells):
            s = (slice(r * h, (r + 1) * h), slice(c * w, (c + 1) * w))
            den = np.sqrt(na[s].sum() * nb[s].sum())
            if den > 1e-3 * h * w:  # skip flat cells (black, sky): no structure to compare
                loc.append(float(dot[s].sum() / den))
    return glob, (float(np.percentile(loc, 25)) if loc else glob)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", default=CACHE + "/proxy.mp4")
    ap.add_argument("--out", default=CACHE + "/clock/struct.npz")
    a = ap.parse_args()
    cap = cv2.VideoCapture(a.video)
    g1, g2, c1 = [], [], []
    hist = []
    i = 0
    while True:
        ok, f = cap.read()
        if not ok:
            break
        gr = grad(cv2.resize(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY), (128, 72), interpolation=cv2.INTER_AREA))
        if hist:
            x, y = gcos(hist[-1], gr); g1.append(x); c1.append(y)
            g2.append(gcos(hist[-2], gr)[0] if len(hist) > 1 else x)
        else:
            g1.append(1.0); c1.append(1.0); g2.append(1.0)
        hist = (hist + [gr])[-2:]
        i += 1
        if i % 10000 == 0:
            print(i, file=sys.stderr)
    np.savez_compressed(a.out, gcos1=np.array(g1, np.float32), gcos2=np.array(g2, np.float32), gcell1=np.array(c1, np.float32))
    print("frames", i)


if __name__ == "__main__":
    main()
