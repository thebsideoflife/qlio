"""Shot-cut detectors. usage: detect.py <method|all> [--features F] [--outdir O]"""
import sys, json, os, re, subprocess, argparse, numpy as np
CACHE = os.environ.get("SHOTHOLD_CACHE", "/tmp/shothold")
FPS = 2997 / 125
NF = 60991
PROXY = CACHE + "/proxy.mp4"
OUT = CACHE + "/clock"
if "SHOTHOLD_CACHE" in os.environ:  # other assets: probe fps / frame count from the proxy (Nashville defaults untouched)
    _o = subprocess.run(["ffprobe", "-v", "error", "-count_packets", "-select_streams", "v:0", "-show_entries",
                         "stream=avg_frame_rate,nb_read_packets", "-of", "csv=p=0", PROXY], capture_output=True, text=True).stdout.strip().split(",")
    _a, _b = _o[0].split("/"); FPS = int(_a) / int(_b); NF = int(_o[1])

def write(method, params, cuts, outdir=OUT, extra=None, version="1"):
    d = {"method": method, "version": version, "params": params, "fps": round(FPS, 9), "n_frames": NF,
         "cuts": [int(c) for c in cuts]}
    if extra: d.update(extra)
    json.dump(d, open(os.path.join(outdir, method + ".json"), "w"))
    print(method, len(cuts))
    return d

def iframes():
    fr = []
    for ln in open(CACHE + "/iframes.csv"):
        p = ln.strip().split(",")
        try: fr.append(round(float(p[1]) * FPS))
        except Exception: pass
    write("iframes", {"source": "iframes.csv"}, sorted(set(f for f in fr if f > 0)))

def ffscene():
    txt = os.path.join(OUT, "ffscene_scores.txt")
    if not os.path.exists(txt):
        subprocess.run(["ffmpeg", "-v", "error", "-i", PROXY, "-an", "-vf",
                        "select='gte(scene,0)',metadata=print:file=" + txt, "-f", "null", "-"], check=True)
    sc = np.zeros(NF, np.float64); pts = None
    for ln in open(txt):
        m = re.search(r"pts_time:([\d.]+)", ln)
        if m: pts = float(m.group(1)); continue
        m = re.search(r"scene_score=([\d.]+)", ln)
        if m and pts is not None:
            i = round(pts * FPS)
            if i < NF: sc[i] = float(m.group(1))
    np.save(os.path.join(OUT, "ffscene_scores.npy"), sc)
    for T in (0.2, 0.3, 0.4):
        write("ffscene-%.1f" % T, {"threshold": T, "input": "proxy 640x360"}, np.nonzero(sc > T)[0])

def pyscene():
    from scenedetect import detect, AdaptiveDetector, ContentDetector
    for name, det, params in (("pyscene-adaptive", AdaptiveDetector(), {"detector": "AdaptiveDetector defaults"}),
                              ("pyscene-content", ContentDetector(threshold=27), {"detector": "ContentDetector", "threshold": 27})):
        sc = detect(PROXY, det)
        cuts = [s[0].frame_num for s in sc][1:]
        write(name, dict(params, scenedetect="0.7.1"), cuts)

HP = dict(w_mad=0.5, mad_norm=30.0, w_hist=0.5, floor=0.25, K=2.5, bg_pct=50, radius=12, excl=1, min_gap=6, first_frac=0.7,
          same_ncc=0.8, same_dx=10.0, same_offsets=(2, 5),
          grad_lag=16, grad_min_d=25.0, grad_resid=0.45, grad_max_step=0.10, grad_max_ncc=0.4)

def score_of(F, p=HP):
    return (p["w_mad"] * np.minimum(F["mad"] / p["mad_norm"], 1.0) + p["w_hist"] * F["hbha"]).astype(np.float64)

def ncc_dx(a, b):
    dx = float(np.abs(a - b).mean()); a = a - a.mean(); b = b - b.mean()
    return float((a * b).sum() / (np.sqrt(float((a * a).sum()) * float((b * b).sum())) + 1e-6)), dx

def hist_adaptive(F, p=HP):
    s = score_of(F, p); n = len(s); r = p["radius"]; e = p["excl"]
    T = F["thumbs"].astype(np.float32).reshape(n, -1)
    cand = []
    for i in range(3, n - 1):
        if s[i] < p["floor"]: continue
        nb = np.concatenate([s[max(1, i - r):i - e], s[i + e + 1:min(n, i + r + 1)]])
        bg = float(np.percentile(nb, p["bg_pct"])) if len(nb) else 0.0
        if s[i] < p["K"] * bg: continue
        # flash / same-picture rejection: frame before must not reappear just after
        same = False
        for o in p["same_offsets"]:
            if i + o < n:
                c, dx = ncc_dx(T[i - 2], T[i + o])
                if c > p["same_ncc"] and dx < p["same_dx"]: same = True
        if not same: cand.append(i)
    groups = []
    for c in cand:
        if groups and c - groups[-1][-1] < p["min_gap"]: groups[-1].append(c)
        else: groups.append([c])
    cuts = []
    for g in groups:  # earliest frame of the cluster that is within first_frac of the cluster max (2-frame blended cuts -> first frame)
        mx = max(s[x] for x in g); cuts.append(next(x for x in g if s[x] >= p["first_frac"] * mx))
    L = p["grad_lag"]; cs = np.array(cuts); flag = np.zeros(n, bool)
    for i in range(0, n - L):
        if s[i + 1:i + L + 1].max() > p["grad_max_step"]: continue
        a, b = T[i], T[i + L]; c, d = ncc_dx(a, b)
        if d < p["grad_min_d"] or c > p["grad_max_ncc"]: continue
        m = T[i + L // 2]; ab = a - b; den = float(ab @ ab)
        al = float((m - b) @ ab) / den if den > 0 else 0.5
        resid = np.abs(m - (al * a + (1 - al) * b)).mean() / d
        if resid < p["grad_resid"] and 0.2 < al < 0.8: flag[i] = True
    grad = []; i = 0
    while i < n:
        if flag[i]:
            j = i
            while j + 1 < n and flag[j + 1]: j += 1
            st, en = (i + j) // 2, (i + j) // 2 + L
            if not len(cs) or np.abs(cs - (st + en) // 2).min() > L: grad.append([int(st), int(en)])
            i = j + 1
        else: i += 1
    allc = sorted(set(cuts) | set((g[0] + g[1]) // 2 for g in grad))
    return allc, grad, cuts

def ours(features=os.path.join(OUT, "features.npz"), outdir=OUT):
    F = dict(np.load(features))
    allc, grad, hard = hist_adaptive(F)
    write("hist-adaptive-v1", HP, allc, outdir, {"gradual": grad, "hard_cuts": [int(c) for c in hard]}, version="1.1")

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("method"); ap.add_argument("--features", default=os.path.join(OUT, "features.npz")); ap.add_argument("--outdir", default=OUT)
    a = ap.parse_args()
    if a.method in ("iframes", "all"): iframes()
    if a.method in ("ffscene", "all"): ffscene()
    if a.method in ("pyscene", "all"): pyscene()
    if a.method in ("ours", "all"): ours(a.features, a.outdir)
