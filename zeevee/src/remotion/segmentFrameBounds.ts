import { frameIndex, frameToTime } from "./framingInterpolation";

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
