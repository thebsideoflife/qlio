/**
 * Timeline-pinned framing keyframes when a segment's in/out points move.
 *
 * Run: npx tsx --tsconfig tsconfig.app.json src/lib/timelineKeyframes.test.ts
 */
import type { FramingKeyframe } from "../remotion/types";
import { reanchorKeyframesToTimeline } from "./timelineKeyframes";

let checks = 0;
let failures = 0;

function assert(condition: boolean, message: string): void {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}

function kf(id: string, time: number): FramingKeyframe {
  return {
    id,
    time,
    zoom: id === "a" ? 0.2 : id === "b" ? 0.8 : 0.5,
    focusX: 0.5,
    focusY: 0.5,
    isAiGenerated: false,
  };
}

function ids(kfs: FramingKeyframe[]): string {
  return kfs.map((k) => `${k.id}@${k.time}`).join(",");
}

const original = [kf("a", 0), kf("b", 3), kf("c", 7)];
const oldStart = 10;
const oldEnd = 20;

{
  const next = reanchorKeyframesToTimeline(original, oldStart, 8, oldEnd);
  assert(
    ids(next) === "a@0,b@5,c@9",
    `extend start: first stretches, interiors stay on timeline (got ${ids(next)})`,
  );
}

{
  const next = reanchorKeyframesToTimeline(original, oldStart, 12, oldEnd);
  assert(
    ids(next) === "a@0,b@1,c@5",
    `trim start: first shrinks, interiors stay on timeline (got ${ids(next)})`,
  );
}

{
  const next = reanchorKeyframesToTimeline(original, oldStart, 14, oldEnd);
  assert(
    ids(next) === "b@0,c@3",
    `trim start past an interior: that setting becomes first, later interiors unmoved (got ${ids(next)})`,
  );
}

{
  const next = reanchorKeyframesToTimeline(original, oldStart, oldStart, 22);
  assert(
    ids(next) === "a@0,b@3,c@7",
    `extend end: last stretches, no times change (got ${ids(next)})`,
  );
}

{
  const next = reanchorKeyframesToTimeline(original, oldStart, oldStart, 16);
  assert(
    ids(next) === "a@0,b@3",
    `trim end past last keyframe: last remaining stretches, interiors unmoved (got ${ids(next)})`,
  );
}

{
  const next = reanchorKeyframesToTimeline(original, oldStart, 15, 25);
  assert(
    ids(next) === "b@0,c@2",
    `move later: frames stay on the source timeline, first/last stretch (got ${ids(next)})`,
  );
}

{
  const next = reanchorKeyframesToTimeline(original, oldStart, 5, 15);
  assert(
    ids(next) === "a@0,b@8",
    `move earlier: interiors stay, last that falls past new end is dropped (got ${ids(next)})`,
  );
}

{
  const once = reanchorKeyframesToTimeline(original, oldStart, 8, oldEnd);
  const back = reanchorKeyframesToTimeline(once, 8, oldStart, oldEnd);
  assert(
    ids(back) === "a@0,b@3,c@7",
    `extend start then restore: interiors round-trip (got ${ids(back)})`,
  );
}

{
  const once = reanchorKeyframesToTimeline(original, oldStart, 12, oldEnd);
  const back = reanchorKeyframesToTimeline(once, 12, oldStart, oldEnd);
  assert(
    ids(back) === "a@0,b@3,c@7",
    `trim start then restore: interiors round-trip (got ${ids(back)})`,
  );
}

{
  // Live drag applies many small start deltas; interiors must stay pinned.
  let start = oldStart;
  let kfs = original;
  for (const next of [9.5, 9, 8.5, 8]) {
    kfs = reanchorKeyframesToTimeline(kfs, start, next, oldEnd);
    start = next;
  }
  assert(
    ids(kfs) === "a@0,b@5,c@9",
    `incremental extend-start drag (got ${ids(kfs)})`,
  );
  for (const next of [8.5, 9, 9.5, 10]) {
    kfs = reanchorKeyframesToTimeline(kfs, start, next, oldEnd);
    start = next;
  }
  assert(
    ids(kfs) === "a@0,b@3,c@7",
    `incremental extend-start drag restored (got ${ids(kfs)})`,
  );
}

{
  const single = reanchorKeyframesToTimeline([kf("a", 0)], oldStart, 8, 22);
  assert(
    ids(single) === "a@0",
    `single keyframe stretches in both directions (got ${ids(single)})`,
  );
}

{
  const noop = reanchorKeyframesToTimeline(original, oldStart, oldStart, oldEnd);
  assert(
    ids(noop) === "a@0,b@3,c@7",
    `unchanged bounds are identity (got ${ids(noop)})`,
  );
}

console.log(
  failures === 0
    ? `timelineKeyframes: ${checks} checks passed`
    : `timelineKeyframes: ${failures}/${checks} failed`,
);
if (failures > 0) process.exit(1);
