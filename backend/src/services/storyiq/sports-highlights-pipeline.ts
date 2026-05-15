/**
 * Sports replays via Pegasus 1.5 **async segment API** (`analyzeAsync.tasks.create`,
 * `analysisMode: time_based_metadata`, `segment_definitions`). Output clips use only
 * **replay footage** time ranges from the broadcast (not live plays), filtered to key replays.
 *
 * For chunked videos (>60min), runs Pegasus on each chunk in parallel using
 * their existing TwelveLabs asset IDs (no S3 re-download), then merges results.
 */

import type { TwelveLabs, TwelvelabsApi } from "twelvelabs-js";
import { pegasusIndexedVideoDurationSec, type TwelveLabsWrapper } from "../twelvelabs";
import {
  createQlioPegasusSegmentationTask,
  parsePegasusSegmentationData,
  pollPegasusAnalyzeTask,
} from "../pegasus-segmentation";
import {
  Purpose,
  type FinalSegments,
  type TranscriptSegment,
  type VideoMetadata,
} from "./types";
import {
  sportsReplayDetectionDefinitionsForGeneration,
  parseReplayDetectionResponse,
  extractReplayedPlays,
  filterKeyReplayedPlays,
  replayClipsToProposedSegments,
  type ReplayedPlay,
  type ReplayDetectionResult,
  type RawReplaySegment,
} from "./sports-replay-detection";

// ============================================================================
// Types
// ============================================================================

// Default sports segment duration bounds
const SPORTS_DEFAULT_MIN_SEGMENT_SEC = 5;
const SPORTS_DEFAULT_MAX_SEGMENT_SEC = 30;

export interface SportsHighlightsOptions {
  metadata: VideoMetadata;
  transcript: TranscriptSegment[];
  userInstructions?: string;
  maxPollWaitMs?: number;
  /** Min per-segment length in seconds (default: 5) */
  minSegmentDuration?: number;
  /** Max per-segment length in seconds (default: 30) */
  maxSegmentDuration?: number;
}

export interface SportsHighlightsResult extends FinalSegments {
  /** Raw replay detection data for debugging/display */
  replayData: ReplayDetectionResult;
  /** Plays that were selected (if filtering was applied) */
  selectedPlays: ReplayedPlay[];
  /** Plays that were dropped (if filtering was applied) */
  droppedPlays: ReplayedPlay[];
}

// ============================================================================
// Video Context Resolution (handles chunked videos)
// ============================================================================

interface VideoContextResult {
  video?: TwelvelabsApi.VideoContext;
  chunks?: Array<{
    videoId: string;
    startOffset: number;
    endOffset: number;
    chunkIndex: number;
    /** Upper bound for `time_ranges` on this TwelveLabs asset (`[0, duration)`). */
    indexedVideoTimelineSec: number;
  }>;
  isChunked: boolean;
}

async function resolveVideoContextForPegasus(
  twelvelabs: TwelveLabsWrapper,
  assetId: string,
): Promise<VideoContextResult> {
  const asset = await twelvelabs.getAssetInfo(assetId);

  // Non-chunked video with asset ID — best case
  if (!asset.isChunked && asset.twelveLabsVideoId) {
    console.log(
      `[SportsHighlights] Using asset_id (no S3 egress): ${asset.twelveLabsVideoId}`,
    );
    return {
      video: { type: "asset_id", assetId: asset.twelveLabsVideoId },
      isChunked: false,
    };
  }

  // Chunked video — use each chunk's videoId for parallel processing
  if (asset.isChunked && asset.chunks && asset.chunks.length > 0) {
    const validChunks = asset.chunks.filter((c) => c.videoId);
    if (validChunks.length > 0) {
      console.log(
        `[SportsHighlights] Chunked video: ${validChunks.length} chunks with asset IDs (no S3 egress)`,
      );
      return {
        chunks: validChunks.map((c) => ({
          videoId: c.videoId!,
          startOffset: c.actualStartOffset ?? c.startOffset,
          endOffset: c.endOffset,
          chunkIndex: c.chunkIndex,
          indexedVideoTimelineSec: pegasusIndexedVideoDurationSec(c),
        })),
        isChunked: true,
      };
    }
    throw new Error(
      `[SportsHighlights] Chunked video ${assetId} has no chunk videoIds. Re-index the video.`,
    );
  }

  throw new Error(
    `[SportsHighlights] Asset ${assetId} has no TwelveLabs asset ID. Re-index the video.`,
  );
}

