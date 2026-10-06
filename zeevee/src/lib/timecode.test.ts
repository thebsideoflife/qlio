import {
  formatTimecode,
  parseTimecode,
  previewToSourceTime,
  sourceToPreviewTime,
} from "./timecode";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

assert(formatTimecode(96.55) === "1:36.55", "m:ss.cc");
assert(formatTimecode(0) === "0:00.00", "zero");
assert(formatTimecode(59.999) === "1:00.00", "rounds up across a minute");
assert(formatTimecode(3725.5) === "1:02:05.50", "hours");
assert(formatTimecode(-1) === "0:00.00", "never negative");

assert(parseTimecode("1:36.55") === 96.55, "m:ss.cc");
assert(parseTimecode("96.55") === 96.55, "plain seconds");
assert(parseTimecode(" 1:02:05.5 ") === 3725.5, "hours, trimmed");
assert(parseTimecode("1:60") === null, "seconds must be < 60");
assert(parseTimecode("1.5:30") === null, "only the last field has decimals");
assert(parseTimecode("abc") === null && parseTimecode("") === null && parseTimecode("-3") === null, "rejects junk");
for (const t of [0, 1.23, 96.55, 3725.5]) {
  assert(Math.abs(parseTimecode(formatTimecode(t))! - t) < 1e-9, `round-trips ${t}`);
}

// Preview clock: segments play back to back in start order.
const segments = [
  { startTime: 100, endTime: 110 },
  { startTime: 20, endTime: 30 },
];
assert(sourceToPreviewTime(segments, 25, 25) === 5, "first segment by start time");
assert(sourceToPreviewTime(segments, 105, 105.5) === 15.5, "second segment offset by the first");
assert(sourceToPreviewTime(segments, 105, 111) === 21, "edge past the segment end stays linear");
assert(sourceToPreviewTime(segments, 50, 50) === null, "outside every segment");
assert(previewToSourceTime(segments, 105, 15.5) === 105.5, "inverse");

console.log("timecode tests passed");
