/**
 * Framing geometry — single source of truth for zoom ↔ visible window.
 *
 * The source video (aspect S = width/height) is placed in an output canvas
 * (aspect C). Zoom 0 is contain (full source visible). Zoom 1 is cover
 * (canvas filled), or a 2× digital punch-in when S ≈ C and there is no
 * crop headroom.
 *
 * Pixel model (matches Remotion's contain/cover lerp):
 *
 *   containScale = min(W, H·S) / S
 *   coverScale   = max(W, H·S) / S     (or containScale·2 when S ≈ C)
 *   videoW/H     = lerp(contain, cover, zoom)
 *   window       = video ∩ canvas
 *
 * Closed form for the window aspect R when S ≉ C:
 *
 *   S ≥ C:  R = S / scale     (landscape source in a taller canvas)
 *   S < C:  R = S · scale     (tall source in a wider canvas)
 *   scale   = 1 + zoom · (scaleCover − 1)
 *   scaleCover = max(S/C, C/S)
 *
 * Invert for a target R in [min(S,C), max(S,C)]:
 *
 *   scale = S ≥ C ? S/R : R/S
 *   zoom  = (scale − 1) / (scaleCover − 1)
 *
 * When S ≈ C the visible window is always the canvas (R = C) at every zoom;
 * other snap ratios are unreachable.
 */

export const DEFAULT_SOURCE_ASPECT = 16 / 9;
export const MAX_DIGITAL_ZOOM = 2;

export const ZOOM_SNAP_RATIOS = [
  { label: "16:9", width: 16, height: 9 },
  { label: "3:2", width: 3, height: 2 },
  { label: "4:3", width: 4, height: 3 },
  { label: "1:1", width: 1, height: 1 },
  { label: "4:5", width: 4, height: 5 },
  { label: "3:4", width: 3, height: 4 },
  { label: "9:16", width: 9, height: 16 },
] as const;

const KNOWN_RATIOS: { label: string; aspect: number }[] = [
  { label: "21:9", aspect: 21 / 9 },
  { label: "2.39", aspect: 2.39 },
  { label: "1.85", aspect: 1.85 },
  { label: "16:9", aspect: 16 / 9 },
  { label: "3:2", aspect: 3 / 2 },
  { label: "4:3", aspect: 4 / 3 },
  { label: "1:1", aspect: 1 },
  { label: "4:5", aspect: 4 / 5 },
  { label: "3:4", aspect: 3 / 4 },
  { label: "9:16", aspect: 9 / 16 },
];

export interface ZoomSnap {
  label: string;
  aspect: number;
  zoom: number;
}

export interface FramingGeometry {
  containW: number;
  containH: number;
  coverW: number;
  coverH: number;
  matchesSource: boolean;
}

export interface VisibleWindow {
  width: number;
  height: number;
  aspect: number;
  /** Fraction of canvas height occupied by the video window. Linear in zoom when S ≥ C. */
  fillY: number;
}

/** cover/contain below this ⇒ treat S ≈ C (digital punch-in instead of crop). */
const MATCH_SCALE_EPSILON = 1.01;

export function sourceMatchesCanvas(
  canvasAspect: number,
  sourceAspect: number,
): boolean {
  if (canvasAspect <= 0 || sourceAspect <= 0) return false;
  return (
    Math.max(canvasAspect / sourceAspect, sourceAspect / canvasAspect) <
    MATCH_SCALE_EPSILON
  );
}

export function scaleCoverForCanvas(
  canvasAspect: number,
  sourceAspect: number,
): number {
  if (sourceMatchesCanvas(canvasAspect, sourceAspect)) {
    return MAX_DIGITAL_ZOOM;
  }
  return Math.max(canvasAspect / sourceAspect, sourceAspect / canvasAspect);
}

/** Contain/cover video box sizes in canvas pixels. */
export function framingGeometry(
  canvasW: number,
  canvasH: number,
  sourceAspect: number,
): FramingGeometry {
  const containScale =
    Math.min(canvasW, canvasH * sourceAspect) / sourceAspect;
  const rawCoverScale =
    Math.max(canvasW, canvasH * sourceAspect) / sourceAspect;
  const matchesSource = sourceMatchesCanvas(canvasW / canvasH, sourceAspect);
  const coverScale = matchesSource
    ? containScale * MAX_DIGITAL_ZOOM
    : rawCoverScale;
  return {
    containW: containScale * sourceAspect,
    containH: containScale,
    coverW: coverScale * sourceAspect,
    coverH: coverScale,
    matchesSource,
  };
}