// ============================================================================
// Virtual Chunking for Sports (15-min segments for better parallelism)
// ============================================================================

const SPORTS_CHUNK_DURATION_SEC = 900; // 15 minutes
const SPORTS_CHUNK_OVERLAP_SEC = 30; // 30 second overlap for deduplication

interface VirtualChunk {
  chunkIndex: number;
  startTime: number;
  endTime: number;
  videoId: string;
}

/**
 * Create virtual chunks for a single video asset.
 * For sports, we use 15-minute segments to maximize parallelism.
 */
function createVirtualChunks(
  videoId: string,
  videoDuration: number,
  chunkDuration: number = SPORTS_CHUNK_DURATION_SEC,
  overlap: number = SPORTS_CHUNK_OVERLAP_SEC,
): (VirtualChunk & { _physicalOffset: number })[] {
  const chunks: (VirtualChunk & { _physicalOffset: number })[] = [];
  let start = 0;
  let index = 0;

  while (start < videoDuration) {
    let end = Math.min(start + chunkDuration, videoDuration);

    // Ensure minimum 4-second duration for TwelveLabs
    const duration = end - start;
    if (duration < MIN_CHUNK_DURATION_SEC) {
      // Extend start backward if possible
      if (start >= MIN_CHUNK_DURATION_SEC) {
        start = end - MIN_CHUNK_DURATION_SEC;
      } else {
        // Too short and can't extend - skip
        console.warn(`[SportsHighlights] Last virtual chunk too short (${duration}s), skipping`);
        break;
      }
    }

    chunks.push({
      chunkIndex: index,
      startTime: start,
      endTime: end,
      videoId,
      _physicalOffset: 0, // Single video, no physical offset
    });

    // Next chunk starts (chunkDuration - overlap) after this one
    start = start + chunkDuration - overlap;
    index++;
  }

  return chunks;
}

// ============================================================================
// Parallel Chunk Processing
// ============================================================================

interface ChunkTaskResult {
  chunkIndex: number;
  startOffset: number;
  endOffset: number;
  segments: RawReplaySegment[];
  taskId: string;
}

/**
 * Run replay detection on physical chunks in parallel.
 * Each chunk is processed as a full video with min/maxSegmentDuration constraints.
 * No timeRanges used (they're incompatible with segment duration constraints).
 */
