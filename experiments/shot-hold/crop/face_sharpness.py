"""Per-face focus score for every sampled frame with two or more faces. One sequential proxy pass.

Why: both human "wrong face" crop labels (25532, 46732) kept a face the camera had thrown out of focus.
Shallow depth of field is how drama marks its subject, so focus is a cue the central-face rule lacks.

  focus = high-frequency energy of the face crop (Laplacian, 48x48 grey) / its contrast
Contrast-normalised so a dark face and a lit face compare; resized so size alone does not win.
Output $CACHE/face_sharp.json {frame: [focus per face, same order as faces.json]}.
"""
import json, os, sys
import numpy as np, cv2

CACHE = os.environ.get("SHOTHOLD_CACHE", "/tmp/shothold")
cv2.setNumThreads(1)


def focus(gray, box):
    H, W = gray.shape
    x, y, w, h = box[:4]
    # inner face only (eyes to mouth); hair and background edges would otherwise dominate
    x0, x1 = int((x + 0.15 * w) * W), int((x + 0.85 * w) * W)
    y0, y1 = int((y + 0.2 * h) * H), int((y + 0.85 * h) * H)
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    c = cv2.resize(gray[max(0, y0):y1, max(0, x0):x1], (48, 48), interpolation=cv2.INTER_AREA).astype(np.float32)
    return float(cv2.Laplacian(c, cv2.CV_32F).var() / (c.var() + 25.0))


def main():
    faces = {int(k): v for k, v in json.load(open(CACHE + "/faces.json"))["frames"].items()}
    want = {f for f, v in faces.items() if len(v) >= 2}
    cap = cv2.VideoCapture(CACHE + "/proxy.mp4")
    out, i = {}, 0
    last = max(want)
    while i <= last:
        ok, fr = cap.read()
        if not ok:
            break
        if i in want:
            g = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY)
            out[i] = [focus(g, b) for b in faces[i]]
        i += 1
        if i % 10000 == 0:
            print(i, file=sys.stderr)
    json.dump({"version": "focus-v1", "frames": out}, open(CACHE + "/face_sharp.json", "w"))
    print("frames", len(out))


if __name__ == "__main__":
    main()
