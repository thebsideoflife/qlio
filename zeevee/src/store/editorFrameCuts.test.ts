/**
 * Frame-editing reducer invariants for exact framing cuts.
 *
 * Run: npx tsx --tsconfig tsconfig.app.json src/store/editorFrameCuts.test.ts
 */
import { configureStore } from "@reduxjs/toolkit";
import {
  editorSlice,
  addFramingKeyframe,
  updateFramingKeyframe,
  setSegments,
  setSourceFps,
  type Segment,
} from "./editorSlice";
import type { FramingKeyframe } from "@/remotion/types";
import { frameIndex, frameToTime, sameFrame } from "@/remotion/framingInterpolation";
import { getEffectiveKeyframes } from "@/remotion/types";

let checks = 0;
let failures = 0;

function assert(condition: boolean, message: string): void {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}

function makeStore(fps: number | null) {
  const store = configureStore({
    reducer: { editor: editorSlice.reducer },
  });
  const segment: Segment = {
    id: "seg-1",
    startTime: 10,
    endTime: 20,
    title: "Test",
    description: "",
    characters: [],
    sceneTags: [],
    keyDialogue: "",
    confidence: 1,
    framing: {
      aspectRatio: "9:16",
      mode: "crop",
      focusX: 0.5,
      focusY: 0.5,
      isAiGenerated: false,
      keyframes: [
        {
          id: "kf-0",
          time: 0,
          focusX: 0.5,
          focusY: 0.5,
          zoom: 1,
          isAiGenerated: false,
        },
      ],
    },
  };
  store.dispatch(setSegments([segment]));
  store.dispatch(setSourceFps(fps));
  return store;
}

function keyframes(store: ReturnType<typeof makeStore>): FramingKeyframe[] {
  const seg = store.getState().editor.segments[0];
  return getEffectiveKeyframes(seg.framing!);
}

for (const fps of [24, 30, 24000 / 1001] as const) {
  const store = makeStore(fps);
  const cutFrame = 12;
  const cutTime = frameToTime(cutFrame, fps);

  store.dispatch(
    addFramingKeyframe({
      segmentId: "seg-1",
      keyframe: {
        id: "kf-cut",
        time: cutTime + 0.001,
        focusX: 0.2,
        focusY: 0.5,
        zoom: 0.4,
        isAiGenerated: false,
      },
    }),
  );

  const afterAdd = keyframes(store);
  assert(afterAdd.length === 2, `${fps}fps: add creates second keyframe`);
  assert(
    frameIndex(afterAdd[1].time, fps) === cutFrame,
    `${fps}fps: cut snaps to integer frame ${cutFrame}`,
  );
  assert(
    afterAdd[0].time === 0,
    `${fps}fps: opening hold stays at frame 0`,
  );

  // Duplicate frame rejected
  store.dispatch(
    addFramingKeyframe({
      segmentId: "seg-1",
      keyframe: {
        id: "kf-dup",
        time: cutTime,
        focusX: 0.9,
        focusY: 0.5,
        zoom: 1,
        isAiGenerated: false,
      },
    }),
  );
  assert(
    keyframes(store).length === 2,
    `${fps}fps: duplicate frame is rejected`,
  );

  // Move to adjacent frame
  const nextTime = frameToTime(cutFrame + 1, fps);
  store.dispatch(
    updateFramingKeyframe({
      segmentId: "seg-1",
      keyframeId: "kf-cut",
      changes: { time: nextTime },
    }),
  );
  assert(
    frameIndex(keyframes(store)[1].time, fps) === cutFrame + 1,
    `${fps}fps: move lands on adjacent frame`,
  );

  // Opening keyframe cannot leave frame 0
  store.dispatch(
    updateFramingKeyframe({
      segmentId: "seg-1",
      keyframeId: "kf-0",
      changes: { time: nextTime },
    }),
  );
  assert(
    keyframes(store)[0].time === 0,
    `${fps}fps: first keyframe stays pinned at 0`,
  );

  // Crossing / same-frame move rejected
  store.dispatch(
    updateFramingKeyframe({
      segmentId: "seg-1",
      keyframeId: "kf-cut",
      changes: { time: 0 },
    }),
  );
  assert(
    !sameFrame(keyframes(store)[1].time, 0, fps),
    `${fps}fps: interior cut cannot collapse onto frame 0`,
  );
}

{
  // Off-grid segment bounds: durationInFrames can be one less than
  // frameIndex(end-start). Interior cuts must stay inside the renderable range.
  const fps = 30;
  const store = makeStore(fps);
  store.dispatch(
    setSegments([
      {
        id: "seg-offgrid",
        startTime: 5.017,
        endTime: 10.034,
        title: "Off grid",
        description: "",
        characters: [],
        sceneTags: [],
        keyDialogue: "",
        confidence: 1,
        framing: {
          aspectRatio: "9:16",
          mode: "crop",
          focusX: 0.5,
          focusY: 0.5,
          isAiGenerated: false,
          keyframes: [
            {
              id: "kf-0",
              time: 0,
              focusX: 0.5,
              focusY: 0.5,
              zoom: 1,
              isAiGenerated: false,
            },
          ],
        },
      },
    ]),
  );
  // Old formula would allow frame 150; canonical duration is 150 frames (0..149).
  store.dispatch(
    addFramingKeyframe({
      segmentId: "seg-offgrid",
      keyframe: {
        id: "kf-last",
        time: frameToTime(150, fps),
        focusX: 0.2,
        focusY: 0.5,
        zoom: 0.4,
        isAiGenerated: false,
      },
    }),
  );
  const kfs = keyframes(store);
  assert(kfs.length === 2, "off-grid segment accepts a clamped interior cut");
  assert(
    frameIndex(kfs[1].time, fps) === 149,
    "off-grid cut clamps to last renderable frame (149), not 150",
  );
}

{
  // Short segment still accepts an interior manual cut when a frame exists.
  const store = makeStore(30);
  store.dispatch(
    setSegments([
      {
        id: "seg-short",
        startTime: 0,
        endTime: 0.2,
        title: "Short",
        description: "",
        characters: [],
        sceneTags: [],
        keyDialogue: "",
        confidence: 1,
        framing: {
          aspectRatio: "9:16",
          mode: "crop",
          focusX: 0.5,
          focusY: 0.5,
          isAiGenerated: false,
          keyframes: [
            {
              id: "kf-0",
              time: 0,
              focusX: 0.5,
              focusY: 0.5,
              zoom: 1,
              isAiGenerated: false,
            },
          ],
        },
      },
    ]),
  );
  store.dispatch(
    addFramingKeyframe({
      segmentId: "seg-short",
      keyframe: {
        id: "kf-mid",
        time: 1 / 30,
        focusX: 0.3,
        focusY: 0.5,
        zoom: 0.5,
        isAiGenerated: false,
      },
    }),
  );
  assert(
    keyframes(store).length === 2,
    "short segment accepts a manual interior cut",
  );
}

console.log(
  failures === 0
    ? `editorFrameCuts: ${checks} checks passed`
    : `editorFrameCuts: ${failures}/${checks} failed`,
);
if (failures > 0) process.exit(1);