async function runReplayDetectionOnPhysicalChunks(
  client: TwelveLabs,
  chunks: NonNullable<VideoContextResult["chunks"]>,
  segmentDefinitions: TwelvelabsApi.SegmentDefinition[],
  options: {
    customIdPrefix: string;
    maxPollWaitMs: number;
    minSegmentDuration: number;
    maxSegmentDuration: number;
  },
): Promise<ChunkTaskResult[]> {
  console.log(`[SportsHighlights] Starting ${chunks.length} physical chunk tasks in parallel`);

  // Create all tasks in parallel
  const createPromises = chunks.map(async (chunk) => {
    const customId = `${options.customIdPrefix}-c${chunk.chunkIndex}`.slice(0, 64);
    console.log(
      `[SportsHighlights] Creating task for chunk ${chunk.chunkIndex}: ` +
        `videoId=${chunk.videoId}, offset=${Math.round(chunk.startOffset)}s`,
    );

    const created = await createQlioPegasusSegmentationTask(client, {
      video: { type: "asset_id", assetId: chunk.videoId },
      customId,
      segmentDefinitions,
      minSegmentDuration: options.minSegmentDuration,
      maxSegmentDuration: options.maxSegmentDuration,
    });

    return { chunk, taskId: created.taskId };
  });

  const createdTasks = await Promise.all(createPromises);
  console.log(`[SportsHighlights] All ${createdTasks.length} chunk tasks created, polling...`);

  // Poll all tasks in parallel
  const pollPromises = createdTasks.map(async ({ chunk, taskId }) => {
    try {
      const task = await pollPegasusAnalyzeTask(client, taskId, {
        intervalMs: 5000,
        maxWaitMs: options.maxPollWaitMs,
      });

      const parsed = parsePegasusSegmentationData(task.result?.data);
      const segments = parseReplayDetectionResponse(parsed);

      console.log(`[SportsHighlights] Chunk ${chunk.chunkIndex} complete: ${segments.length} segments`);

      return {
        chunkIndex: chunk.chunkIndex,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        segments,
        taskId,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[SportsHighlights] Chunk ${chunk.chunkIndex} (task ${taskId}) failed: ${msg}`);
    }
  });

  return Promise.all(pollPromises);
}

const MIN_CHUNK_DURATION_SEC = 4; // TwelveLabs minimum for startTime/endTime clips

/**
 * Create virtual chunks from physical chunks.
 * Each physical chunk gets split into 15-min virtual chunks with overlap.
 * Returns virtual chunks with proper offsets for the original video timeline.
 */
function createVirtualChunksFromPhysical(
  physicalChunks: NonNullable<VideoContextResult["chunks"]>,
): (VirtualChunk & { _physicalOffset: number })[] {
  const allVirtual: (VirtualChunk & { _physicalOffset: number })[] = [];
  let globalIndex = 0;

  for (const physical of physicalChunks) {
    // Skip chunks without videoId
    if (!physical.videoId) {
      console.warn(`[SportsHighlights] Physical chunk ${physical.chunkIndex} has no videoId, skipping`);
      continue;
    }

    const physicalDuration = physical.indexedVideoTimelineSec;

    if (!(physicalDuration > 0 && Number.isFinite(physicalDuration))) {
      console.warn(
        `[SportsHighlights] Chunk ${physical.chunkIndex} invalid indexed timeline (${physicalDuration}), skipping`,
      );
      continue;
    }

    // If the entire physical chunk is < 4s, skip it (TwelveLabs minimum)
    if (physicalDuration < MIN_CHUNK_DURATION_SEC) {
      console.warn(`[SportsHighlights] Physical chunk ${physical.chunkIndex} too short (${physicalDuration}s), skipping`);
      continue;
    }

    // Create virtual chunks within this physical chunk's LOCAL coordinate space
    let localStart = 0;

    while (localStart < physicalDuration) {
      let localEnd = Math.min(localStart + SPORTS_CHUNK_DURATION_SEC, physicalDuration);

      // Ensure minimum 4-second duration for TwelveLabs
      const chunkDuration = localEnd - localStart;
      if (chunkDuration < MIN_CHUNK_DURATION_SEC) {
        // Extend into previous chunk if possible, otherwise skip
        if (localStart >= MIN_CHUNK_DURATION_SEC) {
          localStart = localEnd - MIN_CHUNK_DURATION_SEC;
        } else {
          // Too short and can't extend - skip this chunk
          console.warn(`[SportsHighlights] Virtual chunk too short (${chunkDuration}s), skipping`);
          break;
        }
      }

      allVirtual.push({
        chunkIndex: globalIndex,
        // startTime/endTime are in the PHYSICAL chunk's coordinate space (0-based)
        startTime: localStart,
        endTime: localEnd,
        videoId: physical.videoId,
        // Store the physical chunk's offset so we can convert back to original timeline
        _physicalOffset: physical.startOffset,
      });

      localStart = localStart + SPORTS_CHUNK_DURATION_SEC - SPORTS_CHUNK_OVERLAP_SEC;
      globalIndex++;
    }
  }

  return allVirtual;
}

/**
 * Run replay detection using virtual chunks (ALWAYS uses startTime/endTime).
 * Works for both:
 * - Physical chunks: creates virtual sub-chunks within each physical chunk
 * - Single videos: creates virtual chunks across the whole video
 *
 * IMPORTANT timestamp rule (virtual windows):
 * - Each TwelveLabs asset (physical chunk mp4 or single upload) uses its **own** t=0.
 * - `segmentDefinitions[].time_ranges` only constrains WHERE segments may be extracted;
 * - returned segment times are still on that asset timeline → add `_physicalOffset` only
 *   (already `actualStartOffset ?? startOffset` from Dynamo) for the original-video clock.
 */
async function runReplayDetectionWithVirtualChunks(
  client: TwelveLabs,
  virtualChunks: (VirtualChunk & { _physicalOffset?: number })[],
  segmentDefinitions: TwelvelabsApi.SegmentDefinition[],
  options: {
    customIdPrefix: string;
    maxPollWaitMs: number;
  },
): Promise<ChunkTaskResult[]> {
  console.log(
    `[SportsHighlights] Starting ${virtualChunks.length} virtual chunk tasks in parallel ` +
      `(segment-definition time_ranges on each Pegasus window — aligns with TwelveLabs segmentation docs)`,
  );

  // Create all tasks in parallel with time ranges
  const createPromises = virtualChunks.map(async (chunk) => {
    const customId = `${options.customIdPrefix}-v${chunk.chunkIndex}`.slice(0, 64);
    const durationSec = Math.round(chunk.endTime - chunk.startTime);
    const physicalOffset = chunk._physicalOffset ?? 0;
    const globalStart = physicalOffset + chunk.startTime;
    const globalEnd = physicalOffset + chunk.endTime;

    console.log(
      `[SportsHighlights] Creating virtual chunk ${chunk.chunkIndex}: ` +
        `asset ${Math.round(chunk.startTime)}-${Math.round(chunk.endTime)}s → ` +
        `original-video ~${Math.round(globalStart)}-${Math.round(globalEnd)}s (${durationSec}s)`,
    );

    const created = await createQlioPegasusSegmentationTask(client, {
      video: { type: "asset_id", assetId: chunk.videoId },
      customId,
      segmentDefinitions,
      limitAnalysisToWindow: {
        startTime: chunk.startTime,
        endTime: chunk.endTime,
      },
    });

    return { chunk, taskId: created.taskId, physicalOffset };
  });

  const createdTasks = await Promise.all(createPromises);
  console.log(`[SportsHighlights] All ${createdTasks.length} virtual chunk tasks created, polling...`);

  // Poll all tasks in parallel
  const pollPromises = createdTasks.map(async ({ chunk, taskId, physicalOffset }) => {
    try {
      const task = await pollPegasusAnalyzeTask(client, taskId, {
        intervalMs: 5000,
        maxWaitMs: options.maxPollWaitMs,
      });

      const parsed = parsePegasusSegmentationData(task.result?.data);
      const segments = parseReplayDetectionResponse(parsed);

      console.log(`[SportsHighlights] Virtual chunk ${chunk.chunkIndex} complete: ${segments.length} segments`);

      // With `segmentDefinitions[].time_ranges`, Pegasus still reports `start_time` / `end_time`
      // in the **indexed chunk video's timeline** (t=0 at the start of that TwelveLabs asset),
      // same as a full-video segmentation task — the window only limits where segments may start.
      // Map to original upload timeline by adding physicalOffset (already `actualStartOffset ?? startOffset`).
      //
      const totalOffset = physicalOffset;

      return {
        chunkIndex: chunk.chunkIndex,
        startOffset: totalOffset,
        endOffset: physicalOffset + chunk.endTime,
        segments,
        taskId,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[SportsHighlights] Virtual chunk ${chunk.chunkIndex} (task ${taskId}) failed: ${msg}`);
    }
  });

  return Promise.all(pollPromises);
}

