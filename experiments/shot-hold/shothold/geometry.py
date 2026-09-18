"""Crop geometry. Python mirror of zeevee/src/lib/zoomMath.ts for a landscape
source (aspect S) in a taller canvas (aspect C), S >= C.

All x coordinates are normalised to the source width, [0, 1].

  scale  = 1 + zoom * (S/C - 1)
  width  = 1 / scale                      visible fraction of source width
  left   = focusX * (1 - width)           Remotion pan: -(focusX-0.5)*overflow
"""

from __future__ import annotations

import os

# Source aspect is per asset (the second test asset is ~4:3). SHOTHOLD_SOURCE_ASPECT=1.3625 overrides.
SOURCE_ASPECT = float(os.environ.get("SHOTHOLD_SOURCE_ASPECT", 16 / 9))
CANVAS_ASPECT = 9 / 16
SCALE_COVER = max(SOURCE_ASPECT / CANVAS_ASPECT, 1.0001)  # 3.1605 for 16:9

# Named zoom stops. TIGHT is the 9:16 fill. Values match ZOOM_LEVEL_MAP and the
# editor's aspect snaps (3:4 -> 0.635, 1:1 -> 0.36).
TIGHT = 1.0


def window_width(zoom: float) -> float:
    return 1.0 / (1.0 + zoom * (SCALE_COVER - 1.0))


def zoom_for_width(width: float) -> float:
    width = min(1.0, max(window_width(1.0), width))
    return (1.0 / width - 1.0) / (SCALE_COVER - 1.0)


def window(zoom: float, focus_x: float) -> tuple[float, float]:
    """(left, right) of the visible window in source-normalised x."""
    w = window_width(zoom)
    left = focus_x * (1.0 - w)
    return left, left + w


def focus_for_center(center_x: float, zoom: float) -> float:
    """focusX that puts the window centre at center_x (clamped to the frame)."""
    w = window_width(zoom)
    if w >= 1.0:
        return 0.5
    return min(1.0, max(0.0, (center_x - w / 2.0) / (1.0 - w)))


def zoom_stops() -> list[float]:
    """The only zoom values the policy may emit: 9:16, 3:4 and 1:1 windows for this source aspect
    (the editor's own aspect snaps), so the letterbox bars have three positions, not a continuum."""
    return [TIGHT] + [round(zoom_for_width(a / SOURCE_ASPECT), 4) for a in (3 / 4, 1.0) if a / SOURCE_ASPECT < 1.0]


def crop_iou(a: tuple[float, float], b: tuple[float, float]) -> float:
    """1-D IoU of two (zoom, focusX) crops. Heights differ with zoom but the
    source is always full-height visible when S >= C, so x-overlap is the crop."""
    al, ar = window(*a)
    bl, br = window(*b)
    inter = max(0.0, min(ar, br) - max(al, bl))
    union = max(ar, br) - min(al, bl)
    return inter / union if union > 0 else 0.0
