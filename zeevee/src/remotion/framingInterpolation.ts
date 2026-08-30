import type { FramingKeyframe } from "./types";

export function frameIndex(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

/**
 * Canonical placement time: the clip frame nearest `seconds`.
 * t=0 is segment start — the same clock Remotion uses. Without fps, pass through.
 */
export function snapTimeToFrame(
  seconds: number,
  fps: number | null,
): number {
  if (fps == null || !(fps > 0) || !Number.isFinite(seconds)) return seconds;
  return frameIndex(seconds, fps) / fps;
}

export function sameFrame(
  a: number,
  b: number,
  fps: number | null,
): boolean {
  if (fps == null || !(fps > 0)) return Math.abs(a - b) < 1e-6;
  return frameIndex(a, fps) === frameIndex(b, fps);
}

/**
 * Hold-until-next: the last keyframe whose time is ≤ playhead.
 * Compares on an integer frame grid when `fps` is known; otherwise seconds.
 */
export function resolveKeyframeAtTime(
  keyframes: FramingKeyframe[],
  timeInSegment: number,
  fps: number | null,
): FramingKeyframe | null {
  if (keyframes.length === 0) return null;

  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  const useFrames = fps != null && fps > 0;
  const t = useFrames ? frameIndex(timeInSegment, fps) : timeInSegment;

  let active = sorted[0];
  for (const kf of sorted) {
    const kfT = useFrames ? frameIndex(kf.time, fps) : kf.time;
    if (kfT <= t) {
      active = kf;
    } else {
      break;
    }
  }

  return active;
}

export function resolveFramingAtTime(
  keyframes: FramingKeyframe[],
  timeInSegment: number,
  fps: number | null,
): { focusX: number; focusY: number; zoom: number } {
  const active = resolveKeyframeAtTime(keyframes, timeInSegment, fps);
  if (!active) {
    return { focusX: 0.5, focusY: 0.5, zoom: 0.0 };
  }
  return { focusX: active.focusX, focusY: active.focusY, zoom: active.zoom };
}
