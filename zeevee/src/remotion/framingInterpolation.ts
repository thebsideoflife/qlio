import type { FramingKeyframe } from "./types";

/**
 * Resolve the active framing values at a given time within a segment.
 * Uses hard-cut logic: finds the last keyframe with time <= timeInSegment.
 */
export function resolveFramingAtTime(
  keyframes: FramingKeyframe[],
  timeInSegment: number,
): { focusX: number; focusY: number; zoom: number } {
  if (keyframes.length === 0) {
    return { focusX: 0.5, focusY: 0.5, zoom: 0.0 };
  }

  // Sort by time ascending
  const sorted = [...keyframes].sort((a, b) => a.time - b.time);

  // Find the last keyframe at or before the current time
  let active = sorted[0];
  for (const kf of sorted) {
    if (kf.time <= timeInSegment) {
      active = kf;
    } else {
      break;
    }
  }

  return { focusX: active.focusX, focusY: active.focusY, zoom: active.zoom };
}
