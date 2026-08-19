/**
 * Tests for Whisper transcript JSON, chunk planning, and overlap mapping.
 */
import {
  applyWordEditsToWords,
  captionsFromParsedTranscript,
  captionsOverlappingRange,
  groupWordsIntoCaptions,
  inferOriginalTranscriptLanguage,
  normalizeLanguageCode,
  originalTranscriptKey,
  parseTranscriptJson,
  pickTranslationUri,
  selectSupersededTranscriptKeys,
  shiftCaptionsBy,
  transcriptVersionMatches,
  translationTranscriptKey,
  whisperChunkKey,
} from "../utils/transcript-format";
import {
  isOriginalCaptionLanguage,
  mapChunkWordsToVideoClock,
  MAX_TRANSCRIBE_HOPS,
  mergeChunkWords,
  parseFfprobeStreamProbe,
  parseTranscribeHop,
  planAudioChunks,
  resolveRenderTranscriptCandidates,
  resolveRenderTranscriptUri,
  storedChunkMatchesPlan,
  transcribeContinuationDecision,
  WHISPER_OVERLAP_SAMPLES,
  WHISPER_SAMPLE_RATE,
  type StoredWhisperChunk,
} from "../utils/transcript-timing";
import { isEffectivelySilent } from "../utils/wav";
import { classifyTranscriptionRun } from "../utils/transcription-run";
import { computeSegmentRenderFingerprint } from "../utils/segmentRenderFingerprint";
import {
  buildExportPackageLayout,
  exportPackageObjectKey,
} from "../utils/exportPackageLayout";

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
assert(
  legacy.kind === "original" && legacy.language === "en",
  "bare legacy arrays infer English",
);

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
assert(
  inferOriginalTranscriptLanguage({
    assetId: "asset-1",
    transcriptionUrl: "s3://bucket/transcriptions/asset-1.json",
  }) === "en",
  "legacy flat transcript keys infer English",
);
assert(
  inferOriginalTranscriptLanguage({
    assetId: "asset-1",
    originalLanguage: "Spanish",
    transcriptionUrl: "s3://bucket/transcriptions/asset-1.json",
  }) === "es",
  "explicit language wins over legacy inference",
);

// --- versioned storage and cleanup ---
const version = "run-123";
const originalKey = originalTranscriptKey("asset-1", version);
assert(
  originalKey ===
    "transcriptions/asset-1/versions/run-123/original.json",
  "original transcript key includes the source version",
);
assert(
  translationTranscriptKey("asset-1", version, "Spanish") ===
    "transcriptions/asset-1/versions/run-123/translations/es.json",
  "translation key is scoped to the source version",
);
assert(
  whisperChunkKey("asset-1", version, 2) ===
    "transcriptions/asset-1/versions/run-123/chunks/2.json",
  "Whisper chunks are scoped to one run",
);
assert(transcriptVersionMatches(version, version), "matching source version is current");
assert(
  !transcriptVersionMatches("run-older", version),
  "stale translation source version is rejected",
);

const staleKeys = selectSupersededTranscriptKeys({
  assetId: "asset-1",
  listedKeys: [
    "transcriptions/asset-1.json",
    "transcriptions/asset-1/en.json",
    "transcriptions/asset-1/chunks/0.json",
    originalKey,
    "scene-cache/asset-1/result.json",
  ],
  keepKeys: [originalKey],
});
assert(
  staleKeys.includes("transcriptions/asset-1.json") &&
    staleKeys.includes("transcriptions/asset-1/en.json") &&
    staleKeys.includes("transcriptions/asset-1/chunks/0.json"),
  "cleanup selects legacy originals, prior originals, and old chunks",
);
assert(!staleKeys.includes(originalKey), "cleanup keeps the replacement original");
assert(
  !staleKeys.includes("scene-cache/asset-1/result.json"),
  "cleanup leaves unrelated video-analysis data alone",
);
assert(
  classifyTranscriptionRun(
    {
      pendingTranscriptionVersion: version,
      transcriptionStatus: "pending",
    },
    version,
  ) === "current",
  "a matching pending run is current",
);
assert(
  classifyTranscriptionRun(
    {
      transcriptionVersion: version,
      transcriptionStatus: "ready",
      transcriptionUrl: `s3://bucket/${originalKey}`,
    },
    version,
  ) === "committed",
  "a duplicate delivery recognizes the already-committed run",
);
assert(
  classifyTranscriptionRun(
    {
      pendingTranscriptionVersion: "newer-run",
      transcriptionStatus: "pending",
    },
    version,
  ) === "superseded",
  "a different pending run supersedes the old version",
);
const renderSegment = { startTime: 0, endTime: 10 };
const renderCaptions = { enabled: true, style: {} };
const renderFraming = { aspectRatio: "9:16" };
assert(
  computeSegmentRenderFingerprint(
    renderSegment,
    renderCaptions,
    renderFraming,
    "transcript-a",
  ) !==
    computeSegmentRenderFingerprint(
      renderSegment,
      renderCaptions,
      renderFraming,
      "transcript-b",
    ),
  "retranscription invalidates captioned renders",
);
assert(
  computeSegmentRenderFingerprint(
    renderSegment,
    { ...renderCaptions, enabled: false },
    renderFraming,
    "transcript-a",
  ) ===
    computeSegmentRenderFingerprint(
      renderSegment,
      { ...renderCaptions, enabled: false },
      renderFraming,
      "transcript-b",
    ),
  "retranscription does not invalidate renders with captions disabled",
);

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

