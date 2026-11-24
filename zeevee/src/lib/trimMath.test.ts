/**
 * Frame math behind the trim lens.
 *
 * Run: npx tsx --tsconfig tsconfig.app.json src/lib/trimMath.test.ts
 */
import {
  edgeDisplayTime,
  edgeFrames,
  edgeTimeAtPlayhead,
  formatFrameTimecode,
  lensWindowStart,
  minTrimDuration,
  nudgeEdge,
  parseFrameTimecode,
  setEdgeTime,
} from "./trimMath";

let checks = 0;
let failures = 0;
function assertEqual<T>(actual: T, expected: T, message: string): void {
  checks++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`  FAIL: ${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

const seg = { startTime: 10, endTime: 20 };

// Frames either side of each cut
assertEqual(edgeFrames(seg, "start", 24), { inside: 240, outside: 239 }, "start edge frames");
assertEqual(edgeFrames(seg, "end", 24), { inside: 479, outside: 480 }, "end edge frames");
assertEqual(r6(edgeDisplayTime(seg, "start", 24)), r6(240.5 / 24), "start shows first clip frame");
assertEqual(r6(edgeDisplayTime(seg, "end", 24)), r6(479.5 / 24), "end shows last clip frame");
assertEqual(edgeDisplayTime(seg, "start", null), 10, "no fps: start time");

// Nudges are whole frames
assertEqual(nudgeEdge(seg, "start", 1, 24, 100).start, 241 / 24, "+1 frame on start");
assertEqual(nudgeEdge(seg, "end", -10, 24, 100).end, 470 / 24, "-10 frames on end");
assertEqual(nudgeEdge(seg, "start", -1000, 24, 100).start, 0, "start clamps at 0");
assertEqual(nudgeEdge(seg, "end", 5000, 24, 30).end, 30, "end clamps at duration");

// Minimum length is respected (and frame-aligned)
assertEqual(minTrimDuration(24), 3 / 24, "min duration rounds up to 3 frames at 24 fps");
const tight = nudgeEdge({ startTime: 10, endTime: 10.2 }, "start", 100, 24, 100);
assertEqual(r6(tight.end - tight.start), r6(3 / 24), "start cannot pass end - min");
const tightEnd = setEdgeTime({ startTime: 10, endTime: 20 }, "end", 5, 24, 100);
assertEqual(r6(tightEnd.end), r6(10 + 3 / 24), "end cannot pass start + min");

// Dragged times snap to the grid
assertEqual(setEdgeTime(seg, "start", 12.01, 24, 100).start, 288 / 24, "snap to nearest frame");
assertEqual(setEdgeTime(seg, "start", 12.01, null, 100).start, 12.01, "no fps: no snap");

// Timecode
assertEqual(formatFrameTimecode(0, 24), "00:00:00:00", "zero");
assertEqual(formatFrameTimecode(3725 + 7 / 24, 24), "01:02:05:07", "h:m:s:f at 24");
assertEqual(formatFrameTimecode(59 + 23 / 24, 24), "00:00:59:23", "last frame of a second");
assertEqual(parseFrameTimecode("01:02:05:07", 24), (3725 * 24 + 7) / 24, "parse h:m:s:f");
assertEqual(parseFrameTimecode("00:00:01:24", 24), null, "frame past the second is rejected");
assertEqual(parseFrameTimecode("00:61:00:00", 24), null, "minutes >= 60 rejected");
assertEqual(parseFrameTimecode("1:02.5", 24), 62.5, "falls back to m:ss.cc");
assertEqual(parseFrameTimecode("junk", 24), null, "junk rejected");
assertEqual(parseFrameTimecode("00:00:01:00", null), null, "frame timecode needs fps");

// Round trip on fractional rates
const fps = 30000 / 1001;
let roundTrip = true;
for (let f = 0; f < 6000; f += 7) {
  const t = f / fps;
  const back = parseFrameTimecode(formatFrameTimecode(t, fps), fps);
  if (back == null || Math.round(back * fps) !== f) {
    roundTrip = false;
    console.error(`  round trip broke at frame ${f}: ${formatFrameTimecode(t, fps)}`);
    break;
  }
}
assertEqual(roundTrip, true, "29.97 timecode round-trips every frame");

// Set in/out to the frame on screen
assertEqual(edgeTimeAtPlayhead(240.5 / 24, "start", 24), 240 / 24, "in point = displayed frame");
assertEqual(edgeTimeAtPlayhead(240.5 / 24, "end", 24), 241 / 24, "out point keeps displayed frame");
assertEqual(edgeTimeAtPlayhead(240 / 24, "start", 24), 240 / 24, "frame boundary from arrow keys");
assertEqual(edgeTimeAtPlayhead(12.34, "end", null), 12.34, "no fps: playhead time");

// Lens window stays inside the video
assertEqual(lensWindowStart(50, 10, 100), 45, "centred");
assertEqual(lensWindowStart(2, 10, 100), 0, "clamped at start");
assertEqual(lensWindowStart(99, 10, 100), 90, "clamped at end");
assertEqual(lensWindowStart(3, 10, 6), 0, "video shorter than window");

if (failures) {
  console.error(`trim-math: ${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`trim-math: ${checks} checks passed`);
