import type { FramingKeyframe } from "./types";

/** Integer source/clip frame nearest to `seconds`. */
export function frameIndex(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

/** Seconds for an exact integer frame on the clip grid. */
export function frameToTime(frame: number, fps: number): number {
  return frame / fps;
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
  return frameToTime(frameIndex(seconds, fps), fps);
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
 * Hold-until-next on an integer clip frame.
 * Cut frame N keeps the previous keyframe through N-1 and starts the new
 * keyframe on N — nothing in between, no blending.
 */
export function resolveKeyframeAtFrame(
  keyframes: FramingKeyframe[],
  frame: number,
  fps: number,
): FramingKeyframe | null {
  if (keyframes.length === 0) return null;

  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  let active = sorted[0];
  for (const kf of sorted) {
    const kfFrame = frameIndex(kf.time, fps);
    if (kfFrame <= frame) {
      active = kf;
    } else {
      break;
    }
  }
  return active;
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

  if (fps != null && fps > 0) {
    return resolveKeyframeAtFrame(
      keyframes,
      frameIndex(timeInSegment, fps),
      fps,
    );
  }

  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  let active = sorted[0];
  for (const kf of sorted) {
    if (kf.time <= timeInSegment) {
      active = kf;
    } else {
      break;
    }
  }
  return active;
}

export function resolveFramingAtFrame(
  keyframes: FramingKeyframe[],
  frame: number,
  fps: number,
): { focusX: number; focusY: number; zoom: number } {
  const active = resolveKeyframeAtFrame(keyframes, frame, fps);
  if (!active) {
    return { focusX: 0.5, focusY: 0.5, zoom: 0.0 };
  }
  return { focusX: active.focusX, focusY: active.focusY, zoom: active.zoom };
}

export function resolveFramingAtTime(
  keyframes: FramingKeyframe[],
  timeInSegment: number,
  fps: number | null,
): { focusX: number; focusY: number; zoom: number } {
  if (fps != null && fps > 0) {
    return resolveFramingAtFrame(
      keyframes,
      frameIndex(timeInSegment, fps),
      fps,
    );
  }
  const active = resolveKeyframeAtTime(keyframes, timeInSegment, fps);
  if (!active) {
    return { focusX: 0.5, focusY: 0.5, zoom: 0.0 };
  }
  return { focusX: active.focusX, focusY: active.focusY, zoom: active.zoom };
}
