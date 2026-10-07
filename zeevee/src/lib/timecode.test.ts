import {
  anchorInSegments,
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

// A word cut by a segment edge anchors inside the segment it overlaps.
// Real case: "We" 233.82-234.18, segment starts 233.8626.
const cut = [{ startTime: 139.6, endTime: 227.7 }, { startTime: 233.8626, endTime: 329.5 }];
const we = anchorInSegments(cut, 233.82, 234.18)!;
assert(we === 233.8626, "anchor clamps to the segment start");
const wePreview = sourceToPreviewTime(cut, we, 233.82)!;
assert(Math.abs(wePreview - (88.1 - 0.0426)) < 1e-9, `"We" maps to the preview clock, just before the cut (${wePreview})`);
assert(previewToSourceTime(cut, we, wePreview)! - 233.82 < 1e-9, "and back");
assert(anchorInSegments(cut, 229, 230) === null, "a word between segments has no anchor");
assert(anchorInSegments(cut, 227.5, 227.9) === 227.5, "a word over a segment end anchors at its start");

console.log("timecode tests passed");
