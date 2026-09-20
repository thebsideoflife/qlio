"""Job layer: attach per-shot crops to an editorial segment WITHOUT moving it.

Inputs are asset-level (cached once per file):
  cuts   : sorted integer source frames N where the picture changes ON frame N
  crops  : {shot_index: (zoom, focusX)}, shot i = [cuts[i-1], cuts[i])
Output is the persisted FramingKeyframe shape: time = seconds from segment
start, such that round((start + time) * fps) == N  (framingInterpolation.ts
frameIndex). Segment startTime / endTime are read, never written.
"""

from __future__ import annotations

import bisect

from .geometry import crop_iou, focus_for_center, window, window_width, zoom_stops


def frame_index(sec: float, fps: float) -> int:
    return round(sec * fps)


def smooth_zoom(
    durs: list[float],
    needs: list[tuple[float, float] | None],
    stops: list[float],
    lam: float,
    *,
    clip_cost: float = 10.0,
    loose_cost: float = 1.0,
    tied: list[bool] | None = None,
) -> list[float]:
    """Pick one zoom stop per shot for a whole segment. Exact DP (Viterbi) over

        sum_i dur_i * (clip_cost * clipped_fraction + loose_cost * wasted_width)  +  lam * (#zoom changes)

    A zoom change moves the letterbox bars, which the viewer sees even on a camera cut;
    a pan on a cut is free. `lam` is seconds of mild looseness we accept to avoid one
    zoom change: THE "less choppy" knob. Shots with no subject (need None) cost nothing at
    any zoom, so they inherit their neighbours' zoom instead of forcing a change. `tied[i]` (an exit
    split inside one camera shot) forbids a zoom change INTO shot i: the bars never move mid-shot."""
    n, k = len(durs), len(stops)
    if n == 0:
        return []
    tight_w = window_width(max(stops))

    def cost(i: int, z: float) -> float:
        if needs[i] is None:
            return 0.0
        need = needs[i][1] - needs[i][0]
        w = window_width(z)
        own = next((q for q, zz in enumerate(stops) if need <= window_width(zz) + 1e-9), len(stops) - 1)
        if stops.index(z) > own + 1:  # smoothing may loosen a shot by ONE stop, never turn a close-up into 1:1
            return 1e9
        if need > w:
            return durs[i] * clip_cost * (need - w) / need
        return durs[i] * loose_cost * (w - max(need, tight_w))

    best = [[0.0] * k for _ in range(n)]
    back = [[0] * k for _ in range(n)]
    for zi in range(k):
        best[0][zi] = cost(0, stops[zi])
    for i in range(1, n):
        for zi in range(k):
            if tied and tied[i]:
                best[i][zi] = best[i - 1][zi] + cost(i, stops[zi])
                back[i][zi] = zi
                continue
            prev = min(range(k), key=lambda pj: (best[i - 1][pj] + (lam if pj != zi else 0.0), pj))
            best[i][zi] = best[i - 1][prev] + (lam if prev != zi else 0.0) + cost(i, stops[zi])
            back[i][zi] = prev
    zi = min(range(k), key=lambda q: (best[-1][q], q))
    out = [0.0] * n
    for i in range(n - 1, -1, -1):
        out[i] = stops[zi]
        zi = back[i][zi]
    return out


def keyframes_for_segment(
    start_sec: float,
    end_sec: float,
    fps: float,
    cuts: list[int],
    crops: dict[int, tuple[float, float]],
    *,
    min_hold_frames: int = 12,
    same_crop_iou: float = 0.9,
    needs: dict[int, tuple[float, float]] | None = None,
    hold_through: bool = False,
    zoom_lambda: float | None = None,
    stops: tuple[float, ...] | None = None,
    loose_cost: float = 1.0,
    tied: set[int] | None = None,
) -> list[dict]:
    """One keyframe at segment open, then one per interior camera cut whose crop
    actually differs. Two density knobs, both thresholds we own:

    min_hold_frames  shots shorter than this inherit the previous hold (flash
                     frames, and slivers left at segment edges).
    same_crop_iou    a cut whose new crop overlaps the current hold this much is
                     not worth a reframe; the hold continues through the cut.
    hold_through     with `needs` (the x-extent each shot's crop must contain): keep the
                     current hold across a cut when it already contains the new shot's
                     subject at the same zoom. Pan only when the subject would be clipped.
    """
    f0 = frame_index(start_sec, fps)
    f1 = max(f0 + 1, frame_index(end_sec, fps))

    def shot_at(frame: int) -> int:
        return bisect.bisect_right(cuts, frame)

    bounds = [f0] + [c for c in cuts if f0 < c < f1] + [f1]
    if zoom_lambda is not None and needs is not None:
        idx = [shot_at(a) for a in bounds[:-1]]
        zs = smooth_zoom([(b - a) / fps for a, b in zip(bounds, bounds[1:])],
                         [needs.get(i) for i in idx], list(stops or zoom_stops()), zoom_lambda, loose_cost=loose_cost,
                         tied=[a in (tied or ()) for a in bounds[:-1]])
        crops = dict(crops)
        for i, z in zip(idx, zs):
            nd = needs.get(i)
            crops[i] = (z, focus_for_center((nd[0] + nd[1]) / 2, z) if nd else 0.5)
    out: list[dict] = []
    current: tuple[float, float] | None = None
    for a, b in zip(bounds, bounds[1:]):
        crop = crops.get(shot_at(a))
        if crop is None:
            continue
        short = (b - a) < min_hold_frames
        if current is not None and (short or crop_iou(current, crop) >= same_crop_iou):
            continue
        if current is not None and hold_through and needs and abs(current[0] - crop[0]) < 1e-6:
            need = needs.get(shot_at(a))
            l, r = window(*current)
            if need is not None and need[0] >= l and need[1] <= r:
                continue
        current = crop
        out.append(
            {
                "time": round(a / fps - start_sec, 6) if a != f0 else 0.0,
                "zoom": round(crop[0], 4),
                "focusX": round(crop[1], 4),
                "focusY": 0.5,
                "ai": True,
                "sourceFrame": a,
            }
        )
    # Guard the frame contract: every keyframe must resolve to its own source frame.
    for k in out[1:]:
        assert frame_index(start_sec + k["time"], fps) == k["sourceFrame"], k
    return out
