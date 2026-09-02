/** Integer source/clip frame nearest to `seconds`. */
export function frameIndex(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

/** Seconds for an exact integer frame on the clip grid. */
export function frameToTime(frame: number, fps: number): number {
  return frame / fps;
}

/**
 * Half-open source-time range [startSec, endSec) → composition frame indices.
 *
 * Always use `endFrame - startFrame` for duration — never `frameIndex(end-start)`,
 * which can disagree by one frame when bounds sit off the grid.
 *
 * Mirrors zeevee/src/remotion/segmentFrameBounds.ts.
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

interface FramingKeyframeLike {
  id?: string;
  time: number;
  focusX?: number;
  focusY?: number;
  zoom?: number;
  aiReasoning?: string;
  isAiGenerated?: boolean;
}

/**
 * Rebase segment-relative framing keyframes onto a pre-cut clip whose t=0 is
 * source frame `clipStartFrame`. Absolute source frames are preserved.
 */
export function rebaseFramingKeyframesToClip(
  keyframes: FramingKeyframeLike[] | undefined,
  segmentStartSec: number,
  clipStartFrame: number,
  fps: number,
): FramingKeyframeLike[] | undefined {
  if (!keyframes?.length) return keyframes;

  const rebased = keyframes
    .map((kf) => {
      const absoluteFrame = frameIndex(segmentStartSec + kf.time, fps);
      const clipFrame = Math.max(0, absoluteFrame - clipStartFrame);
      return { ...kf, time: frameToTime(clipFrame, fps) };
    })
    .sort((a, b) => a.time - b.time);

  // Collapse same-frame duplicates, keep the later setting (matches hold-until-next).
  const deduped: FramingKeyframeLike[] = [];
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
