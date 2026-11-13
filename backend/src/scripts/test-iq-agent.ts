/**
 * Unit tests for the IQ Agent's pure logic: budget arithmetic, chunk timestamp
 * mapping, segment editing, transcript grouping, context assembly, and the
 * tool guards that don't touch the network.
 *
 * No AWS credentials or API keys required.
 */

process.env.AGENT_THREADS_TABLE ??= "test-threads";
process.env.AGENT_EVENTS_TABLE ??= "test-events";
process.env.PROJECTS_TABLE ??= "test-projects";
process.env.ASSETS_TABLE ??= "test-assets";
process.env.AWS_REGION ??= "us-west-2";

import type { TwelveLabs } from "twelvelabs-js";
import {
  buildChunkFacts,
  chunkForTime,
  planRange,
  toLocalTime,
  toSourceTime,
  widenToMinimumClip,
} from "../services/iq-agent/chunks";
import {
  CLIP_WINDOW_WARN_SEC,
  MAX_ASKS_PER_RUN,
  MAX_BLIND_SPOT_REFUSALS,
  MAX_CLIP_WINDOW_SEC,
  MIN_CLIP_SEC,
  SEARCH_UNPRODUCTIVE_STOP_AT,
  TRANSCRIPT_MAX_CHARS,
} from "../services/iq-agent/config";
import {
  assembleMessages,
  buildSystemBlocks,
  renderLiveState,
  repairHistoryHead,
} from "../services/iq-agent/context";
import {
  blindSpotFloor,
  findBlindSpots,
  mergeIntervals,
  recordExamined,
} from "../services/iq-agent/examined";
import { buildVocabulary, findUngroundedNames } from "../services/iq-agent/grounding";
import { executeTool, type ExecContext } from "../services/iq-agent/executor";
import {
  computeLedger,
  fmtTimecode,
  renderLedger,
  resolveTarget,
} from "../services/iq-agent/ledger";
import {
  briefToGenerationInputs,
  isFramingJobActive,
  metadataToBrief,
  unframedSegmentIds,
} from "../services/iq-agent/project";
import { applyEdits, nextSegmentId } from "../services/iq-agent/tools/edit";
import {
  groupWordsIntoLines,
  nearestSilence,
  runReadTranscript,
  type TranscriptWord,
} from "../services/iq-agent/tools/transcript";
import { byRelevance, dedupeHits } from "../services/iq-agent/tools/search";
import {
  findOverlappingWatch,
  localWindow,
  normalizeQuestion,
  runWatchClip,
} from "../services/iq-agent/tools/watchClip";
import { emptyCostMeter } from "../services/iq-agent/types";
import type {
  AgentSegment,
  Brief,
  ChunkFacts,
  VideoFacts,
} from "../services/iq-agent/types";

let failures = 0;
let checks = 0;

