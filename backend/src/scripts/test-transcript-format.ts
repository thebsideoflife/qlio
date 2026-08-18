/**
 * Tests for Whisper transcript JSON, chunk planning, and overlap mapping.
 */
import {
  groupWordsIntoCaptions,
  normalizeLanguageCode,
  parseTranscriptJson,
} from "../utils/transcript-format";
import {
  mapChunkWordsToVideoClock,
  MAX_TRANSCRIBE_HOPS,
  mergeChunkWords,
  parseFfprobeStreamProbe,
  parseTranscribeHop,
  planAudioChunks,
  storedChunkMatchesPlan,
  transcribeContinuationDecision,
  WHISPER_OVERLAP_SAMPLES,
  WHISPER_SAMPLE_RATE,
  type StoredWhisperChunk,
} from "../utils/transcript-timing";
import { isEffectivelySilent } from "../utils/wav";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function almost(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

// --- parseTranscriptJson ---
const legacy = parseTranscriptJson([
  { start: 1, end: 1.2, value: "Hola" },
  { start: 0, end: 0.4, value: "Sí" },
]);
assert(legacy.kind === "original", "legacy array is original");
assert(legacy.kind === "original" && legacy.words[0].value === "Sí", "sorts by start");

const wrapped = parseTranscriptJson({
  language: "Spanish",
  words: [{ start: 12.4, end: 12.7, value: "Hola" }],
});
assert(wrapped.kind === "original" && wrapped.language === "es", "normalizes language");

const translated = parseTranscriptJson({
  language: "en",
  sourceLanguage: "es",
  lines: [{ start: 12.4, end: 15.1, text: "Hello" }],
});
assert(translated.kind === "translation", "lines → translation");
assert(
  translated.kind === "translation" &&
    translated.lines[0].startTime === 12.4 &&
    translated.lines[0].text === "Hello",
  "translation line times",
);

assert(normalizeLanguageCode("en-US") === "en", "en-US → en");
assert(normalizeLanguageCode("castellano") === "es", "castellano → es");

const grouped = groupWordsIntoCaptions([
  { start: 0, end: 0.2, value: "a" },
  { start: 0.2, end: 0.4, value: "b" },
  { start: 1.0, end: 1.2, value: "c" },
]);
assert(grouped.length === 2, "0.6s pause splits a line");

// --- plan: one short clip is a single chunk ---
const one = planAudioChunks({
  totalSamples: WHISPER_SAMPLE_RATE * 10,
  sampleRate: WHISPER_SAMPLE_RATE,
});
assert(one.length === 1, "10s is one chunk");
assert(one[0].outboundOverlapSamples === 0, "solo chunk has no outbound overlap");
assert(one[0].overlapSamples === 0, "solo chunk has no inbound overlap");

// --- plan: long audio uses overlap on both sides except ends ---
const twoMinutes = planAudioChunks({
  totalSamples: WHISPER_SAMPLE_RATE * 90,
  sampleRate: WHISPER_SAMPLE_RATE,
});
assert(twoMinutes.length >= 2, "90s needs more than one 45s chunk");
assert(twoMinutes[0].overlapSamples === 0, "first inbound 0");
assert(
  twoMinutes[0].outboundOverlapSamples === WHISPER_OVERLAP_SAMPLES,
  "first outbound is the configured overlap",
);
assert(
  twoMinutes[1].overlapSamples === WHISPER_OVERLAP_SAMPLES,
  "second inbound is the configured overlap",
);
assert(
  twoMinutes[twoMinutes.length - 1].outboundOverlapSamples === 0,
  "last outbound 0",
);

// --- overlap halves do not double-emit ---
const rate = WHISPER_SAMPLE_RATE;
const overlap = WHISPER_OVERLAP_SAMPLES;
const chunkSamples = 45 * rate;
const plans = planAudioChunks({
  totalSamples: chunkSamples + (chunkSamples - overlap),
  sampleRate: rate,
  chunkSamples,
  overlapSamples: overlap,
});
assert(plans.length === 2, "two overlapping 45s slices");

const boundary = 44.8; // in the 0.25s keep-from-previous / drop-from-next zone
const chunk0Words = [
  { start: 44.6, end: 44.75, value: "keep-prev" },
  { start: 44.8, end: 44.95, value: "dup-risk" },
];
const chunk1Words = [
  { start: 0.3, end: 0.45, value: "dup-risk" }, // 44.5 + 0.3 = 44.8
  { start: 0.6, end: 0.8, value: "keep-next" },
];

const mapped0 = mapChunkWordsToVideoClock({
  words: chunk0Words,
  audioStartInVideoSec: 0,
  chunkStartSample: plans[0].startSample,
  chunkEndSample: plans[0].endSample,
  sampleRate: rate,
  overlapSamples: plans[0].overlapSamples,
  outboundOverlapSamples: plans[0].outboundOverlapSamples,
});
const mapped1 = mapChunkWordsToVideoClock({
  words: chunk1Words,
  audioStartInVideoSec: 0,
  chunkStartSample: plans[1].startSample,
  chunkEndSample: plans[1].endSample,
  sampleRate: rate,
  overlapSamples: plans[1].overlapSamples,
  outboundOverlapSamples: plans[1].outboundOverlapSamples,
});
const merged = mergeChunkWords([...mapped0, ...mapped1]);
assert(
  merged.filter((w) => w.value === "dup-risk").length === 1,
  `overlap word emitted once, got ${merged.map((w) => w.value).join(",")}`,
);
assert(
  merged.some((w) => w.value === "keep-prev") &&
    merged.some((w) => w.value === "keep-next"),
  "each side keeps its unique word",
);
assert(
  almost(merged.find((w) => w.value === "dup-risk")!.start, boundary),
  "kept overlap word stays on the first-chunk clock",
);

// --- stored chunk fingerprint ---
const stored: StoredWhisperChunk = {
  index: 0,
  model: "openai/whisper-large-v3",
  audio: { startInVideo: 0, sampleRate: rate, totalSamples: 1000 },
  plan: {
    startSample: 0,
    endSample: 1000,
    overlapSamples: 0,
    outboundOverlapSamples: 0,
  },
  text: "hi",
  words: [{ start: 0, end: 0.2, value: "hi" }],
};
assert(
  storedChunkMatchesPlan(stored, {
    index: 0,
    startSample: 0,
    endSample: 1000,
    startSec: 0,
    durationSec: 1000 / rate,
    overlapSamples: 0,
    outboundOverlapSamples: 0,
  }, { startInVideo: 0, sampleRate: rate, totalSamples: 1000 }, "openai/whisper-large-v3"),
  "matching fingerprint reuses the chunk",
);
assert(
  !storedChunkMatchesPlan(stored, {
    index: 0,
    startSample: 0,
    endSample: 1000,
    startSec: 0,
    durationSec: 1000 / rate,
    overlapSamples: 0,
    outboundOverlapSamples: 0,
  }, { startInVideo: 0, sampleRate: rate, totalSamples: 2000 }, "openai/whisper-large-v3"),
  "different sample count is a miss",
);
assert(
  !storedChunkMatchesPlan(
    stored,
    {
      index: 0,
      startSample: 0,
      endSample: 1000,
      startSec: 0,
      durationSec: 1000 / rate,
      overlapSamples: 0,
      outboundOverlapSamples: 0,
    },
    { startInVideo: 0, sampleRate: rate, totalSamples: 1000 },
    "openai/whisper-large-v3-turbo",
  ),
  "different Whisper model is a cache miss",
);

// --- ffprobe timing and silence classification ---
const delayedAudio = parseFfprobeStreamProbe(
  JSON.stringify({
    streams: [{ start_time: "1.978000", sample_rate: "48000" }],
    format: { start_time: "0.000000", duration: "5.000000" },
  }),
);
assert(almost(delayedAudio.audioStartSec, 1.978), "uses audio stream start time");
assert(delayedAudio.audioSampleRate === 48_000, "reads audio sample rate");
assert(
  isEffectivelySilent({ peakAmplitude: 0, rmsAmplitude: 0 }),
  "digital silence is silent",
);
assert(
  !isEffectivelySilent({ peakAmplitude: 0.02, rmsAmplitude: 0.002 }),
  "quiet non-silent audio fails closed",
);

// --- continuation: never hop without a newly written chunk ---
assert(parseTranscribeHop(undefined) === 0, "missing hop is 0");
assert(parseTranscribeHop(-3) === 0, "negative hop is 0");
assert(parseTranscribeHop(2.9) === 2, "hop is floored");

assert(
  transcribeContinuationDecision({
    remainingMs: 80_000,
    budgetMs: 80_000,
    wroteChunks: 0,
    hop: 0,
  }) === "run",
  "enough time → run even with no writes yet",
);
assert(
  transcribeContinuationDecision({
    remainingMs: 10_000,
    budgetMs: 80_000,
    wroteChunks: 0,
    hop: 0,
  }) === "abort-no-progress",
  "low time and no writes → fail closed",
);
assert(
  transcribeContinuationDecision({
    remainingMs: 10_000,
    budgetMs: 80_000,
    wroteChunks: 1,
    hop: 0,
  }) === "continue",
  "low time after a write → hop",
);
assert(
  transcribeContinuationDecision({
    remainingMs: 10_000,
    budgetMs: 80_000,
    wroteChunks: 1,
    hop: MAX_TRANSCRIBE_HOPS - 1,
  }) === "abort-max-hops",
  "next hop would hit the cap → stop",
);
assert(
  transcribeContinuationDecision({
    remainingMs: 200_000,
    budgetMs: 80_000,
    wroteChunks: 0,
    hop: MAX_TRANSCRIBE_HOPS,
  }) === "abort-max-hops",
  "already at cap → stop even with time left",
);

console.log("test-transcript-format: ok");
