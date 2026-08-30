/**
 * Hold-until-next framing on the source frame grid.
 *
 * Run: npx tsx --tsconfig tsconfig.app.json src/remotion/framingInterpolation.test.ts
 */
import type { FramingKeyframe } from "./types";
import {
  frameIndex,
  resolveFramingAtTime,
  resolveKeyframeAtTime,
  snapTimeToFrame,
} from "./framingInterpolation";
import { canonicalizeFps } from "../lib/sourceFps";

let checks = 0;
let failures = 0;

function assert(condition: boolean, message: string): void {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}

function kf(
  id: string,
  time: number,
  zoom: number,
): FramingKeyframe {
  return {
    id,
    time,
    zoom,
    focusX: 0.5,
    focusY: 0.5,
    isAiGenerated: false,
  };
}

const keyframes = [kf("a", 0, 0), kf("b", 1, 1)];

{
  assert(frameIndex(1, 30) === 30, "1s at 30fps is frame 30");
  assert(frameIndex(0.983, 30) === 29, "0.983s at 30fps is nearest frame 29");
  assert(frameIndex(1, 24000 / 1001) === 24, "1s at 23.976 is frame 24");
}

{
  assert(
    resolveKeyframeAtTime(keyframes, 0, 30)?.id === "a",
    "t=0 holds keyframe a",
  );
  assert(
    resolveFramingAtTime(keyframes, 0.983, 30).zoom === 0,
    "frame before the cut still holds a",
  );
  assert(
    resolveFramingAtTime(keyframes, 1, 30).zoom === 1,
    "cut frame switches to b",
  );
  assert(
    resolveFramingAtTime(keyframes, 1.5, 30).zoom === 1,
    "after the cut holds b",
  );
}

{
  assert(
    resolveFramingAtTime(keyframes, 0.999, null).zoom === 0,
    "without fps, compare in seconds (0.999 < 1)",
  );
  assert(
    resolveFramingAtTime(keyframes, 1, null).zoom === 1,
    "without fps, t=1 switches",
  );
}

{
  assert(canonicalizeFps(23.97) === 24000 / 1001, "23.97 snaps to 23.976");
  assert(canonicalizeFps(23.976023976) === 24000 / 1001, "ffprobe NTSC film");
  assert(canonicalizeFps(24) === 24, "true 24fps is not snapped to 23.976");
  assert(canonicalizeFps(29.97) === 30000 / 1001, "29.97 snaps to NTSC");
  assert(canonicalizeFps(30) === 30, "true 30fps is not snapped to 29.97");
  assert(canonicalizeFps(47.95) === 47.95, "unusual rates pass through");

  const preview = canonicalizeFps(23.97);
  const exportFps = canonicalizeFps(24000 / 1001);
  assert(preview === exportFps, "preview and export share a clock after snap");
  assert(
    frameIndex(62.55, preview) === frameIndex(62.55, exportFps),
    "long-segment cut frames agree after snap",
  );
}

{
  const fps = 24000 / 1001;
  const snapped = snapTimeToFrame(10.3, fps);
  assert(
    frameIndex(snapped, fps) === frameIndex(10.3, fps),
    "snapTimeToFrame preserves nearest clip frame",
  );
  assert(
    snapTimeToFrame(snapped, fps) === snapped,
    "snapTimeToFrame is idempotent",
  );
  assert(
    frameIndex(9.1, fps) !== frameIndex(10.3, fps),
    "1.2s apart stays distinct frames at 23.976",
  );
  assert(snapTimeToFrame(0, fps) === 0, "frame 0 stays at t=0");
  assert(
    snapTimeToFrame(1.01, 30) === snapTimeToFrame(1.0, 30),
    "times within half a frame collapse to the same stored time",
  );
}

console.log(
  failures === 0
    ? `framingInterpolation: ${checks} checks passed`
    : `framingInterpolation: ${failures}/${checks} failed`,
);
if (failures > 0) process.exit(1);
