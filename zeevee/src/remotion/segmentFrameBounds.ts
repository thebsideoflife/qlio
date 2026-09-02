import {
  frameIndex,
  frameToTime,
  resolveFramingAtFrame,
} from "./framingInterpolation";
import type { FramingKeyframe } from "./types";

/**
 * Half-open source-time range [startSec, endSec) → composition frame indices.
 *
 * Always use `endFrame - startFrame` for duration — never `frameIndex(end-start)`,
 * which can disagree by one frame when bounds sit off the grid.
 */
export function segmentFrameBounds(
  startSec: number,
  endSec: number,
  fps: number,
): {
  startFrame: number;
  endFrame: number;
  durationInFrames: number;
  durationSec: number;
} {
  const startFrame = frameIndex(startSec, fps);
  const endFrame = Math.max(startFrame + 1, frameIndex(endSec, fps));
  const durationInFrames = endFrame - startFrame;
  return {
    startFrame,
    endFrame,
    durationInFrames,
    durationSec: frameToTime(durationInFrames, fps),
  };
}

/**
 * Clip-local frame for a source clock time.
 * Never use `frameIndex(sourceTime - startSec)` — that can be one frame off
 * when `startSec` sits between source frames.
 */
export function sourceTimeToClipFrame(
  sourceTime: number,
  startSec: number,
  fps: number,
): number {
  return Math.max(0, frameIndex(sourceTime, fps) - frameIndex(startSec, fps));
}

/** Source-clock time of clip-local frame 0, 1, 2, … */
export function clipFrameToSourceTime(
  clipFrame: number,
  startSec: number,
  fps: number,
): number {
  return frameToTime(frameIndex(startSec, fps) + clipFrame, fps);
}

/**
 * Stored keyframe time is seconds from `segment.startTime`. Convert to the
 * clip frame Remotion actually renders (origin = nearest source frame).
 */
export function storedTimeToClipFrame(
  relativeSec: number,
  startSec: number,
  fps: number,
): number {
  return sourceTimeToClipFrame(startSec + relativeSec, startSec, fps);
}

/**
 * Rebase segment-relative framing keyframes onto a clip whose t=0 is source
 * frame `clipStartFrame`. Absolute source frames are preserved.
 */
export function rebaseFramingKeyframesToClip(
  keyframes: FramingKeyframe[] | undefined,
  segmentStartSec: number,
  clipStartFrame: number,
  fps: number,
): FramingKeyframe[] | undefined {
  if (!keyframes?.length) return keyframes;

  const rebased = keyframes
    .map((kf) => {
      const clipFrame = Math.max(
        0,
        frameIndex(segmentStartSec + kf.time, fps) - clipStartFrame,
      );
      return { ...kf, time: frameToTime(clipFrame, fps) };
    })
    .sort((a, b) => a.time - b.time);

  const deduped: FramingKeyframe[] = [];
  for (const kf of rebased) {
    const frame = frameIndex(kf.time, fps);
    const prev = deduped[deduped.length - 1];
    if (prev && frameIndex(prev.time, fps) === frame) {
      deduped[deduped.length - 1] = kf;
    } else {
      deduped.push(kf);
    }
  }

  if (deduped.length === 0) return deduped;
  if (deduped[0].time !== 0) {
    deduped[0] = { ...deduped[0], time: 0 };
  }
  return deduped;
}

/**
 * Preview/export share this: rebase stored times onto the snapped clip origin,
 * then hold-until-next on the integer clip frame of `sourceTime`.
 */
export function resolveFramingAtSourceTime(
  keyframes: FramingKeyframe[],
  sourceTime: number,
  startSec: number,
  fps: number,
): { focusX: number; focusY: number; zoom: number } {
  const startFrame = frameIndex(startSec, fps);
  const clipFrame = sourceTimeToClipFrame(sourceTime, startSec, fps);
  const rebased =
    rebaseFramingKeyframesToClip(keyframes, startSec, startFrame, fps) ?? [];
  return resolveFramingAtFrame(rebased, clipFrame, fps);
}