/** Video element size at a zoom, before clipping to the canvas. */
export function videoSizeAtZoom(
  zoom: number,
  canvasW: number,
  canvasH: number,
  sourceAspect: number,
): { width: number; height: number } {
  const g = framingGeometry(canvasW, canvasH, sourceAspect);
  return {
    width: g.containW + zoom * (g.coverW - g.containW),
    height: g.containH + zoom * (g.coverH - g.containH),
  };
}

/**
 * Visible video window inside the canvas at a given zoom.
 * This is the geometric definition every other helper must match.
 */
export function visibleWindow(
  zoom: number,
  canvasW: number,
  canvasH: number,
  sourceAspect: number,
): VisibleWindow {
  const video = videoSizeAtZoom(zoom, canvasW, canvasH, sourceAspect);
  const width = Math.min(video.width, canvasW);
  const height = Math.min(video.height, canvasH);
  return {
    width,
    height,
    aspect: width / height,
    fillY: height / canvasH,
  };
}

export function windowAspectForZoom(
  zoom: number,
  canvasAspect: number,
  sourceAspect: number,
): number {
  const canvasH = 1 / canvasAspect;
  return visibleWindow(zoom, 1, canvasH, sourceAspect).aspect;
}

export function zoomForWindowAspect(
  windowAspect: number,
  canvasAspect: number,
  sourceAspect: number,
): number | null {
  if (sourceMatchesCanvas(canvasAspect, sourceAspect)) {
    return null;
  }

  const lo = Math.min(sourceAspect, canvasAspect);
  const hi = Math.max(sourceAspect, canvasAspect);
  if (windowAspect < lo - 0.001 || windowAspect > hi + 0.001) return null;

  const scaleCover = scaleCoverForCanvas(canvasAspect, sourceAspect);
  const scale =
    sourceAspect >= canvasAspect
      ? sourceAspect / windowAspect
      : windowAspect / sourceAspect;
  const zoom = (scale - 1) / (scaleCover - 1);
  if (zoom < -0.001 || zoom > 1.001) return null;
  return Math.max(0, Math.min(1, zoom));
}

export function labelForAspect(aspect: number): string {
  for (const known of KNOWN_RATIOS) {
    if (Math.abs(known.aspect - aspect) < 0.02) return known.label;
  }
  return aspect.toFixed(2);
}

export function snapsForCanvas(
  canvasAspect: number,
  sourceAspect: number,
): ZoomSnap[] {
  const snaps: ZoomSnap[] = [];
  for (const ratio of ZOOM_SNAP_RATIOS) {
    const aspect = ratio.width / ratio.height;
    const zoom = zoomForWindowAspect(aspect, canvasAspect, sourceAspect);
    if (zoom === null) continue;
    snaps.push({ label: ratio.label, aspect, zoom });
  }
  snaps.sort((a, b) => a.zoom - b.zoom);
  return snaps.filter(
    (s, i) => i === 0 || Math.abs(s.zoom - snaps[i - 1].zoom) >= 0.01,
  );
}

export function formatWindowAspect(
  zoom: number,
  canvasAspect: number,
  sourceAspect: number,
): string {
  return labelForAspect(windowAspectForZoom(zoom, canvasAspect, sourceAspect));
}

/**
 * Editor preview model: object-fit contain, then CSS scale from center.
 * Must produce the same visible window as `visibleWindow`.
 */
export function cssContainScaleWindow(
  zoom: number,
  canvasW: number,
  canvasH: number,
  sourceAspect: number,
): VisibleWindow {
  const canvasAspect = canvasW / canvasH;
  const scale =
    1 + zoom * (scaleCoverForCanvas(canvasAspect, sourceAspect) - 1);
  const containScale =
    Math.min(canvasW, canvasH * sourceAspect) / sourceAspect;
  const imgW = containScale * sourceAspect * scale;
  const imgH = containScale * scale;
  const width = Math.min(imgW, canvasW);
  const height = Math.min(imgH, canvasH);
  return {
    width,
    height,
    aspect: width / height,
    fillY: height / canvasH,
  };
}

/**
 * Editor preview transform: object-fit contain, then translate + scale from
 * center. Translate is in % of the canvas (applied after scale) and matches
 * Remotion's `-(focus − 0.5) * overflow` pan.
 */
export function cssContainTransform(
  zoom: number,
  canvasAspect: number,
  sourceAspect: number,
  focusX: number,
  focusY: number,
): { scale: number; translateX: number; translateY: number } {
  const scale =
    1 + zoom * (scaleCoverForCanvas(canvasAspect, sourceAspect) - 1);
  const videoAspectInContainer = sourceAspect / canvasAspect;
  return {
    scale,
    translateX:
      videoAspectInContainer >= 1
        ? -(focusX - 0.5) * (scale - 1) * 100
        : 0,
    translateY:
      videoAspectInContainer <= 1
        ? -(focusY - 0.5) * (scale - 1) * 100
        : 0,
  };
}