// --- export burns the selected language from the current Whisper run ---
const currentVersion = "run-new";
const currentOriginal = `s3://bucket/${originalTranscriptKey("asset-1", currentVersion)}`;
const currentSpanish = `s3://bucket/${translationTranscriptKey("asset-1", currentVersion, "es")}`;
const staleSpanish = `s3://bucket/${translationTranscriptKey("asset-1", "run-old", "es")}`;
const legacyOriginal = "s3://bucket/transcriptions/asset-1.json";

assert(
  resolveRenderTranscriptUri({
    assetId: "asset-1",
    activeLanguage: "es",
    originalLanguage: "en",
    transcriptionVersion: currentVersion,
    translations: { es: currentSpanish },
    transcriptionUrl: currentOriginal,
  }) === currentSpanish,
  "Spanish toggle burns the current Spanish file",
);
assert(
  resolveRenderTranscriptUri({
    assetId: "asset-1",
    activeLanguage: "Spanish",
    originalLanguage: "English",
    transcriptionVersion: currentVersion,
    translations: { Spanish: currentSpanish },
    transcriptionUrl: currentOriginal,
  }) === currentSpanish,
  "language aliases still resolve to the Spanish file",
);
assert(
  resolveRenderTranscriptUri({
    assetId: "asset-1",
    activeLanguage: "es",
    originalLanguage: "en",
    transcriptionVersion: currentVersion,
    translations: { es: staleSpanish },
    transcriptionUrl: currentOriginal,
  }) === currentSpanish,
  "stale Spanish from a previous transcript is replaced by this version",
);
assert(
  resolveRenderTranscriptUri({
    assetId: "asset-1",
    activeLanguage: "original",
    originalLanguage: "en",
    transcriptionVersion: currentVersion,
    translations: { es: currentSpanish },
    transcriptionUrl: currentOriginal,
  }) === currentOriginal,
  "Original toggle burns the current Whisper file, not a translation",
);
assert(
  resolveRenderTranscriptUri({
    assetId: "asset-1",
    activeLanguage: "es",
    originalLanguage: "es",
    transcriptionVersion: currentVersion,
    translations: { en: `s3://bucket/${translationTranscriptKey("asset-1", currentVersion, "en")}` },
    transcriptionUrl: currentOriginal,
  }) === currentOriginal,
  "Spanish source with Spanish selected uses the original Whisper file",
);
assert(
  resolveRenderTranscriptUri({
    assetId: "asset-1",
    activeLanguage: "original",
    transcriptionVersion: currentVersion,
    transcriptionUrl: legacyOriginal,
  }) === currentOriginal,
  "legacy TwelveLabs path is not preferred once a Whisper version exists",
);
assert(
  resolveRenderTranscriptCandidates({
    assetId: "asset-1",
    activeLanguage: "es",
    originalLanguage: "en",
    transcriptionVersion: currentVersion,
    translations: { es: currentSpanish },
    transcriptionUrl: legacyOriginal,
  }).join(",") === `${currentSpanish},${currentOriginal},${legacyOriginal}`,
  "Spanish first, then Whisper, TwelveLabs only if those files are missing",
);
assert(
  resolveRenderTranscriptCandidates({
    assetId: "asset-1",
    activeLanguage: "original",
    transcriptionUrl: legacyOriginal,
  }).join(",") === legacyOriginal,
  "TwelveLabs is used only when no Whisper original exists",
);
assert(
  isOriginalCaptionLanguage("es", "Spanish"),
  "es and Spanish are the same caption language",
);
assert(
  pickTranslationUri({ Spanish: currentSpanish }, "es") === currentSpanish,
  "translation map keys are normalized",
);

const overlapping = captionsOverlappingRange(
  [
    { id: "before", startTime: 9.2, endTime: 12.1, text: "Hola", words: [] },
    { id: "inside", startTime: 12.5, endTime: 14, text: "mundo", words: [] },
    { id: "after", startTime: 20, endTime: 22, text: "adiós", words: [] },
  ],
  10,
  20,
);
assert(
  overlapping.map((c) => c.id).join(",") === "before,inside",
  "export includes lines that start before the cut but are still on screen",
);
const shifted = shiftCaptionsBy(overlapping, -10);
assert(
  almost(shifted[0].startTime, -0.8),
  "overlapping line is shifted onto the clip clock",
);
assert(
  almost(shifted[1].startTime, 2.5),
  "in-range line is shifted onto the clip clock",
);

const edited = applyWordEditsToWords(
  [
    { start: 1, end: 1.2, value: "Hello" },
    { start: 1.2, end: 1.5, value: "world" },
  ],
  { "1-1.2": "Hola" },
);
assert(edited[0].value === "Hola", "word edits apply before burn-in");
assert(
  captionsFromParsedTranscript(
    { kind: "translation", language: "es", lines: overlapping },
    { "1-1.2": "ignored" },
  )[0].text === "Hola",
  "translated lines are used as-is",
);

const packed = buildExportPackageLayout({
  projectTitle: "Remembering Hayden Panettiere",
  scenes: [
    { segmentId: "a", title: "Juliette Woos Deacon" },
    { segmentId: "b", title: "Mother calls Juliette" },
  ],
});
assert(
  packed.zipFilename === "Remembering Hayden Panettiere.zip",
  "server zip uses the delivery folder name",
);
assert(
  packed.scenes[0].videoPath.includes("Video Scenes/Juliette_Woos_Deacon.mp4"),
  "server zip scene path matches the editor layout",
);
assert(
  exportPackageObjectKey("proj-1", "job-1") ===
    "projects/proj-1/exports/job-1.zip",
  "export zip key is scoped to the project",
);

console.log("test-transcript-format: ok");
