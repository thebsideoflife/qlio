"""Agreement, I-frame proof, density, self-check, contact sheets, report."""
import json, os, random, itertools, numpy as np, cv2
CACHE = os.environ.get("SHOTHOLD_CACHE", "/tmp/shothold"); OUT = CACHE + "/clock"
L = lambda m: json.load(open(f"{OUT}/{m}.json"))
M = ["iframes", "ffscene-0.2", "ffscene-0.3", "ffscene-0.4", "pyscene-adaptive", "pyscene-content", "hist-adaptive-v1"]
C = {m: np.array(L(m)["cuts"]) for m in M}
ours = L("hist-adaptive-v1"); F = dict(np.load(f"{OUT}/features.npz"))
import sys; sys.path.insert(0, os.path.dirname(__file__)); import detect as D
FPS = D.FPS
GOLD = os.environ.get("SHOTHOLD_GOLD", "" if "SHOTHOLD_CACHE" in os.environ else "/tmp/nashville-gold.json")
s = D.score_of(F); T = F["thumbs"].astype(np.float32); n = len(s)
near = lambda a, x, tol=2: len(a) > 0 and np.abs(a - x).min() <= tol
R = []; P = R.append
P("# Clock bakeoff report\n\n## Counts\n"); P("| method | cuts |\n|---|---|")
for m in M: P(f"| {m} | {len(C[m])} |")
P(f"\nhist-adaptive-v1: {len(ours['hard_cuts'])} hard + {len(ours['gradual'])} gradual\n")
P("## Agreement (row cuts matched within +-2 by column method)\n"); P("| | " + " | ".join(M) + " |\n|" + "---|" * (len(M) + 1))
for a in M: P(f"| {a} ({len(C[a])}) | " + " | ".join(str(sum(near(C[b], x) for x in C[a])) for b in M) + " |")
# consensus
pix = ["ffscene-0.3", "pyscene-adaptive", "hist-adaptive-v1"]
allc = sorted(set(itertools.chain(*[C[m].tolist() for m in pix]))); cons = []
for x in allc:
    if sum(near(C[m], x) for m in pix) >= 2 and not (cons and x - cons[-1] <= 2): cons.append(x)
cons = np.array(cons); I = C["iframes"]
i_on = sum(near(cons, x) for x in I); c_on = sum(near(I, x) for x in cons)
P(f"\n## I-frames vs consensus cuts\nconsensus cuts (>=2 of {pix}): {len(cons)}\n")
P(f"- I-frames coinciding with a consensus cut (+-2): {i_on}/{len(I)} = {i_on/len(I):.1%}")
P(f"- consensus cuts landing on an I-frame (+-2): {c_on}/{len(cons)} = {c_on/len(cons):.1%}")
ex = sum(1 for x in cons if x in set(I.tolist())); P(f"- exact (0 frame) consensus-on-I-frame: {ex}/{len(cons)}")
off = [int(I[np.abs(I - x).argmin()] - x) for x in cons if near(I, x)]; P(f"- offset histogram (iframe - cut): {dict(zip(*[a.tolist() for a in np.unique(off, return_counts=True)]))}")
iv = np.diff(np.concatenate([[0], I])); u, c = np.unique(iv, return_counts=True); top = sorted(zip(c.tolist(), u.tolist()), reverse=True)[:8]
P(f"- I-frame intervals: max={iv.max()}, median={int(np.median(iv))}, most common (count,interval)={top}")
P(f"- non-cut I-frames: {len(I)-i_on}; of those, interval since previous I-frame == max GOP ({iv.max()}): {sum(1 for k,x in enumerate(I) if not near(cons,x) and iv[k]==iv.max())}")
# density
G = json.load(open(GOLD))["segments"] if GOLD else []
P("\n## Density per gold segment (interior cuts)\n"); dm = ["iframes", "ffscene-0.3", "pyscene-adaptive", "hist-adaptive-v1"]
P("| seg | title | dur s | gold holds | " + " | ".join(dm) + " |\n|" + "---|" * (4 + len(dm))); tot = np.zeros(len(dm) + 2)
for g in G:
    a, b = g["startTime"] * FPS, g["endTime"] * FPS; cnt = [int(((C[m] > a) & (C[m] < b)).sum()) for m in dm]
    row = [g["endTime"] - g["startTime"], len(g["keyframes"])] + cnt; tot += row
    P(f"| {g['id']} | {g['title'][:40]} | {row[0]:.1f} | {row[1]} | " + " | ".join(map(str, cnt)) + " |")
P(f"| **total** | | {tot[0]:.1f} | {int(tot[1])} | " + " | ".join(str(int(x)) for x in tot[2:]) + " |")
# self-check
def stats(N):
    A, B = T[max(0, N - 6):N - 1].mean(0), T[N + 1:N + 6].mean(0)
    dx = float(np.abs(A - B).mean()); a, b = A - A.mean(), B - B.mean()
    ncc = float((a * b).sum() / (np.sqrt((a * a).sum() * (b * b).sum()) + 1e-6))
    w = max(float(np.abs(T[max(0, N - 6)] - T[N - 2]).mean()), float(np.abs(T[N + 1] - T[min(n - 1, N + 5)]).mean()))
    return dx, ncc, w