function mergeChunkReplaySegments(
  chunkResults: ChunkTaskResult[],
  videoDuration: number,
): RawReplaySegment[] {
  const sorted = [...chunkResults].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const allSegments: RawReplaySegment[] = [];

  for (const chunk of sorted) {
    for (const seg of chunk.segments) {
      // Adjust timestamps from chunk-relative to original timeline
      const adjusted: RawReplaySegment = {
        ...seg,
        start_time: seg.start_time + chunk.startOffset,
        end_time: seg.end_time + chunk.startOffset,
      };

      // Clamp to video duration
      adjusted.start_time = Math.max(0, adjusted.start_time);
      adjusted.end_time = Math.min(videoDuration, adjusted.end_time);

      if (adjusted.end_time - adjusted.start_time >= 1) {
        allSegments.push(adjusted);
      }
    }
  }

  // Sort by start time
  allSegments.sort((a, b) => a.start_time - b.start_time);

  // Deduplicate near-identical segments in overlap regions
  const deduplicated: RawReplaySegment[] = [];
  const overlapThreshold = 5; // segments within 5s are candidates for dedup

  for (const seg of allSegments) {
    const nearDupe = deduplicated.find(
      (existing) =>
        Math.abs(existing.start_time - seg.start_time) < overlapThreshold &&
        Math.abs(existing.end_time - seg.end_time) < overlapThreshold,
    );

    if (!nearDupe) {
      deduplicated.push(seg);
    }
    // Keep existing if duplicate found
  }

  console.log(
    `[SportsHighlights] Merged ${allSegments.length} segments → ${deduplicated.length} after deduplication`,
  );

  return deduplicated;
}

