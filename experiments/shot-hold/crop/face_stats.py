"""Summary stats for faces.json. Usage: face_stats.py [faces.json]"""
import json
import sys

import numpy as np

p = sys.argv[1] if len(sys.argv) > 1 else "/tmp/shothold/faces.json"
d = json.load(open(p))
fr = d["frames"]
n = len(fr)
cnt = np.array([len(v) for v in fr.values()])
print("input:", d["input"], "sampled_frames:", n, "total_faces:", int(cnt.sum()))
for k, lab in [(0, "0"), (1, "1"), (2, "2")]:
    print(f"  {lab} faces: {100*(cnt==k).mean():.1f}%")
print(f"  3+ faces: {100*(cnt>=3).mean():.1f}%")
faces = np.array([r for v in fr.values() for r in v])
qs = [1, 5, 10, 25, 50, 75, 90, 95, 99]
h = faces[:, 3]
cx = faces[:, 0] + faces[:, 2] / 2
print("face height (norm) quantiles", dict(zip(qs, np.round(np.percentile(h, qs), 3).tolist())))
print("face centre x quantiles     ", dict(zip(qs, np.round(np.percentile(cx, qs), 3).tolist())))
hist, _ = np.histogram(cx, bins=10, range=(0, 1))
print("centre x hist (10 bins, %)  ", np.round(100 * hist / hist.sum(), 1).tolist())
# largest face per frame
big = np.array([max(r[3] for r in v) for v in fr.values() if v])
print("largest-face height quantiles", dict(zip(qs, np.round(np.percentile(big, qs), 3).tolist())))
print("score quantiles", dict(zip(qs, np.round(np.percentile(faces[:, 4], qs), 3).tolist())))