gm = set((g[0] + g[1]) // 2 for g in ours["gradual"]); susp = []
for N in ours["hard_cuts"]:
    dx, ncc, w = stats(N)
    if ncc > 0.8 or dx < 6 or (dx < 1.2 * w and ncc > 0.4): susp.append((N, round(s[N], 3), round(dx, 1), round(ncc, 2), round(w, 1), round(float(F["luma"][N]), 1)))
P(f"\n## Self-check: suspicious hard cuts ({len(susp)} of {len(ours['hard_cuts'])})\nrule: ncc>0.8 or dx<6 or (dx<1.2*within and ncc>0.4)\n\n| frame | t(s) | score | across dx | ncc | within | luma |\n|---|---|---|---|---|---|---|")
for x in susp: P(f"| {x[0]} | {x[0]/FPS:.2f} | {x[1]} | {x[2]} | {x[3]} | {x[4]} | {x[5]} |")
oc = np.array(ours["cuts"]); b = np.concatenate([[0], oc, [n]]); mc = []
for a_, b_ in zip(b[:-1], b[1:]):
    if b_ - a_ > 8 * FPS:
        k = a_ + 8 + int(np.argmax(s[a_ + 8:b_ - 8])); dx, ncc, w = stats(k)
        mc.append((int(k), round(float(s[k]), 3), round(dx, 1), round(ncc, 2), round(w, 1), int(b_ - a_), sum(near(C[m], k) for m in pix[:2])))
mc.sort(key=lambda x: -x[1]); nlong = len(mc); mc = mc[:30]
likely = [x for x in mc if x[2] > 15 and x[3] < 0.6 and x[2] > 2 * x[4]]
P(f"\n## Miss candidates: {nlong} shots > 8 s; top 30 by max interior score; {len(likely)} look like real misses (dx>15, ncc<0.6, dx>2*within)\n\n| frame | t(s) | score | across dx | ncc | within | shot len | other pixel methods agreeing | likely miss |\n|---|---|---|---|---|---|---|---|---|")
for x in mc: P(f"| {x[0]} | {x[0]/FPS:.2f} | {x[1]} | {x[2]} | {x[3]} | {x[4]} | {x[5]} | {x[6]} | {'YES' if x in likely else ''} |")
# pairs
others = ["ffscene-0.3", "pyscene-adaptive", "pyscene-content"]
histonly = [int(x) for x in oc if not any(near(C[m], x) for m in others + ["ffscene-0.2"])]
missed = [int(x) for x in allc if sum(near(C[m], x) for m in pix[:2]) == 2 and not near(oc, x)]
P(f"\n## Disagreements\n- histonly (ours, no other pixel method +-2): {len(histonly)} (of which gradual midpoints: {sum(1 for x in histonly if x in gm)}): {histonly}\n- missedbyours (ffscene-0.3 AND pyscene-adaptive, not ours): {len(missed)}: {missed}")
rnd = random.Random(0); items = [("consensus", int(x)) for x in sorted(rnd.sample(cons.tolist(), 10))]
items += [("histonly", x) for x in histonly[:10]] + [("missedbyours", x) for x in missed[:6]] + [("suspicious", x[0]) for x in susp[:7]] + [("misscand", x[0]) for x in mc[:7]]
os.makedirs(f"{OUT}/pairs", exist_ok=True); [os.remove(f"{OUT}/pairs/{f}") for f in os.listdir(f"{OUT}/pairs")]
cap = cv2.VideoCapture(CACHE + "/proxy.mp4"); bad = 0
def grab(i):
    global bad
    cap.set(cv2.CAP_PROP_POS_FRAMES, i); ok, f = cap.read()
    if np.abs(cv2.resize(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY), (32, 18), interpolation=cv2.INTER_AREA).astype(np.float32) - T[i]).mean() > 1: bad += 1
    return f
for cat, N in items[:40]:
    gr = next((g for g in ours["gradual"] if (g[0] + g[1]) // 2 == N), None)
    a, b_ = (gr[0], gr[1]) if (gr and cat == "histonly") else (N - 1, N)
    img = np.hstack([grab(a), grab(b_)]); cv2.putText(img, f"{cat} {a}|{b_}", (8, 24), 0, 0.7, (0, 255, 255), 2)
    cv2.imwrite(f"{OUT}/pairs/{cat}_{N}.jpg", img)
P(f"\npairs written: {len(items[:40])}; seek-mismatch count: {bad}")
open(f"{OUT}/report.md", "w").write("\n".join(R) + "\n"); print("\n".join(R))
json.dump({"susp": [x[0] for x in susp]}, open(f"{OUT}/_susp.json", "w"))
