/**
 * Half-open segment frame-range contract.
 * Mirrors zeevee/src/remotion/segmentFrameBounds.ts.
 *
 * Run: npx tsx src/utils/segmentFrameBounds.test.ts
 */
import {
  frameIndex,
  frameToTime,
  rebaseFramingKeyframesToClip,
  segmentFrameBounds,
} from "./segmentFrameBounds";

let checks = 0;
let failures = 0;

function assert(condition: boolean, message: string): void {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}

{
  const fps = 30;
  assert(frameIndex(10.034 - 5.017, fps) === 151, "old duration formula is 151");
  const bounds = segmentFrameBounds(5.017, 10.034, fps);
  assert(bounds.durationInFrames === 150, "canonical duration is end-start");
  assert(
    bounds.durationInFrames === bounds.endFrame - bounds.startFrame,
    "duration is always endFrame - startFrame",
  );

  const a = segmentFrameBounds(0, 5, fps);
  const b = segmentFrameBounds(5, 10, fps);
  assert(a.endFrame === b.startFrame, "adjacent ranges share the boundary");
}

{
  const fps = 30;
  const segmentStart = 5.017;
  const bounds = segmentFrameBounds(segmentStart, 10.034, fps);
  // Keyframe intended at absolute frame 200 → relative (200/30 - 5.017)
  const relativeForAbs200 = frameToTime(200, fps) - segmentStart;
  const rebased = rebaseFramingKeyframesToClip(
    [
      { id: "a", time: 0, zoom: 0 },
      { id: "b", time: relativeForAbs200, zoom: 1 },
    ],
    segmentStart,
    bounds.startFrame,
    fps,
  )!;
  assert(rebased[0].time === 0, "opening hold stays at clip frame 0");
  assert(
    frameIndex(rebased[1].time, fps) === 200 - bounds.startFrame,
    "interior cut keeps its absolute source frame on the clip clock",
  );
}

console.log(
  failures === 0
    ? `segmentFrameBounds: ${checks} checks passed`
    : `segmentFrameBounds: ${failures}/${checks} failed`,
);
if (failures > 0) process.exit(1);
