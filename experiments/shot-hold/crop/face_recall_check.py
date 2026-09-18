"""Small-face recall check: proxy 640x360 vs proxy-2x-upscaled vs master 1280x720 on 12+12 sampled frames."""
import json
import os
import random
import subprocess

import cv2

from face_cache import PROXY, detect_norm, make_detector

MASTER = "/tmp/shothold/master.mp4"
OUT = "/tmp/shothold/recall_check"
FPS = 24000 / 1001

os.makedirs(OUT, exist_ok=True)
fr = json.load(open("/tmp/shothold/faces.json"))["frames"]
keys = sorted(fr, key=int)
rng = random.Random(0)
zero = rng.sample([k for k in keys if not fr[k]], 12)
some = rng.sample([k for k in keys if fr[k]], 12)

det_hi = make_detector(1280, 720)
det_lo = make_detector(640, 360)
cap = cv2.VideoCapture(PROXY)
res = []
for grp, ks in (("zero", zero), ("some", some)):
    for k in sorted(ks, key=int):
        i = int(k)
        png = f"{OUT}/m_{i}.png"
        if not os.path.exists(png):
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{i / FPS:.6f}", "-i", MASTER,
                            "-frames:v", "1", "-vf", "scale=1280:720:flags=area", png], check=True)
        hi = detect_norm(det_hi, cv2.imread(png))
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, pf = cap.read()
        lo = detect_norm(det_lo, pf)
        up = detect_norm(det_hi, cv2.resize(pf, (1280, 720), interpolation=cv2.INTER_CUBIC))
        r = {"grp": grp, "frame": i, "cache": len(fr[k]), "proxy": len(lo), "proxy2x": len(up), "master720": len(hi),
             "hi_faces_h_score": [(f[3], f[4]) for f in hi], "up_faces_h_score": [(f[3], f[4]) for f in up]}
        res.append(r)
        print(r)
json.dump(res, open(f"{OUT}/result.json", "w"), indent=1)
for grp in ("zero", "some"):
    g = [r for r in res if r["grp"] == grp]
    print(grp, "frames where master720 > cache:", sum(r["master720"] > r["cache"] for r in g), "/", len(g),
          "| proxy2x > cache:", sum(r["proxy2x"] > r["cache"] for r in g),
          "| master720 < cache:", sum(r["master720"] < r["cache"] for r in g))
