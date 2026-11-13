/**
 * Unit tests for TwelveLabs transcription normalization / duration extraction.
 */
import {
  estimateDurationFromTranscript,
  extractTwelveLabsDuration,
  normalizeTwelveLabsTranscription,
  transcriptUniquenessRatio,
} from "../utils/transcription";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// Duration: camelCase systemMetadata (the Bourdain bug)
assert(
  extractTwelveLabsDuration({
    systemMetadata: { duration: 2536.148 },
  }) === 2536.148,
  "should read systemMetadata.duration",
);

// Duration: snake_case
assert(
  extractTwelveLabsDuration({
    system_metadata: { duration: 100 },
  }) === 100,
  "should read system_metadata.duration",
);

assert(
  extractTwelveLabsDuration({
    system_metadata: { duration: 0 },
    systemMetadata: { duration: 42 },
  }) === 42,
  "should fall through to camelCase when snake is 0/missing",
);

assert(extractTwelveLabsDuration({}) === 0, "empty → 0");
assert(extractTwelveLabsDuration(null) === 0, "null → 0");

// Bourdain shape: heavily looped pass1 + unique stretched pass2 → keep/scaled pass2
function repeatBlock(
  base: { start: number; end: number; value: string }[],
  offset: number,
) {
  return base.map((w) => ({
    ...w,
    start: w.start + offset,
    end: w.end + offset,
  }));
}

const openingBlock = [
  { start: 0.0, end: 0.1, value: "So" },
  { start: 0.1, end: 0.2, value: "this" },
  { start: 0.2, end: 0.3, value: "is" },
  { start: 0.3, end: 0.4, value: "the" },
  { start: 0.4, end: 0.5, value: "way" },
  { start: 0.5, end: 0.6, value: "I" },
  { start: 0.6, end: 0.7, value: "wanted" },
  { start: 0.7, end: 0.8, value: "to" },
  { start: 0.8, end: 0.9, value: "show" },
  { start: 0.9, end: 1.0, value: "the" },
  { start: 1.0, end: 1.2, value: "look" },
  { start: 1.3, end: 1.4, value: "Black" },
  { start: 1.4, end: 1.5, value: "and" },
  { start: 1.5, end: 1.6, value: "white" },
  { start: 1.6, end: 1.7, value: "French" },
  { start: 1.7, end: 1.9, value: "films" },
];

const loopedPass1 = Array.from({ length: 40 }, (_, i) =>
  repeatBlock(openingBlock, i * 60),
).flat();

const realPass2 = [
  ...openingBlock,
  { start: 120, end: 120.2, value: "I'm" },
  { start: 120.3, end: 120.5, value: "Anthony" },
  { start: 120.6, end: 120.9, value: "Bourdain" },
  { start: 200, end: 200.3, value: "Paris" },
  { start: 201, end: 201.4, value: "locals" },
  { start: 250, end: 250.4, value: "airplane" },
  { start: 300, end: 300.5, value: "croissant" },
  { start: 350, end: 350.5, value: "market" },
  { start: 400, end: 400.5, value: "sewers" },
  { start: 450, end: 450.5, value: "bakery" },
  { start: 500, end: 500.5, value: "cafe" },
  { start: 550, end: 550.5, value: "sandwich" },
  { start: 4971, end: 4973.88, value: "world." },
];

const bourbonLike = [...loopedPass1, ...realPass2];

assert(
  transcriptUniquenessRatio(loopedPass1) < 0.2,
  `looped pass should be low-uniqueness, got ${transcriptUniquenessRatio(loopedPass1)}`,
);
assert(
  transcriptUniquenessRatio(realPass2) > transcriptUniquenessRatio(loopedPass1),
  "real dialogue pass should outrank looped pass",
);

const sanitized = normalizeTwelveLabsTranscription(bourbonLike, {
  durationSec: 2536.148,
});
assert(
  sanitized.selectedPass === "second",
  `expected second pass, got ${sanitized.selectedPass}`,
);
assert(sanitized.scaledBy < 1, `expected scale-down, got ${sanitized.scaledBy}`);
assert(
  sanitized.words.some((w) => w.value === "Bourdain"),
  "should keep real dialogue from pass2",
);
assert(
  sanitized.words.every((w) => w.start <= 2538.148),
  "all words should land within duration slack",
);
assert(
  sanitized.discardedDuplicateWords === loopedPass1.length,
  "should discard the looped duplicate track word-for-word",
);

// Simple back-jump where first pass is better (unique) — keep first
const simple = [
  { start: 1, end: 1.1, value: "alpha" },
  { start: 2, end: 2.1, value: "bravo" },
  { start: 3, end: 3.1, value: "charlie" },
  { start: 4, end: 4.1, value: "delta" },
  { start: 5, end: 5.1, value: "echo" },
  { start: 6, end: 6.1, value: "foxtrot" },
  { start: 7, end: 7.1, value: "golf" },
  { start: 8, end: 8.1, value: "hotel" },
  { start: 9, end: 9.1, value: "india" },
  { start: 10, end: 10.1, value: "juliet" },
  { start: 1, end: 1.1, value: "alpha" },
  { start: 1.2, end: 1.3, value: "alpha" },
  { start: 1.4, end: 1.5, value: "alpha" },
];
const keepFirst = normalizeTwelveLabsTranscription(simple, { durationSec: 12 });
assert(keepFirst.selectedPass === "first", "unique first pass should win");
assert(
  keepFirst.words.some((w) => w.value === "juliet"),
  "should retain first-pass content",
);

// Single heavily stretched timeline (no back-jump) should scale onto duration
const stretched = [
  { start: 10, end: 11, value: "a" },
  { start: 100, end: 101, value: "b" },
  { start: 5000, end: 5001, value: "ghost" },
];
const scaledSingle = normalizeTwelveLabsTranscription(stretched, {
  durationSec: 120,
});
assert(scaledSingle.words.length === 3, "should keep all words after scale");
assert(scaledSingle.scaledBy < 1, "should scale stretched single pass");
assert(
  scaledSingle.words.every((w) => w.start <= 122),
  "scaled starts within slack",
);

// Mild past-end ghost (not stretch regime) still dropped
const slightlyPast = [
  { start: 10, end: 11, value: "a" },
  { start: 50, end: 51, value: "b" },
  { start: 100, end: 101, value: "c" },
  { start: 125, end: 130, value: "ghost" },
];
const clamped = normalizeTwelveLabsTranscription(slightlyPast, {
  durationSec: 120,
});
assert(clamped.scaledBy === 1, "should not scale mild overrun");
assert(
  !clamped.words.some((w) => w.value === "ghost"),
  "ghost past duration should be dropped",
);

assert(
  normalizeTwelveLabsTranscription(null).words.length === 0,
  "null → empty",
);
assert(
  normalizeTwelveLabsTranscription({}).words.length === 0,
  "object → empty",
);

assert(
  estimateDurationFromTranscript([
    { start: 1, end: 2, value: "a" },
    { start: 3, end: 9, value: "b" },
  ]) === 9,
  "estimate uses max end",
);

console.log("test-transcription-sanitize: all passed");
