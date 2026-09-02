/**
 * Hold-until-next framing on the source frame grid.
 *
 * Run: npx tsx --tsconfig tsconfig.app.json src/remotion/framingInterpolation.test.ts
 */
import type { FramingKeyframe } from "./types";
import {
  frameIndex,
  frameToTime,
  resolveFramingAtFrame,
  resolveFramingAtTime,
  resolveKeyframeAtTime,
  snapTimeToFrame,
} from "./framingInterpolation";
import { canonicalizeFps } from "../lib/sourceFps";
import { segmentFrameBounds } from "./segmentFrameBounds";

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
  assert(frameToTime(30, 30) === 1, "frame 30 at 30fps is 1s");
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
  assert(
    resolveFramingAtFrame(keyframes, 29, 30).zoom === 0,
    "integer frame N-1 keeps a",
  );
  assert(
    resolveFramingAtFrame(keyframes, 30, 30).zoom === 1,
    "integer frame N starts b",
  );
}

{
  // Exhaustive adjacent-frame walk: every composition frame maps, no default/fit flash.
  const fps = 30;
  const walk = [kf("a", 0, 0.2), kf("b", frameToTime(12, fps), 0.8)];
  for (let frame = 0; frame < 24; frame++) {
    const framing = resolveFramingAtFrame(walk, frame, fps);
    const expected = frame < 12 ? 0.2 : 0.8;
    assert(
      framing.zoom === expected,
      `frame ${frame} holds zoom ${expected}, got ${framing.zoom}`,
    );
    assert(
      framing.focusX === 0.5 && framing.focusY === 0.5,
      `frame ${frame} keeps focus`,
    );
  }
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

{
  // Old 0.1s keyframe still resolves to the same nearest frame.
  const fps = 24000 / 1001;
  const oldTime = 10.3;
  const snapped = snapTimeToFrame(oldTime, fps);
  assert(
    resolveFramingAtTime([kf("a", 0, 0), kf("b", oldTime, 1)], oldTime, fps)
      .zoom === 1,
    "legacy 0.1s cut still activates on its nearest frame",
  );
  assert(
    resolveFramingAtTime([kf("a", 0, 0), kf("b", snapped, 1)], snapped, fps)
      .zoom === 1,
    "canonical n/fps cut activates on the same frame",
  );
  assert(
    frameIndex(oldTime, fps) === frameIndex(snapped, fps),
    "legacy and snapped times share a frame index",
  );
}

{
  const fps = 30;
  // Counterexample: frameIndex(end-start) disagrees with endFrame-startFrame.
  assert(frameIndex(10.034 - 5.017, fps) === 151, "old duration formula is 151");
  const bounds = segmentFrameBounds(5.017, 10.034, fps);
  assert(bounds.startFrame === 151, "startFrame is round(5.017*30)");
  assert(bounds.endFrame === 301, "endFrame is round(10.034*30)");
  assert(bounds.durationInFrames === 150, "canonical duration is end-start");
  assert(
    bounds.durationInFrames !== frameIndex(10.034 - 5.017, fps),
    "canonical duration differs from frameIndex(end-start)",
  );

  const a = segmentFrameBounds(0, 5, fps);
  const b = segmentFrameBounds(5, 10, fps);
  assert(a.endFrame === b.startFrame, "adjacent segments share the boundary frame");
  assert(a.durationInFrames === 150, "0→5s is 150 frames at 30fps");
  assert(b.durationInFrames === 150, "5→10s is 150 frames at 30fps");

  const clip = segmentFrameBounds(0, 3, fps);
  assert(clip.startFrame === 0, "export clip starts at frame 0");
  assert(clip.endFrame === 90, "export clip ends at frame 90");
  assert(clip.durationInFrames === 90, "export clip duration matches endFrame");

  const film = 24000 / 1001;
  const nash = segmentFrameBounds(1142.6712427132334, 1248.4037757443318, film);
  assert(nash.durationInFrames > 0, "nashville-style off-grid bounds stay positive");
  assert(
    nash.durationInFrames === nash.endFrame - nash.startFrame,
    "nashville duration is always end-start",
  );
}

{
  // Integer arrow stepping does not drift across many presses.
  for (const fps of [24, 30, 24000 / 1001]) {
    let frame = 100;
    for (let i = 0; i < 50; i++) frame += 1;
    for (let i = 0; i < 50; i++) frame -= 1;
    assert(frame === 100, `arrow stepping returns to origin at ${fps}fps`);
    const t = frameToTime(frame, fps);
    assert(frameIndex(t, fps) === 100, `time round-trip stays on frame 100 at ${fps}`);
  }
}

console.log(
  failures === 0
    ? `framingInterpolation: ${checks} checks passed`
    : `framingInterpolation: ${failures}/${checks} failed`,
);
if (failures > 0) process.exit(1);