// ============================================================================
// Main Pipeline
// ============================================================================

/**
 * Generate sports highlights using replay detection.
 *
 * This is the main entry point for sports highlights generation.
 * It detects what the broadcast replayed and uses that as the highlight signal.
 *
 * For chunked videos, runs replay detection on each chunk in parallel.
 */
export async function generateSportsHighlights(
  twelvelabs: TwelveLabsWrapper,
  options: SportsHighlightsOptions,
): Promise<SportsHighlightsResult> {
  const startMs = Date.now();
  const {
    metadata,
    transcript,
    userInstructions,
    maxPollWaitMs,
    minSegmentDuration = SPORTS_DEFAULT_MIN_SEGMENT_SEC,
    maxSegmentDuration = SPORTS_DEFAULT_MAX_SEGMENT_SEC,
  } = options;

  const client = twelvelabs.getClient();
  const videoContext = await resolveVideoContextForPegasus(twelvelabs, metadata.assetId);

  console.log(
    `[SportsHighlights] Replay detection for ${metadata.assetId} (${Math.round(metadata.duration)}s source)`,
  );

  // -------------------------------------------------------------------------
  // Step 1: Run Pegasus with replay detection definitions
  // -------------------------------------------------------------------------
  const segmentDefinitions = sportsReplayDetectionDefinitionsForGeneration({
    userInstructions,
    videoDurationSeconds: metadata.duration,
  });

  const safeId = `qlio-sports-${metadata.assetId}`.replace(
    /[^a-zA-Z0-9_-]/g,
    "-",
  );
  const pollCap = maxPollWaitMs ?? 3_600_000;

  let rawSegments: RawReplaySegment[];
  let taskIds: string[];

  // Process each physical chunk as a full video (no timeRanges - they break min/maxSegmentDuration)
  // This still parallelizes across physical chunks while getting proper fine-grained segments
  if (videoContext.isChunked && videoContext.chunks) {
    console.log(
      `[SportsHighlights] Processing ${videoContext.chunks.length} physical chunks in parallel (no virtual sub-chunking)`,
    );

    const chunkResults = await runReplayDetectionOnPhysicalChunks(
      client,
      videoContext.chunks,
      segmentDefinitions,
      {
        customIdPrefix: safeId,
        maxPollWaitMs: pollCap,
        minSegmentDuration,
        maxSegmentDuration,
      },
    );

    rawSegments = mergeChunkReplaySegments(chunkResults, metadata.duration);
    taskIds = chunkResults.map((r) => r.taskId);
  } else if (videoContext.video && videoContext.video.type === "asset_id") {
    // Single video — process as full video
    console.log(`[SportsHighlights] Processing single video (no chunks)`);

    const created = await createQlioPegasusSegmentationTask(client, {
      video: videoContext.video,
      customId: safeId.slice(0, 64),
      segmentDefinitions,
      minSegmentDuration,
      maxSegmentDuration,
    });

    const task = await pollPegasusAnalyzeTask(client, created.taskId, {
      intervalMs: 5000,
      maxWaitMs: pollCap,
    });

    console.log(`[SportsHighlights] Pegasus task completed: ${task.taskId}`);

    const parsed = parsePegasusSegmentationData(task.result?.data);
    rawSegments = parseReplayDetectionResponse(parsed);
    taskIds = [created.taskId];
  } else {
    throw new Error("[SportsHighlights] No video context available");
  }

  console.log(
    `[SportsHighlights] Parsed ${rawSegments.length} segments from Pegasus`,
  );

  // -------------------------------------------------------------------------
  // Step 3: Extract replayed plays
  // -------------------------------------------------------------------------
  const replayData = extractReplayedPlays(rawSegments, metadata.duration);

  console.log(
    `[SportsHighlights] Detected ${replayData.replayed_plays.length} replayed plays`,
  );
  replayData.detection_notes.forEach((note) =>
    console.log(`  - ${note}`),
  );

  if (replayData.replayed_plays.length === 0) {
    throw new Error(
      "[SportsHighlights] No replayed plays detected. Video may not be a sports broadcast, " +
        "or broadcast may not include replays.",
    );
  }

  const { kept, dropped } = filterKeyReplayedPlays(replayData.replayed_plays);
  if (kept.length === 0) {
    throw new Error(
      "[SportsHighlights] No replay segments passed the filter (clips must be at least ~1.5s).",
    );
  }
  console.log(
    `[SportsHighlights] Key replays: ${kept.length} kept, ${dropped.length} filtered out`,
  );

  const segments = replayClipsToProposedSegments(
    kept,
    metadata.duration,
    transcript,
  );

  console.log(
    `[SportsHighlights] Generated ${segments.length} replay-only clips from ${kept.length} key plays`,
  );

  const processingTime = Date.now() - startMs;
  const totalDuration = segments.reduce(
    (sum, s) => sum + (s.endTime - s.startTime),
    0,
  );

  console.log(
    `[SportsHighlights] Done in ${processingTime}ms — ` +
      `${segments.length} replay-only clips (~${Math.round(totalDuration)}s replay footage)`,
  );

  const taskSummary = taskIds.length === 1
    ? `task ${taskIds[0]}`
    : `${taskIds.length} parallel tasks`;

  return {
    segments,
    confidence: kept.length >= 3 ? 0.9 : 0.75,
    notes: [
      `Pegasus 1.5 ${taskSummary}: ${kept.length} key replay clip(s) (replay footage only).`,
      ...replayData.detection_notes.slice(0, 3),
    ],
    attempts: 1,
    replayData,
    selectedPlays: kept,
    droppedPlays: dropped,
  };
}

// ============================================================================
// Exports for Testing
// ============================================================================

export {
  ReplayedPlay,
  ReplayDetectionResult,
  sportsReplayDetectionDefinitionsForGeneration,
  parseReplayDetectionResponse,
  extractReplayedPlays,
  filterKeyReplayedPlays,
  replayClipsToProposedSegments,
  replayedPlaysToSegments,
} from "./sports-replay-detection";
