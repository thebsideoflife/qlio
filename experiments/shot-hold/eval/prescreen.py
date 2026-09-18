"""Pre-screen montages of crop proposals (sample A: faces, sample B: no face)."""
import glob, json, random, re, collections
import cv2, numpy as np
from shothold.geometry import window

OUT = '/tmp/shothold/eval/prescreen/'
JOB = '/tmp/shothold/job/subject-v3.l2.0c4.0h.json'
W, H = 320, 180


def clause(r):
    c = re.split('[:·]', r)[0].strip()
    return re.sub(r'^\d+ ', 'N ', c)


def still(cap, f, s):
    cap.set(cv2.CAP_PROP_POS_FRAMES, f)
    ok, im = cap.read()
    im = cv2.resize(im, (W, H)) if ok else np.zeros((H, W, 3), np.uint8)
    l, r = window(s['zoom'], s['focusX'])
    l, r = int(round(l * W)), int(round(r * W))
    out = (im * 0.45).astype(np.uint8)
    out[:, l:r] = im[:, l:r]
    cv2.rectangle(out, (l, 1), (r - 1, H - 2), (0, 255, 0), 1)
    return out


def label(im, t):
    cv2.putText(im, t, (4, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 0, 0), 3)
    cv2.putText(im, t, (4, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 255, 255), 1)


def main():
    shots = {int(k): v for k, v in json.load(open(JOB))['shots'].items()}
    excl = set()
    for f in glob.glob('/tmp/shothold/review/batches/*.json'):
        for c in json.load(open(f)).get('cards', []):
            si = (c.get('context') or {}).get('shot_index')
            if si is not None:
                excl.add(int(si))
    ok = {k: v for k, v in shots.items() if k not in excl and v['frames'][1] - v['frames'][0] >= 18}
    rng = random.Random(7)
    strata = collections.defaultdict(list)
    for k, v in sorted(ok.items()):
        if v['n_tracks'] >= 1:
            strata[clause(v['reason'])].append(k)
    names = sorted(strata)
    per = 40 // len(names)
    A = []
    for n in names:
        A += rng.sample(strata[n], min(per, len(strata[n])))
    rest = [k for n in names for k in strata[n] if k not in A]
    A += rng.sample(rest, 40 - len(A))
    A.sort()
    rngb = random.Random(7)
    B = sorted(rngb.sample([k for k, v in sorted(ok.items()) if v['n_tracks'] == 0], 24))
    cap = cv2.VideoCapture('/tmp/shothold/proxy.mp4')
    for p in range(5):
        rows = []
        for k in A[p * 8:(p + 1) * 8]:
            s = shots[k]; a, b = s['frames']
            row = np.hstack([still(cap, f, s) for f in (a + 3, (a + b) // 2, b - 4)])
            label(row, 'S%d z=%.2f fx=%.2f %s' % (k, s['zoom'], s['focusX'], clause(s['reason'])[:40]))
            rows.append(row)
        cv2.imwrite(OUT + 'A%d.jpg' % p, np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 88])
    cells = []
    for k in B:
        s = shots[k]; a, b = s['frames']
        im = still(cap, (a + b) // 2, s); label(im, 'S%d z=%.2f' % (k, s['zoom'])); cells.append(im)
    cv2.imwrite(OUT + 'B.jpg', np.vstack([np.hstack(cells[i * 4:i * 4 + 4]) for i in range(6)]), [cv2.IMWRITE_JPEG_QUALITY, 88])
    json.dump({'A': [{'shot': k, 'clause': clause(shots[k]['reason']), **shots[k]} for k in A],
               'B': [{'shot': k, **shots[k]} for k in B], 'excluded': len(excl)}, open(OUT + 'samples.json', 'w'), indent=1)
    print(len(excl), {n: len(strata[n]) for n in names}); print(A); print(B)


main()
