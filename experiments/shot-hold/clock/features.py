"""One sequential pass over proxy.mp4 -> per-frame features. Deterministic (no seeking, single thread math)."""
import sys, os, argparse, numpy as np, cv2
CACHE = os.environ.get("SHOTHOLD_CACHE", "/tmp/shothold")
cv2.setNumThreads(1)
ap = argparse.ArgumentParser()
ap.add_argument("--video", default=CACHE + "/proxy.mp4")
ap.add_argument("--out", default=CACHE + "/clock/features.npz")
ap.add_argument("--max-frames", type=int, default=0)
a = ap.parse_args()
cap = cv2.VideoCapture(a.video)
mad, hcor, hbha, ecr, thumbs, cth, luma = [], [], [], [], [], [], []
pg = ph = pe = None
k = np.ones((3, 3), np.uint8)
i = 0
while True:
    ok, f = cap.read()
    if not ok or (a.max_frames and i >= a.max_frames):
        break
    g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
    g64 = cv2.resize(g, (64, 36), interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(cv2.resize(f, (160, 90), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2HSV)
    h = cv2.calcHist([hsv], [0, 1, 2], None, [16, 8, 8], [0, 180, 0, 256, 0, 256])
    h = (h / h.sum()).astype(np.float32)
    e = cv2.Canny(cv2.resize(g, (160, 90), interpolation=cv2.INTER_AREA), 50, 150) > 0
    if pg is None:
        mad.append(0.0); hcor.append(0.0); hbha.append(0.0); ecr.append(0.0)
    else:
        mad.append(float(np.mean(np.abs(g64.astype(np.int16) - pg.astype(np.int16)))))
        hcor.append(1.0 - float(cv2.compareHist(ph, h, cv2.HISTCMP_CORREL)))
        hbha.append(float(cv2.compareHist(ph, h, cv2.HISTCMP_BHATTACHARYYA)))
        de = cv2.dilate(e.astype(np.uint8), k) > 0
        dpe = cv2.dilate(pe.astype(np.uint8), k) > 0
        n1, n0 = max(int(e.sum()), 1), max(int(pe.sum()), 1)
        ecr.append(max(float((e & ~dpe).sum()) / n1, float((pe & ~de).sum()) / n0))
    pg, ph, pe = g64, h, e
    thumbs.append(cv2.resize(g, (32, 18), interpolation=cv2.INTER_AREA))
    cth.append(cv2.resize(f, (16, 9), interpolation=cv2.INTER_AREA))
    luma.append(float(g64.mean()))
    i += 1
    if i % 10000 == 0:
        print(i, file=sys.stderr)
np.savez_compressed(a.out, mad=np.array(mad, np.float32), hcor=np.nan_to_num(np.array(hcor, np.float32)),
                    hbha=np.array(hbha, np.float32), ecr=np.array(ecr, np.float32),
                    luma=np.array(luma, np.float32), thumbs=np.array(thumbs, np.uint8), cthumbs=np.array(cth, np.uint8))
print("frames", i)