function assert(cond: boolean, msg: string): void {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.error(`  FAIL: ${msg}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

function seg(
  id: string,
  startTime: number,
  endTime: number,
  title = id,
): AgentSegment {
  return {
    id,
    startTime,
    endTime,
    title,
    description: "",
    characters: [],
    sceneTags: [],
    keyDialogue: "",
    confidence: 0.9,
  };
}

// ============================================================================
section("Ledger — target resolution");
// ============================================================================

{
  const explicit = resolveTarget({ format: "compact_video", targetSeconds: 300 }, 3600);
  assert(explicit.seconds === 300, "explicit seconds wins");
  assert(explicit.source === "explicit_seconds", "explicit source recorded");
  assert(
    explicit.band![0] === 285 && explicit.band![1] === 315,
    `±5% band around 300 expected 285–315, got ${explicit.band?.join("–")}`,
  );

  const percent = resolveTarget({ format: "compact_video", targetPercent: 10 }, 3600);
  assert(percent.seconds === 360, "10% of a 1h source is 360s");
  assert(percent.source === "target_percent", "percent source recorded");

  const both = resolveTarget(
    { format: "compact_video", targetSeconds: 120, targetPercent: 50 },
    3600,
  );
  assert(both.seconds === 120, "explicit seconds overrides percent");

  const recap = resolveTarget({ format: "episode_recap" }, 3600);
  assert(recap.seconds === 90, "episode_recap defaults to 90s");
  assert(recap.source === "format_default", "format default source recorded");

  const none = resolveTarget({ format: "highlights" }, 3600);
  assert(none.seconds === null, "no invented target for formats without a convention");
  assert(none.source === "none", "no-target source recorded");

  // A short target keeps a usable floor rather than an unhittable ±5%.
  const short = resolveTarget({ format: "compact_video", targetSeconds: 60 }, 3600);
  assert(
    short.band![0] === 50 && short.band![1] === 70,
    `short targets floor the band at ±10s, got ${short.band?.join("–")}`,
  );
}

// ============================================================================
section("Ledger — status, violations, coverage");
// ============================================================================

{
  const brief: Brief = {
    format: "compact_video",
    targetSeconds: 300,
    minSegmentDuration: 20,
    maxSegmentDuration: 120,
  };

  const within = computeLedger(
    [seg("s1", 0, 100), seg("s2", 900, 1000), seg("s3", 1800, 1900)],
    brief,
    3600,
  );
  assert(within.totalDuration === 300, "total duration sums segment lengths");
  assert(within.target.status === "within", "300s hits a 300s target");
  assert(
    within.blocking.length === 0,
    `clean cut should have no blocking items, got: ${within.blocking.join(" | ")}`,
  );

  const over = computeLedger([seg("s1", 0, 500)], brief, 3600);
  assert(over.target.status === "over", "500s is over a 300s target");
  assert(
    over.perSegment.violations.some((v) => v.bound === "max"),
    "a 500s segment breaches a 120s per-segment max",
  );
  assert(
    over.blocking.some((b) => b.includes("over the")),
    "over-target is blocking",
  );

  const under = computeLedger([seg("s1", 0, 60)], brief, 3600);
  assert(under.target.status === "under", "60s is under a 300s target");

  const tooShort = computeLedger([seg("s1", 0, 10)], brief, 3600);
  assert(
    tooShort.perSegment.violations.some((v) => v.bound === "min"),
    "a 10s segment breaches a 20s per-segment min",
  );

  const overlapping = computeLedger(
    [seg("s1", 0, 100), seg("s2", 90, 200)],
    { format: "compact_video" },
    3600,
  );
  assert(overlapping.overlaps.length === 1, "overlap detected");
  assert(overlapping.overlaps[0].seconds === 10, "overlap measured in seconds");
  assert(
    overlapping.blocking.some((b) => b.includes("overlap")),
    "overlap is blocking",
  );

  const empty = computeLedger([], brief, 3600);
  assert(
    empty.blocking.some((b) => b.includes("empty")),
    "an empty cut is blocking",
  );

  const clustered = computeLedger(
    [seg("s1", 10, 40), seg("s2", 50, 80), seg("s3", 90, 120), seg("s4", 130, 160)],
    { format: "compact_video" },
    3600,
  );
  assert(
    clustered.coverage.quartiles[0] === 4,
    "all four segments land in the first quarter",
  );
  assert(
    clustered.coverage.spreadWarning !== null,
    "a front-loaded cut produces a spread warning",
  );
  assert(
    clustered.blocking.every((b) => !b.includes("quarter")),
    "spread is a warning, never blocking — it is an editorial call",
  );
  assert(
    clustered.coverage.largestGap != null &&
      clustered.coverage.largestGap.seconds > 3000,
    "largest untouched stretch is the tail of the video",
  );

  // Floating-point noise must not be reported as an overlap.
  const noise = computeLedger(
    [seg("s1", 0, 100.02), seg("s2", 100, 200)],
    { format: "compact_video" },
    3600,
  );
  assert(noise.overlaps.length === 0, "20ms of float noise is not an overlap");
}

// ============================================================================
section("Chunks — facts and timestamp mapping");
// ============================================================================

{
  const single = buildChunkFacts({
    isChunked: false,
    twelveLabsVideoId: "vid-1",
    duration: 1800,
  });
  assert(single.length === 1, "a non-chunked asset yields one pseudo-chunk");
  assert(single[0].sourceEnd === 1800, "the pseudo-chunk covers the whole timeline");

  const unindexed = buildChunkFacts({ isChunked: false, duration: 1800 });
  assert(unindexed.length === 0, "an unindexed asset yields no chunks");

  const chunked = buildChunkFacts({
    isChunked: true,
    duration: 7200,
    chunks: [
      {
        chunkIndex: 0,
        videoId: "c0",
        s3Key: "k0",
        startOffset: 0,
        endOffset: 3300,
        duration: 3300,
      },
      {
        chunkIndex: 1,
        videoId: "c1",
        s3Key: "k1",
        startOffset: 3270,
        endOffset: 6570,
        duration: 3300,
        actualStartOffset: 3270,
      },
      // Still indexing — must be dropped, not treated as a hole in the timeline.
      {
        chunkIndex: 2,
        videoId: undefined as unknown as string,
        s3Key: "k2",
        startOffset: 6540,
        endOffset: 7200,
        duration: 660,
      },
    ],
  });
  assert(chunked.length === 2, "chunks without a videoId are excluded");
  assert(chunked[1].sourceStart === 3270, "actualStartOffset drives the source start");

  assert(toLocalTime(chunked[1], 3600) === 330, "source → chunk-local");
  assert(toSourceTime(chunked[1], 330) === 3600, "chunk-local → source round-trips");

  // 3280 sits in the 30s overlap. The chunk where it is furthest from an edge wins.
  const overlapPick = chunkForTime(chunked, 3280);
  assert(overlapPick?.chunkIndex === 0, "overlap resolves to the more central chunk");
  assert(chunkForTime(chunked, 99999) === undefined, "out-of-range time has no chunk");
}

// ============================================================================
section("Chunks — range planning");
// ============================================================================

{
  const chunks: ChunkFacts[] = [
    { chunkIndex: 0, videoId: "c0", sourceStart: 0, sourceEnd: 3300, indexedDuration: 3300 },
    { chunkIndex: 1, videoId: "c1", sourceStart: 3270, sourceEnd: 6570, indexedDuration: 3300 },
  ];

  const inside = planRange(chunks, 500, 560);
  assert(inside.length === 1, "a range inside one chunk yields one piece");
  assert(inside[0].localStart === 500 && inside[0].localEnd === 560, "local times map 1:1 in chunk 0");
  assert(!inside[0].clamped, "no clamping needed inside a chunk");

  const later = planRange(chunks, 4000, 4100);
  assert(later.length === 1, "a range inside chunk 1 yields one piece");
  assert(later[0].chunk.videoId === "c1", "chunk 1 selected");
  assert(later[0].localStart === 730, "4000s source = 730s into chunk 1");

  // A range wholly inside the overlap must not be split into two calls.
  const overlap = planRange(chunks, 3275, 3295);
  assert(overlap.length === 1, "a range inside the overlap stays a single piece");

  const spanning = planRange(chunks, 3200, 3400);
  assert(spanning.length === 2, "a range crossing the boundary splits");
  assert(
    Math.abs(spanning[0].sourceEnd - spanning[1].sourceStart) < 0.01,
    "the split pieces are contiguous on the source timeline",
  );
  assert(
    Math.abs(spanning[0].sourceStart - 3200) < 0.01 &&
      Math.abs(spanning[1].sourceEnd - 3400) < 0.01,
    "the split covers the whole requested range",
  );

  assert(planRange([], 0, 100).length === 0, "no chunks means no pieces");
  assert(planRange(chunks, 100, 100).length === 0, "a zero-length range yields nothing");
  assert(planRange(chunks, 9000, 9100).length === 0, "a range past the end yields nothing");

  const short = planRange(chunks, 1000, 1002)[0];
  const widened = widenToMinimumClip(short, MIN_CLIP_SEC);
  assert(widened != null, "a short window inside a long chunk can be widened");
  assert(
    Math.abs(widened!.localEnd - widened!.localStart - MIN_CLIP_SEC) < 0.01,
    "widening lands exactly on the minimum",
  );
  assert(widened!.clamped, "widening is reported as an adjustment");

  const atZero = widenToMinimumClip(planRange(chunks, 0, 1)[0], MIN_CLIP_SEC);
  assert(atZero!.localStart === 0, "widening at t=0 never goes negative");
  assert(atZero!.localEnd === MIN_CLIP_SEC, "widening at t=0 extends forward only");

  const tiny: ChunkFacts[] = [
    { chunkIndex: 0, videoId: "t", sourceStart: 0, sourceEnd: 2, indexedDuration: 2 },
  ];
  assert(
    widenToMinimumClip(planRange(tiny, 0, 1)[0], MIN_CLIP_SEC) === null,
    "a chunk shorter than the minimum cannot be widened",
  );
}

// ============================================================================
section("edit_segments — structural guards");
// ============================================================================

{
  const base = [seg("s1", 100, 160, "Opening"), seg("s2", 400, 460, "Middle")];

  const added = applyEdits(base, [{ op: "add", start: 800, end: 860, title: "Ending" }], 3600);
  assert(added.applied.length === 1, "a valid add is applied");
  assert(added.segments.length === 3, "the segment is in the working set");
  assert(added.segments[2].id === "s3", "ids continue the existing sequence");
  assert(added.changedIds.includes("s3"), "an add marks the segment for reframing");

  const batch = applyEdits(
    base,
    [
      { op: "add", start: 800, end: 860, title: "A" },
      { op: "add", start: 900, end: 960, title: "B" },
    ],
    3600,
  );
  assert(batch.applied.length === 2, "a batch of adds all apply");
  assert(
    batch.segments[2].id !== batch.segments[3].id,
    "ids within one batch are distinct",
  );

  const overlapping = applyEdits(base, [{ op: "add", start: 150, end: 200 }], 3600);
  assert(overlapping.applied.length === 0, "an overlapping add is rejected");
  assert(overlapping.rejected[0].conflictsWith === "s1", "the conflict is named");
  assert(overlapping.segments.length === 2, "a rejected op leaves the cut untouched");

  const partial = applyEdits(
    base,
    [
      { op: "add", start: 150, end: 200 },
      { op: "add", start: 900, end: 960, title: "Good" },
    ],
    3600,
  );
  assert(partial.applied.length === 1, "the good op in a mixed batch still applies");
  assert(partial.rejected.length === 1, "the bad op in a mixed batch is reported");

  const reversed = applyEdits([], [{ op: "add", start: 200, end: 100 }], 3600);
  assert(reversed.applied.length === 1, "reversed timestamps are repaired, not rejected");
  assert(reversed.applied[0].start === 100, "the smaller value becomes the start");
  assert(
    reversed.applied[0].notes.some((n) => n.includes("swapped")),
    "the repair is reported back to the model",
  );

  const clamped = applyEdits([], [{ op: "add", start: 3500, end: 4000 }], 3600);
  assert(clamped.applied[0].end === 3600, "an end past the source is clamped");
  assert(
    clamped.applied[0].notes.some((n) => n.includes("Clamped")),
    "clamping is reported",
  );

  const sliver = applyEdits([], [{ op: "add", start: 100, end: 100.2 }], 3600);
  assert(sliver.applied.length === 0, "a 0.2s sliver is a typo, not a segment");

  // The per-segment maximum is the agent's call, not the code's: apply and flag.
  const long = applyEdits([], [{ op: "add", start: 0, end: 300 }], 3600, { max: 120 });
  assert(long.applied.length === 1, "exceeding the per-segment max still applies");
  assert(
    long.applied[0].notes.some((n) => n.includes("over the 120s")),
    "exceeding the per-segment max is reported as a violation",
  );

  const updated = applyEdits(base, [{ op: "update", segmentId: "s1", end: 200 }], 3600);
  assert(updated.applied.length === 1, "update with a partial range works");
  assert(updated.segments[0].endTime === 200, "the new end is stored");
  assert(updated.segments[0].title === "Opening", "an untouched title is preserved");
  assert(updated.changedIds.includes("s1"), "a retimed segment is marked for reframing");

  const retitled = applyEdits(base, [{ op: "update", segmentId: "s1", title: "New" }], 3600);
  assert(retitled.segments[0].title === "New", "title-only update works");
  assert(
    !retitled.changedIds.includes("s1"),
    "a title-only update does not trigger reframing",
  );

  const missing = applyEdits(base, [{ op: "update", segmentId: "nope", end: 1 }], 3600);
  assert(missing.rejected.length === 1, "updating an unknown id is rejected");
  assert(missing.rejected[0].reason.includes("nope"), "the unknown id is named");

  const removed = applyEdits(base, [{ op: "remove", segmentId: "s1" }], 3600);
  assert(removed.segments.length === 1, "remove drops the segment");
  assert(removed.changedIds.includes("s1"), "a removal is part of the framing diff");

  const sorted = applyEdits(base, [{ op: "add", start: 10, end: 70 }], 3600);
  assert(sorted.segments[0].startTime === 10, "the working set stays chronological");

  assert(nextSegmentId([]) === "s1", "the first id is s1");
  assert(nextSegmentId([seg("s7", 0, 1)]) === "s8", "ids never collide with existing ones");
  assert(
    nextSegmentId([seg("custom-id", 0, 1)]) === "s1",
    "non-sequential ids don't break allocation",
  );

  const twoAdds = applyEdits(
    [seg("s1", 0, 60)],
    [
      { op: "add", start: 100, end: 160 },
      { op: "add", start: 200, end: 260 },
    ],
    3600,
  );
  assert(
    twoAdds.segments.map((s) => s.id).join(",") === "s1,s2,s3",
    `ids in one batch stay consecutive, got ${twoAdds.segments.map((s) => s.id).join(",")}`,
  );

  const swapped = applyEdits([], [{ op: "add", start: 200, end: 100 }], 3600);
  assert(swapped.applied.length === 1, "a reversed pair is corrected, not rejected");
  assert(
    swapped.applied[0].notes.some((n) => n.includes("swapped")),
    "the swap is reported",
  );
  assert(
    !swapped.applied[0].notes.some((n) => n.includes("Clamped")),
    "and nothing claims a clamp that never happened",
  );

  const unknownOp = applyEdits([], [{ op: "delete" } as never], 3600);
  assert(
    unknownOp.rejected[0].op === "delete",
    `an unknown op is echoed back as sent, got "${unknownOp.rejected[0].op}"`,
  );
}

// ============================================================================
section("read_transcript");
// ============================================================================

{
  const words: TranscriptWord[] = [
    { start: 10.0, end: 10.3, value: "I" },
    { start: 10.3, end: 10.7, value: "never" },
    { start: 10.7, end: 11.2, value: "wanted" },
    { start: 11.2, end: 11.5, value: "this" },
    // A one-second pause: a clean edge.
    { start: 12.5, end: 12.9, value: "But" },
    { start: 12.9, end: 13.4, value: "here" },
    { start: 13.4, end: 13.7, value: "we" },
    { start: 13.7, end: 14.1, value: "are" },
  ];

  const lines = groupWordsIntoLines(words);
  assert(lines.length === 2, `a 1s pause breaks the line, got ${lines.length}`);
  assert(lines[0].text === "I never wanted this", "the first line groups correctly");
  assert(lines[1].start === 12.5, "the second line starts after the pause");

  const silence = nearestSilence(words, 12.0);
  assert(silence != null, "the pause is found");
  assert(silence!.gapStart === 11.5 && silence!.gapEnd === 12.5, "the gap bounds are exact");
  assert(nearestSilence(words, 500) === null, "no silence within the search window");

  const read = runReadTranscript({
    words,
    start: 9,
    end: 15,
    granularity: "sentences",
    videoDuration: 3600,
  });
  assert(read.ok, "a valid read succeeds");
  assert(read.ok && read.text.includes("I never wanted this"), "the dialogue is returned");
  assert(read.ok && read.text.includes("Edges"), "silence edges are reported for boundary work");

  const silent = runReadTranscript({
    words,
    start: 100,
    end: 200,
    granularity: "sentences",
    videoDuration: 3600,
  });
  assert(silent.ok, "a silent stretch is information, not an error");
  assert(silent.ok && silent.text.includes("silent"), "the silence is stated plainly");

  const zero = runReadTranscript({
    words,
    start: 10,
    end: 10,
    granularity: "sentences",
    videoDuration: 3600,
  });
  assert(!zero.ok, "a zero-length range is an error");
  assert(!zero.ok && zero.hint.length > 0, "the error carries a hint");

  const noWords = runReadTranscript({
    words: [],
    start: 0,
    end: 100,
    granularity: "sentences",
    videoDuration: 3600,
  });
  assert(!noWords.ok, "no transcript is an error");
  assert(
    !noWords.ok && noWords.hint.includes("search_video"),
    "the no-transcript error points at the alternatives",
  );

  // Truncation has to say where it stopped. The coverage gate credits this
  // range as examined, so a read that silently claimed the full span would let
  // a long source pass on footage the agent never saw.
  const many: TranscriptWord[] = [];
  for (let i = 0; i < 40_000; i++) {
    many.push({ start: i * 0.5, end: i * 0.5 + 0.4, value: `word${i}` });
  }
  const long = runReadTranscript({
    words: many,
    start: 0,
    end: 20_000,
    granularity: "sentences",
    videoDuration: 20_000,
  });
  assert(long.ok, "an oversized read still succeeds");
  const covered = long.ok
    ? (long.digest as { coveredEnd?: number }).coveredEnd ?? 0
    : 0;
  assert(covered > 0 && covered < 20_000, "it reports the timestamp it stopped at");
  assert(
    long.ok && (long.warnings ?? []).some((w) => w.includes("not the full range")),
    "and says plainly that the range was not fully covered",
  );
  assert(
    long.ok && long.text.length < TRANSCRIPT_MAX_CHARS + 500,
    "the body respects the character cap",
  );

  const short = runReadTranscript({
    words,
    start: 0,
    end: 100,
    granularity: "sentences",
    videoDuration: 3600,
  });
  assert(
    short.ok && (short.digest as { coveredEnd?: number }).coveredEnd === 100,
    "a read that fits covers the whole range it was asked for",
  );
}

// ============================================================================
async function asyncSections(): Promise<void> {
// ============================================================================

section("watch_clip — guards, widening and chunk mapping");
{
  const facts: VideoFacts = {
    assetId: "a1",
    title: "Test",
    duration: 6570,
    indexId: "idx",
    isChunked: true,
    chunks: [
      { chunkIndex: 0, videoId: "c0", sourceStart: 0, sourceEnd: 3300, indexedDuration: 3300 },
      { chunkIndex: 1, videoId: "c1", sourceStart: 3270, sourceEnd: 6570, indexedDuration: 3300 },
    ],
  };

  const analyzeCalls: Array<Record<string, unknown>> = [];
  const fakeClient = {
    analyze: async (req: Record<string, unknown>) => {
      analyzeCalls.push(req);
      return { data: `answer for ${String(req.video && (req.video as any).assetId)}` };
    },
  } as unknown as TwelveLabs;

  const noQuestion = await runWatchClip({
    client: fakeClient,
    facts,
    start: 100,
    end: 200,
    question: "  ",
    history: [],
  });
  assert(!noQuestion.result.ok, "an empty question is rejected");

  const huge = await runWatchClip({
    client: fakeClient,
    facts,
    start: 0,
    end: MAX_CLIP_WINDOW_SEC + 1,
    question: "what happens?",
    history: [],
  });
  assert(!huge.result.ok, "an absurd window is rejected");
  assert(
    !huge.result.ok && huge.result.code === "window_too_large",
    "the refusal is specific",
  );

  analyzeCalls.length = 0;
  const big = await runWatchClip({
    client: fakeClient,
    facts,
    start: 0,
    end: CLIP_WINDOW_WARN_SEC + 60,
    question: "what happens?",
    history: [],
  });
  assert(big.result.ok, "a large-but-plausible window is allowed, not refused");
  assert(
    big.result.ok && (big.result.warnings ?? []).some((w) => w.includes("minutes")),
    "a large window comes back with a warning attached",
  );

  analyzeCalls.length = 0;
  const tiny = await runWatchClip({
    client: fakeClient,
    facts,
    start: 1000,
    end: 1001,
    question: "who is on screen?",
    history: [],
  });
  assert(tiny.result.ok, "a sub-minimum window is widened rather than refused");
  assert(
    tiny.result.ok && (tiny.result.warnings ?? []).some((w) => w.includes("minimum")),
    "the widening is reported",
  );
  assert(
    Number(analyzeCalls[0].endTime) - Number(analyzeCalls[0].startTime) >= MIN_CLIP_SEC,
    "the request actually sent to Pegasus meets the 4s minimum",
  );

  analyzeCalls.length = 0;
  const inChunk1 = await runWatchClip({
    client: fakeClient,
    facts,
    start: 4000,
    end: 4060,
    question: "who is on screen?",
    history: [],
  });
  assert(inChunk1.result.ok, "watching inside chunk 1 works");
  assert(analyzeCalls.length === 1, "one chunk means one Pegasus call");
  assert(
    (analyzeCalls[0].video as { assetId: string }).assetId === "c1",
    "the correct chunk video id is used",
  );
  assert(
    Math.abs(Number(analyzeCalls[0].startTime) - 730) < 0.01,
    `chunk-local start expected 730, got ${analyzeCalls[0].startTime}`,
  );
  assert(
    inChunk1.result.ok && inChunk1.result.text.includes("source timeline"),
    "the answer header re-anchors elapsed times to the source timeline",
  );

  analyzeCalls.length = 0;
  const across = await runWatchClip({
    client: fakeClient,
    facts,
    start: 3200,
    end: 3400,
    question: "what happens?",
    history: [],
  });
  assert(across.result.ok, "a boundary-spanning window still answers");
  assert(analyzeCalls.length === 2, "it is watched in two passes");
  assert(
    across.result.ok && (across.result.warnings ?? []).some((w) => w.includes("chunks")),
    "the split is disclosed",
  );

  const repeated = await runWatchClip({
    client: fakeClient,
    facts,
    start: 1000,
    end: 1100,
    question: "Do they argue?",
    history: [
      { start: 990, end: 1110, question: "do they ARGUE??", answer: "They argue." },
    ],
  });
  assert(repeated.cacheHit, "asking the same question of covered footage reuses the answer");
  assert(
    repeated.result.ok && repeated.result.text.includes("They argue."),
    "the earlier answer is handed back",
  );

  // A new question about footage already watched is a legitimate second look.
  analyzeCalls.length = 0;
  const newQuestion = await runWatchClip({
    client: fakeClient,
    facts,
    start: 1000,
    end: 1100,
    question: "Who is holding the letter?",
    history: [
      { start: 990, end: 1110, question: "do they argue?", answer: "They argue." },
    ],
  });
  assert(
    !newQuestion.cacheHit && analyzeCalls.length === 1,
    "a different question about the same window is actually watched",
  );
  assert(
    newQuestion.result.ok &&
      (newQuestion.result.warnings ?? []).some((w) => w.includes("They argue.")),
    "and what was learned last time comes along as context",
  );

  assert(
    findOverlappingWatch(
      [{ start: 0, end: 50, question: "", answer: "" }],
      100,
      200,
      "anything",
    ) === null,
    "unrelated prior watches don't count as repeats",
  );
  assert(
    normalizeQuestion("Who's ON screen??") === "who s on screen",
    "question normalization is stable across punctuation and case",
  );

  const unindexed = await runWatchClip({
    client: fakeClient,
    facts: { ...facts, chunks: [] },
    start: 100,
    end: 200,
    question: "what happens?",
    history: [],
  });
  assert(!unindexed.result.ok, "an unindexed asset fails clearly");
  assert(
    !unindexed.result.ok && unindexed.result.hint.includes("read_transcript"),
    "the failure routes the agent to a tool that does work",
  );

  // A window entirely past the end must not be quietly relocated to the tail.
  const pastEnd = await runWatchClip({
    client: fakeClient,
    facts,
    start: 9000,
    end: 9060,
    question: "what happens?",
    history: [],
  });
  assert(
    !pastEnd.result.ok && pastEnd.result.code === "bad_range",
    "a window past the end of the source is refused, not clamped onto the last seconds",
  );

  // When the indexed video forces a different window, say so and label the
  // answer with what was actually watched.
  analyzeCalls.length = 0;
  const shortChunk: VideoFacts = {
    ...facts,
    duration: 100,
    isChunked: false,
    chunks: [
      { chunkIndex: 0, videoId: "solo", sourceStart: 0, sourceEnd: 100, indexedDuration: 40 },
    ],
  };
  const clamped = await runWatchClip({
    client: fakeClient,
    facts: shortChunk,
    start: 30,
    end: 60,
    question: "what happens?",
    history: [],
  });
  assert(clamped.result.ok, "a partially indexed window still answers");
  assert(
    clamped.result.ok &&
      (clamped.result.warnings ?? []).some((w) => w.includes("watched rather than")),
    "the shift away from the requested window is disclosed",
  );
  assert(
    clamped.result.ok &&
      clamped.result.summary.includes(fmtTimecode(40)) &&
      !clamped.result.summary.includes(fmtTimecode(60)),
    `the answer is labelled with the window Pegasus actually saw, got "${clamped.result.ok ? clamped.result.summary : ""}"`,
  );
  assert(
    Number(analyzeCalls[0].endTime) <= 40,
    `the request stays inside the indexed duration, got ${analyzeCalls[0].endTime}`,
  );

  // Rounding must never push an endpoint back past the indexed cap.
  const edgePiece = widenToMinimumClip(
    planRange(shortChunk.chunks, 36, 37)[0],
    MIN_CLIP_SEC,
  );
  const rounded = localWindow(edgePiece!);
  assert(
    rounded.end <= 40 && rounded.end - rounded.start >= MIN_CLIP_SEC,
    `rounded window ${rounded.start}–${rounded.end} must fit the cap and the 4s minimum`,
  );

  // Running out of Lambda time is reported as such, not as a Pegasus failure.
  analyzeCalls.length = 0;
  const outOfTime = await runWatchClip({
    client: fakeClient,
    facts,
    start: 1000,
    end: 1100,
    question: "what happens?",
    history: [],
    deadlineAt: Date.now() + 1000,
  });
  assert(
    !outOfTime.result.ok && analyzeCalls.length === 0,
    "no Pegasus call is started when there is no time to finish it",
  );
  assert(
    !outOfTime.result.ok && /time/i.test(outOfTime.result.message),
    "and the reason given is the clock, not an invented vendor error",
  );
}

section("Search — ranking and time windows");
{
  const hits = [
    { start: 10, end: 20, rank: 2 },
    { start: 30, end: 40, rank: 1 },
  ];
  assert(
    dedupeHits(hits)[0].start === 30,
    "with no score, rank 1 is treated as the strongest match",
  );

  const scored = [
    { start: 10, end: 20, score: 0.4 },
    { start: 30, end: 40, score: 0.9 },
  ];
  assert(dedupeHits(scored)[0].start === 30, "score still wins when present");

  const unranked = [
    { start: 30, end: 40 },
    { start: 10, end: 20 },
  ];
  assert(
    dedupeHits(unranked).length === 2,
    "hits with no ranking information at all are still returned",
  );
  assert(
    byRelevance({ start: 0, end: 1 }, { start: 5, end: 6 }) < 0,
    "unranked hits fall back to timeline order rather than a fabricated score",
  );
}

section("Executor — budget, questions and the guarded finish");
{
  const facts: VideoFacts = {
    assetId: "a1",
    title: "Test",
    duration: 3600,
    indexId: "idx",
    isChunked: false,
    chunks: [{ chunkIndex: 0, videoId: "v", sourceStart: 0, sourceEnd: 3600, indexedDuration: 3600 }],
  };

  // No transcript and no client, so the coverage gate stays off and these cases
  // exercise the arithmetic guard on its own. The gate has its own section.
  const makeCtx = (segments: AgentSegment[], brief: Brief): ExecContext => ({
    projectTitle: "Test",
    client: null,
    facts,
    brief,
    segments,
    cost: emptyCostMeter(),
    watchHistory: [],
    transcriptWords: null,
    examined: [],
    // Edge verification has its own tests; treat every edge as seen here.
    examinedVisual: [{ start: 0, end: facts.duration }],
    askCount: 0,
    finishRefusals: 0,
    searchMisses: 0,
    searchSeen: [],
    blindSpotRefusals: 0,
    onProgress: async () => undefined,
  });

  const brief: Brief = { format: "compact_video", targetSeconds: 300 };

  const budget = await executeTool("check_budget", {}, makeCtx([seg("s1", 0, 300)], brief));
  assert(budget.result.ok, "check_budget always succeeds");
  assert(budget.ledger?.target.status === "within", "check_budget reports the real status");

  const shortCtx = makeCtx([seg("s1", 0, 60)], brief);
  const firstFinish = await executeTool("finish_turn", { summary: "done" }, shortCtx);
  assert(!firstFinish.result.ok, "finishing under target is refused the first time");
  assert(
    !firstFinish.result.ok && firstFinish.result.message.includes("UNDER"),
    "the refusal shows the actual arithmetic",
  );
  assert(shortCtx.finishRefusals === 1, "the refusal is counted");

  const secondFinish = await executeTool(
    "finish_turn",
    { summary: "shorter on purpose", concerns: ["The source only had 60s worth"] },
    shortCtx,
  );
  assert(secondFinish.result.ok, "the second finish goes through");
  assert(secondFinish.control?.kind === "finish", "the finish signal reaches the loop");
  assert(
    secondFinish.control?.kind === "finish" &&
      secondFinish.control.concerns.some((c) => c.startsWith("Unresolved:")),
    "unresolved violations ride along as concerns instead of being silently dropped",
  );

  const cleanCtx = makeCtx([seg("s1", 0, 300)], brief);
  const cleanFinish = await executeTool("finish_turn", { summary: "done" }, cleanCtx);
  assert(cleanFinish.result.ok, "a clean cut finishes first time");
  assert(cleanCtx.finishRefusals === 0, "no refusal when there is nothing blocking");

  const askCtx = makeCtx([seg("s1", 0, 300)], brief);
  const ask = await executeTool(
    "ask_user",
    { question: "Cold open or chronological?", suggestions: ["Cold open", "Chronological"] },
    askCtx,
  );
  assert(ask.control?.kind === "ask_user", "ask_user suspends the run");
  askCtx.askCount = MAX_ASKS_PER_RUN;
  const tooMany = await executeTool("ask_user", { question: "One more?" }, askCtx);
  assert(!tooMany.result.ok, "the question budget is enforced");
  assert(
    !tooMany.result.ok && tooMany.result.hint.includes("judgment"),
    "hitting the question limit tells the agent to decide for itself",
  );

  const editCtx = makeCtx([], brief);
  const edited = await executeTool(
    "edit_segments",
    { ops: [{ op: "add", start: 0, end: 300, title: "The whole thing" }] },
    editCtx,
  );
  assert(edited.result.ok, "a valid edit succeeds");
  assert(edited.segmentsChanged === true, "the loop is told to commit");
  assert(edited.result.ok && edited.result.text.includes("BUDGET"), "every edit returns the budget");
  assert(editCtx.segments.length === 1, "the working set is mutated in place");

  const noOps = await executeTool("edit_segments", {}, makeCtx([], brief));
  assert(!noOps.result.ok, "an edit with no ops is an error");

  const allRejected = await executeTool(
    "edit_segments",
    { ops: [{ op: "add", start: 5, end: 5.1 }] },
    makeCtx([], brief),
  );
  assert(!allRejected.result.ok, "an edit where everything is rejected is an error");
  assert(
    !allRejected.result.ok && allRejected.result.message.includes("Rejected"),
    "the rejection reasons come back with it",
  );

  const transcriptless = await executeTool(
    "read_transcript",
    { start: 0, end: 60 },
    makeCtx([], brief),
  );
  assert(!transcriptless.result.ok, "reading a transcript that doesn't exist fails clearly");

  const noClient = await executeTool("search_video", { query: "x" }, makeCtx([], brief));
  assert(!noClient.result.ok, "searching without a configured client fails clearly");
  assert(
    !noClient.result.ok && noClient.result.hint.length > 0,
    "even an infrastructure failure tells the agent what to do next",
  );

  const bogus = await executeTool(
    "not_a_tool" as never,
    {},
    makeCtx([], brief),
  );
  assert(!bogus.result.ok, "an unknown tool name is a structured error, not a crash");

  const errorsCounted = makeCtx([], brief);
  await executeTool("edit_segments", {}, errorsCounted);
  assert(errorsCounted.cost.toolErrors === 1, "tool failures are metered");
  assert(errorsCounted.cost.toolCalls === 1, "tool calls are metered");
}

section("Coverage gate — you cannot finish on footage you never opened");
{
  // The real shape of the failure this gate exists for: a 42-minute source
  // where the agent cut six segments and left 0:03–19:39 both uncut and
  // unexamined, then finished successfully.
  const DURATION = 2536;
  const facts: VideoFacts = {
    assetId: "a1",
    title: "Paris",
    duration: DURATION,
    indexId: "idx",
    isChunked: false,
    chunks: [
      { chunkIndex: 0, videoId: "v", sourceStart: 0, sourceEnd: DURATION, indexedDuration: DURATION },
    ],
    transcriptS3Uri: "s3://bucket/t.json",
  };

  const words: TranscriptWord[] = [];
  for (let t = 0; t < DURATION; t += 2) {
    words.push({ start: t, end: t + 1.5, value: t % 10 === 0 ? "breakfast" : "word" });
  }

  const makeCtx = (segments: AgentSegment[], examined: Array<{ start: number; end: number }>): ExecContext => ({
    projectTitle: "Test",
    client: null,
    facts,
    brief: { format: "compact_video" },
    segments,
    cost: emptyCostMeter(),
    watchHistory: [],
    transcriptWords: words,
    examined,
    // Edge verification has its own tests; treat every edge as seen here.
    examinedVisual: [{ start: 0, end: facts.duration }],
    askCount: 0,
    finishRefusals: 0,
    searchMisses: 0,
    searchSeen: [],
    blindSpotRefusals: 0,
    onProgress: async () => undefined,
  });

  const run1 = makeCtx(
    [seg("s1", 0, 180), seg("s2", 1179, 1317), seg("s3", 1401, 1729), seg("s4", 2180, 2536)],
    [{ start: 0, end: 252 }, { start: 600, end: 2536 }],
  );
  const blocked = await executeTool("finish_turn", { summary: "done" }, run1);
  assert(!blocked.result.ok, "a finish with an unexamined stretch is refused");
  assert(
    !blocked.result.ok && blocked.result.code === "unexamined_footage",
    "the refusal is distinct from an arithmetic violation",
  );
  assert(
    !blocked.result.ok && blocked.result.message.includes("4:12"),
    "the refusal names the stretch that was never opened",
  );
  assert(
    !blocked.result.ok && blocked.result.hint.includes("read_transcript"),
    "the refusal points at the cheapest way to clear it",
  );
  assert(run1.blindSpotRefusals === 1, "the coverage refusal is counted separately");

  // Unlike the arithmetic guard there is no talking your way past this one.
  const second = await executeTool("finish_turn", { summary: "still done" }, run1);
  assert(
    !second.result.ok,
    "arguing does not clear the gate the way it clears a budget violation",
  );

  const readWide = await executeTool("read_transcript", { start: 240, end: 620 }, run1);
  assert(readWide.result.ok, "the stretch can be read");
  const afterReading = await executeTool("finish_turn", { summary: "done" }, run1);
  assert(afterReading.result.ok, "going and looking is what clears the gate");

  // Watching counts the same as reading, so a scene with no dialogue at all is
  // satisfiable and a broken transcript cannot produce a false pass.
  const visual = makeCtx([seg("s1", 0, 180)], [{ start: 180, end: DURATION }]);
  const visualFinish = await executeTool("finish_turn", { summary: "done" }, visual);
  assert(visualFinish.result.ok, "an examined-but-uncut stretch is not a blind spot");

  const framesOnly = makeCtx([], [{ start: 0, end: DURATION }]);
  const framesFinish = await executeTool("finish_turn", { summary: "done" }, framesOnly);
  assert(
    !framesFinish.result.ok && framesFinish.result.code !== "unexamined_footage",
    "a fully examined but empty cut is stopped by the arithmetic, not by coverage",
  );

  // A run with nothing to examine with must still be able to end.
  const helpless: ExecContext = {
    ...makeCtx([seg("s1", 0, 180)], []),
    client: null,
    facts: { ...facts, transcriptS3Uri: undefined },
    transcriptWords: [],
  };
  const helplessFinish = await executeTool("finish_turn", { summary: "done" }, helpless);
  assert(
    helplessFinish.result.ok,
    "with no transcript and no client there is nothing to examine with, so the gate is off",
  );

  // A deliberately sparse cut is the normal case, not a failure. Asking for 10%
  // of a 42-minute source leaves enormous gaps, and none of them are blind
  // spots once the agent has read the timeline.
  const sparse = makeCtx(
    [seg("s1", 300, 380), seg("s2", 1200, 1280), seg("s3", 2100, 2190)],
    [{ start: 0, end: DURATION }],
  );
  sparse.brief = { format: "compact_video", targetPercent: 10 };
  const sparseFinish = await executeTool("finish_turn", { summary: "10% cut" }, sparse);
  assert(
    sparseFinish.result.ok,
    "a 10% cut with huge gaps finishes cleanly when the whole source was examined",
  );
  const sparseLedger = sparseFinish.ledger;
  assert(
    (sparseLedger?.coverage.largestGap?.seconds ?? 0) > 800,
    "the gaps really are enormous — the gate is not quietly forbidding them",
  );

  // One wide read is enough to clear the gate on a typical episode, which is
  // what keeps a hard block affordable.
  const fromScratch = makeCtx([seg("s1", 300, 380)], []);
  const oneRead = await executeTool(
    "read_transcript",
    { start: 0, end: DURATION },
    fromScratch,
  );
  assert(oneRead.result.ok, "the whole transcript can be read in one call");
  const afterOneRead = await executeTool("finish_turn", { summary: "done" }, fromScratch);
  assert(
    afterOneRead.result.ok,
    "a single wide read clears coverage for the entire source",
  );

  // The search breaker must not be a one-way door. It trips to push the agent
  // off search and onto the timeline; having gone and looked, it may search the
  // new territory. Only a genuinely new look re-arms it.
  const breaker = makeCtx([], [{ start: 0, end: 600 }]);
  breaker.searchMisses = SEARCH_UNPRODUCTIVE_STOP_AT;
  const reread = await executeTool("read_transcript", { start: 0, end: 300 }, breaker);
  assert(reread.result.ok, "re-reading known ground still works");
  assert(
    breaker.searchMisses === SEARCH_UNPRODUCTIVE_STOP_AT,
    "but re-reading what you already read does not re-arm search",
  );
  const newGround = await executeTool("read_transcript", { start: 600, end: 1200 }, breaker);
  assert(newGround.result.ok, "reading somewhere new works");
  assert(breaker.searchMisses === 0, "and that does re-arm search");

  // The escape hatch: a run that cannot satisfy the gate still ends, loudly.
  const stubborn = makeCtx([seg("s1", 0, 180)], []);
  let last = await executeTool("finish_turn", { summary: "done" }, stubborn);
  for (let i = 0; i < MAX_BLIND_SPOT_REFUSALS; i++) {
    last = await executeTool("finish_turn", { summary: "done" }, stubborn);
  }
  assert(last.result.ok, "the gate gives up rather than burning every remaining step");
  assert(
    last.control?.kind === "finish" &&
      last.control.concerns.some((c) => c.startsWith("Never examined:")),
    "a cut signed off with unexamined footage says so in the concerns",
  );
}
}

// ============================================================================
section("Coverage — blind spots, floors and the ledger");
// ============================================================================

{
  assert(
    findBlindSpots({
      examined: [{ start: 0, end: 100 }],
      segments: [],
      videoDuration: 1000,
      floorSec: 120,
    }).length === 1,
    "an unexamined tail is a blind spot",
  );
  assert(
    findBlindSpots({
      examined: [{ start: 0, end: 1000 }],
      segments: [],
      videoDuration: 1000,
      floorSec: 120,
    }).length === 0,
    "a fully examined timeline has none",
  );
  assert(
    findBlindSpots({
      examined: [{ start: 0, end: 500 }],
      segments: [seg("s1", 500, 1000)],
      videoDuration: 1000,
      floorSec: 120,
    }).length === 0,
    "a segment accounts for its own span",
  );
  assert(
    findBlindSpots({
      examined: [{ start: 0, end: 950 }],
      segments: [],
      videoDuration: 1000,
      floorSec: 120,
    }).length === 0,
    "a gap under the floor is not worth objecting to",
  );

  assert(
    mergeIntervals([
      { start: 0, end: 10 },
      { start: 10.2, end: 20 },
      { start: 50, end: 60 },
    ]).length === 2,
    "adjacent looks join into one interval",
  );
  assert(
    recordExamined([], 100, 50, 1000)[0].start === 50,
    "a reversed range is still recorded the right way round",
  );
  assert(
    recordExamined([], -10, 2000, 1000)[0].end === 1000,
    "examination is clamped to the timeline",
  );

  assert(
    blindSpotFloor(2536, false) > blindSpotFloor(2536, true),
    "the bar is lower when examining costs nothing but a transcript read",
  );
  assert(
    blindSpotFloor(10800, true) > blindSpotFloor(2000, true),
    "a longer source gets a proportionally looser floor so the gate stays clearable",
  );
  assert(
    blindSpotFloor(10800, false) > blindSpotFloor(2536, false),
    "without a transcript the floor scales too — sweeping three hours with Pegasus alone is not affordable at a fixed resolution",
  );
  assert(
    blindSpotFloor(2536, true) <= 300 && blindSpotFloor(2536, true) >= 120,
    "a typical episode stays inside the tight band",
  );

  const ledger = computeLedger([seg("s1", 0, 180)], { format: "compact_video" }, 2536, {
    examined: [{ start: 0, end: 600 }],
    hasTranscript: true,
  });
  assert(ledger.coverage.blindSpots.length === 1, "the ledger carries the blind spots");
  assert(
    ledger.blocking.length === 0,
    "blind spots stay out of `blocking` — the two gates are answered differently",
  );
  assert(
    renderLedger(ledger).includes("NOT YET LOOKED AT"),
    "the model reads the blind spots in the budget it is given every turn",
  );
  assert(
    renderLedger(ledger).includes("Examined so far"),
    "the budget states how much of the source has been examined",
  );

  const noCoverage = computeLedger([seg("s1", 0, 180)], { format: "compact_video" }, 2536);
  assert(
    noCoverage.coverage.blindSpots.length === 0,
    "omitting coverage input leaves the gate entirely off",
  );
}

// ============================================================================
section("Auto-framing gate — what a completed run decides to frame");
// ============================================================================

{
  const framed = { ...seg("s1", 0, 30), framing: { mode: "crop" } };
  const bare = seg("s2", 30, 60);
  assert(
    unframedSegmentIds([framed, bare]).join(",") === "s2",
    "only segments without framing are queued",
  );
  assert(
    unframedSegmentIds([framed]).length === 0,
    "a fully framed cut starts no job",
  );
  // Timing edits clear framing on commit, which is what puts a segment back in
  // the queue on the next completed run.
  assert(
    unframedSegmentIds([{ ...framed, framing: undefined }]).join(",") === "s1",
    "a segment whose framing was cleared by an edit is queued again",
  );

  const justNow = new Date().toISOString();
  const longAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();

  assert(!isFramingJobActive(null), "no job means nothing is running");
  assert(
    isFramingJobActive({ status: "pending", startedAt: justNow }),
    "a fresh pending job blocks a second one",
  );
  assert(
    isFramingJobActive({ status: "analyzing", startedAt: justNow }),
    "a job mid-analysis blocks a second one",
  );
  assert(
    !isFramingJobActive({ status: "completed", startedAt: justNow }),
    "a finished job does not block the next run",
  );
  assert(
    !isFramingJobActive({ status: "failed", startedAt: justNow }),
    "a failed job does not block a retry",
  );
  assert(
    !isFramingJobActive({ status: "analyzing", startedAt: longAgo }),
    "a job stalled past the stale threshold is overwritten, as analyzeFraming does",
  );
  // analyzeFraming treats an unreadable startedAt as stale; disagreeing here
  // would strand the project with auto-framing off and no way to notice.
  assert(
    !isFramingJobActive({ status: "pending" }),
    "a job row with no startedAt does not disable auto-framing forever",
  );
}

// ============================================================================
section("Panel inputs — autoFrame survives a follow-up message");
// ============================================================================

{
  // A follow-up message carries no brief, so the toggle has to come off the
  // project row or framing silently stops happening mid-conversation.
  const savedOn = metadataToBrief(
    briefToGenerationInputs({ autoFrame: true, targetAspectRatio: "1:1" }) as Record<
      string,
      unknown
    >,
  );
  assert(savedOn.autoFrame === true, "an on toggle round-trips through metadata");
  assert(
    savedOn.targetAspectRatio === "1:1",
    "the aspect ratio round-trips with it",
  );

  const savedOff = metadataToBrief(
    briefToGenerationInputs({ autoFrame: false }) as Record<string, unknown>,
  );
  assert(savedOff.autoFrame === false, "an off toggle round-trips as off");

  // Untouched is not the same as off: it must not write a value that would
  // later read back as an explicit choice the user never made.
  assert(
    briefToGenerationInputs({ format: "compact_video" }).autoFrame === undefined,
    "a brief that never mentions framing writes no toggle",
  );
  assert(
    metadataToBrief({ autoFrame: "yes" }).autoFrame === undefined,
    "a non-boolean toggle in legacy metadata is ignored, not coerced",
  );
}

// ============================================================================
section("Name grounding — titles may not invent proper nouns");
// ============================================================================

{
  // Drawn from the real transcript, mangled exactly as the ASR mangled it.
  const spoken = "so here we are all that's left of layale once the thriving central marketplace at least i'm up at the perfect hour to explore rangis market this guy peter is an artisanal absent distiller pascal pinot the baker denise";
  const vocab = buildVocabulary({
    transcriptWords: spoken.split(" ").map((value) => ({ value })),
    title: "Anthony Bourdain: Paris",
  });

  assert(
    findUngroundedNames(vocab, "Anthony meets Philippe at the absinthe bar").includes("Philippe"),
    "a name the source never says is flagged",
  );
  assert(
    findUngroundedNames(vocab, "Lunch at Brasserie Balzar").includes("Balzar"),
    "a plausible but absent proper noun is flagged",
  );
  assert(
    findUngroundedNames(vocab, "Dawn at Rungis market").length === 0,
    "a name the transcript garbles as 'rangis' is not flagged",
  );
  assert(
    findUngroundedNames(vocab, "Peter pours the 1910 absinthe").length === 0,
    "a name spoken verbatim is not flagged",
  );
  assert(
    findUngroundedNames(vocab, "Bourdain wanders the sewers").length === 0,
    "a name from the asset title is legitimate even if nobody says it",
  );
  assert(
    findUngroundedNames(vocab, "Pascal Pinot shapes the dough").length === 0,
    "multi-word real names pass",
  );
  assert(
    findUngroundedNames(vocab, "Breakfast in a Parisian cafe").length === 0,
    "an inflection of a spoken word is not a fabricated name",
  );
  assert(
    findUngroundedNames(vocab, "Peter explains the ritual").length === 0,
    "a capitalized first word is never itself evidence of a name",
  );
}

// ============================================================================
section("Context assembly");
// ============================================================================

{
  const ledger = computeLedger([seg("s1", 0, 300)], { format: "compact_video", targetSeconds: 300 }, 3600);
  const live = renderLiveState({
    projectTitle: "Test",
    segments: [seg("s1", 0, 300, "Opening")],
    ledger,
    cost: emptyCostMeter(),
    iterations: 3,
  });
  assert(live.includes("<live_state>"), "the live state is delimited");
  assert(live.includes("Opening"), "the segment table is included");
  assert(live.includes("INSIDE the target band"), "the verdict is spelled out");

  const nearLimit = renderLiveState({
    projectTitle: "Test",
    segments: [],
    ledger,
    cost: emptyCostMeter(),
    iterations: 55,
  });
  assert(
    nearLimit.includes("tool steps remain"),
    "the agent is warned before it runs out of steps",
  );

  const messages = assembleMessages({
    turns: [
      { role: "user", content: [{ type: "text", text: "Cut this down." }] },
      { role: "assistant", content: [{ type: "text", text: "On it." }] },
      { role: "user", content: [{ type: "text", text: "Focus on the fight." }] },
    ],
    summary: "Earlier: found three beats.",
    toolLedger: [{ name: "search_video", line: 'searched "fight" → 4 hits', ok: true }],
    liveState: live,
  });
  assert(messages[0].role === "user", "the conversation starts with a user turn");
  assert(
    JSON.stringify(messages[0].content).includes("session_summary"),
    "the summary is folded into the first user turn, not a fake assistant reply",
  );
  assert(
    JSON.stringify(messages[0].content).includes("earlier_tool_calls"),
    "the tool ledger digest rides along with it",
  );
  const lastContent = JSON.stringify(messages[messages.length - 1].content);
  assert(lastContent.includes("<live_state>"), "the live state is the last thing the model reads");
  assert(messages[messages.length - 1].role === "user", "it lands on a user turn");

  // Prompt caching. The message history is where essentially all the input
  // tokens are — a long run re-sends it on every step — so a breakpoint has to
  // sit on the history, not just on the static system blocks.
  const breakpoints = JSON.stringify(messages).split('"cache_control"').length - 1;
  assert(breakpoints > 0, "the message history carries a cache breakpoint");
  assert(breakpoints <= 3, "and stays inside the four the API allows once system blocks are counted");

  const liveBlock = messages[messages.length - 1].content.find(
    (b) => (b as { text?: string }).text?.includes("<live_state>"),
  ) as Record<string, unknown> | undefined;
  assert(
    liveBlock !== undefined && !("cache_control" in liveBlock),
    "the live-state block stays outside the cached prefix, since it changes every turn",
  );

  const systemBlocks = buildSystemBlocks({
    facts: {
      assetId: "a",
      title: "t",
      duration: 100,
      indexId: "i",
      isChunked: false,
      chunks: [],
    },
  });
  assert(
    systemBlocks.filter((b) => b.cache_control).length === 1,
    "one system breakpoint, not one per block — the prefix is what gets cached",
  );
  assert(
    systemBlocks[systemBlocks.length - 1].cache_control !== undefined,
    "and it sits on the last block so it covers everything above it",
  );

  // The blocks are shared with the turns that get written to DynamoDB.
  const sharedTurns = [
    { role: "user" as const, content: [{ type: "text", text: "hello" }] },
    { role: "assistant" as const, content: [{ type: "text", text: "hi" }] },
    { role: "user" as const, content: [{ type: "text", text: "again" }] },
  ];
  assembleMessages({ turns: sharedTurns, toolLedger: [], liveState: "x" });
  assert(
    !JSON.stringify(sharedTurns).includes("cache_control"),
    "marking a breakpoint never mutates the turns that get persisted",
  );

  // Tool results must stay attached to the assistant turn that requested them.
  const toolTurns = assembleMessages({
    turns: [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "check_budget", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] }],
      },
    ],
    toolLedger: [],
    liveState: "<live_state>x</live_state>",
  });
  const finalBlocks = toolTurns[toolTurns.length - 1].content as Array<{ type: string }>;
  assert(finalBlocks[0].type === "tool_result", "the tool result stays first in its turn");
  assert(
    finalBlocks[finalBlocks.length - 1].type === "text",
    "the live state is appended after the tool result, not as a new turn",
  );
}

// ============================================================================
section("Context — a truncated history is still legal to send");
// ============================================================================

{
  // Claude rejects a conversation that opens with an assistant turn, and a
  // tool_result whose tool_use is gone. Compaction produces both.
  const orphaned = repairHistoryHead([
    { role: "assistant", content: [{ type: "tool_use", id: "t9", name: "search_video", input: {} }] },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t9", content: [{ type: "text", text: "4 hits" }] }],
    },
    { role: "assistant", content: [{ type: "text", text: "Found them." }] },
  ]);
  assert(orphaned[0].role === "user", "the repaired history opens with a user turn");
  assert(
    JSON.stringify(orphaned[0].content).includes("4 hits"),
    "the orphaned result is kept as text rather than thrown away",
  );
  assert(
    !JSON.stringify(orphaned[0].content).includes("tool_result"),
    "and no longer references a tool_use that is not in the conversation",
  );

  const alreadyFine = repairHistoryHead([
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ]);
  assert(alreadyFine.length === 2, "a well-formed history is left alone");
  assert(
    (alreadyFine[0].content[0] as { text: string }).text === "go",
    "including its first turn",
  );

  assert(
    repairHistoryHead([{ role: "assistant", content: [{ type: "text", text: "x" }] }])
      .length === 0,
    "a history with nothing but assistant turns yields nothing to send",
  );

  // Even without a summary to fold in, the request must open with a user turn.
  const assistantFirst = assembleMessages({
    turns: [{ role: "assistant", content: [{ type: "text", text: "orphan" }] }],
    toolLedger: [],
    liveState: "<live_state>x</live_state>",
  });
  assert(
    assistantFirst[0].role === "user",
    "an assistant-only history still produces a user-first request",
  );
}

// ============================================================================

asyncSections()
  .then(() => {
    console.log(
      `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks passed`,
    );
    if (failures > 0) process.exit(1);
  })
  .catch((err) => {
    console.error("\nFAIL — the suite threw:", err);
    process.exit(1);
  });
