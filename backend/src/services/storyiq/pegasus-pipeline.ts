/**
 * Pegasus Pipeline
 *
 * Routes content to appropriate pipeline:
 * - Sports → replay detection
 * - Everything else → Pegasus segmentation
 *
 * For chunked videos (>60min), runs Pegasus on each chunk in parallel using
 * their existing TwelveLabs asset IDs (no S3 re-download), then merges and
 * deduplicates results in the overlap regions.
 */

import type { TwelveLabs, TwelvelabsApi } from "twelvelabs-js";
import type { TwelveLabsWrapper, ChunkInfo } from "../twelvelabs";
import { presignS3Uri } from "../../utils/s3";
import {
  createQlioPegasusSegmentationTask,
  parsePegasusSegmentationData,
  pollPegasusAnalyzeTask,
  getSegmentDefinitions,
  QLIO_PEGASUS_SEGMENT_MAX_SEC,
  QLIO_PEGASUS_SEGMENT_MIN_SEC,
} from "../pegasus-segmentation";
import {
  Purpose,
  type ContentType,
  type FinalSegments,
  type GenerationOptions,
  type ProposedSegment,
  type TranscriptSegment,
} from "./types";
import { classifyContent } from "./pegasus-content-class";
import {
  selectSegmentsForTarget,
  buildPegasusMetadataMap,
} from "./pegasus-selection";
import { generateSportsHighlights } from "./sports-highlights-pipeline";

const PRESIGN_TTL_SEC = 43_200;

/**
 * Default total runtime when Retain is Auto (compact).
 * Pre-Jockey fallback behavior — do not change: the 50% product decision
 * applies to the Jockey pipelines only (jockey-pipeline.ts / jockey-v3-pipeline.ts).
 */
const COMPACT_DEFAULT_TARGET_PERCENT = 30;
/** Default "previously on" recap length (1-1.5 min). */
const EPISODE_RECAP_DEFAULT_TARGET_SEC = 75;

export interface PegasusSceneRow {
  start_time: number;
  end_time: number;
  metadata: Record<string, unknown>;
}

export interface PegasusChunkTaskResult {
  chunkIndex: number;
  startOffset: number;
  endOffset: number;
  rows: PegasusSceneRow[];
  taskId: string;
}

function pegasusSegmentDurationBounds(options?: {
  minSegmentDuration?: number;
  maxSegmentDuration?: number;
}): {
  minSegmentDuration: number;
  maxSegmentDuration: number;
} {
  return {
    minSegmentDuration: options?.minSegmentDuration ?? QLIO_PEGASUS_SEGMENT_MIN_SEC,
    maxSegmentDuration: options?.maxSegmentDuration ?? QLIO_PEGASUS_SEGMENT_MAX_SEC,
  };
}

/**
 * Check if segment should be kept based on microseries_keep or recap_keep field.
 */
export function shouldKeepPegasusSegment(meta: Record<string, unknown>): boolean {
  const microseriesKeep = meta.microseries_keep;
  const recapKeep = meta.recap_keep;
  
  // Check microseries_keep (compact_video) or recap_keep (episode_recap)
  if (typeof microseriesKeep === "string") {
    return microseriesKeep.toLowerCase() === "yes";
  }
  if (typeof recapKeep === "string") {
    return recapKeep.toLowerCase() === "yes";
  }
  
  // Fallback: keep all if no keep field (full_video, sports, etc.)
  return true;
}

// =============================================================================
// Video Context Resolution (handles chunked videos)
// =============================================================================

interface VideoContextResult {
  /** For non-chunked: single video context. For chunked: use chunks array instead. */
  video?: TwelvelabsApi.VideoContext;
  /** For chunked videos: array of chunks with their video IDs and offsets. */
  chunks?: Array<{
    videoId: string;
    startOffset: number;
    endOffset: number;
    chunkIndex: number;
  }>;
  isChunked: boolean;
}

export async function resolveVideoContextForPegasus(
  twelvelabs: TwelveLabsWrapper,
  assetId: string,
): Promise<VideoContextResult> {
  const asset = await twelvelabs.getAssetInfo(assetId);

  // Non-chunked video with asset ID — best case
  if (!asset.isChunked && asset.twelveLabsVideoId) {
    console.log(
      `[Pegasus] Using asset_id (no S3 egress): ${asset.twelveLabsVideoId}`,
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
        `[Pegasus] Chunked video: ${validChunks.length} chunks with asset IDs (no S3 egress)`,
      );
      return {
        chunks: validChunks.map((c) => ({
          videoId: c.videoId!,
          startOffset: c.actualStartOffset ?? c.startOffset,
          endOffset: c.endOffset,
          chunkIndex: c.chunkIndex,
        })),
        isChunked: true,
      };
    }
    console.warn("[Pegasus] Chunked video but no chunk videoIds — falling back to S3");
  }

  // Fallback: presign S3 URL (slow path — requires re-download)
  let s3Uri = asset.s3VideoUrl;
  if (!s3Uri && asset.s3Key) {
    const bucket = process.env.BUCKET_NAME?.trim();
    if (bucket) {
      s3Uri = `s3://${bucket}/${asset.s3Key}`;
    }
  }
  if (!s3Uri) {
    throw new Error(
      `Asset ${assetId} needs s3VideoUrl for Pegasus when asset IDs unavailable.`,
    );
  }

  console.warn(`[Pegasus] SLOW PATH: Presigning S3 URL (TwelveLabs will re-download): ${s3Uri}`);
  const signed = await presignS3Uri(s3Uri, PRESIGN_TTL_SEC);
  if (!signed) {
    throw new Error("Failed to presign S3 URL for Pegasus");
  }
  return { video: { type: "url", url: signed }, isChunked: false };
}

// For classification, we only need first 120s — use first chunk or single video
async function resolveVideoContextForClassification(
  twelvelabs: TwelveLabsWrapper,
  assetId: string,
): Promise<TwelvelabsApi.VideoContext> {
  const result = await resolveVideoContextForPegasus(twelvelabs, assetId);

  if (result.video) {
    return result.video;
  }

  // Chunked: use first chunk's videoId
  if (result.chunks && result.chunks.length > 0) {
    const first = result.chunks[0];
    console.log(`[Pegasus] Classification using first chunk: ${first.videoId}`);
    return { type: "asset_id", assetId: first.videoId };
  }

  throw new Error("No video context available for classification");
}

// =============================================================================
// Parallel Chunk Processing & Deduplication
// =============================================================================

type ChunkTaskResult = PegasusChunkTaskResult;

/**
 * Run Pegasus segmentation on multiple chunks in parallel.
 * Returns raw rows with timestamps still chunk-relative.
 */
async function runPegasusOnChunksParallel(
  client: TwelveLabs,
  chunks: VideoContextResult["chunks"],
  segmentDefinitions: TwelvelabsApi.SegmentDefinition[],
  options: {
    customIdPrefix: string;
    minSegmentDuration: number;
    maxSegmentDuration: number;
    maxPollWaitMs: number;
  },
): Promise<ChunkTaskResult[]> {
  if (!chunks || chunks.length === 0) {
    throw new Error("[Pegasus] No chunks to process");
  }

  console.log(`[Pegasus] Starting ${chunks.length} chunk tasks in parallel...`);

  // Create all tasks in parallel
  const createPromises = chunks.map(async (chunk) => {
    const customId = `${options.customIdPrefix}-c${chunk.chunkIndex}`.slice(0, 64);
    console.log(`[Pegasus] Creating task for chunk ${chunk.chunkIndex} (${chunk.videoId})`);

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
  console.log(`[Pegasus] All ${createdTasks.length} tasks created, polling...`);

  // Poll all tasks in parallel
  const pollPromises = createdTasks.map(async ({ chunk, taskId }) => {
    try {
      const task = await pollPegasusAnalyzeTask(client, taskId, {
        intervalMs: 5000,
        maxWaitMs: options.maxPollWaitMs,
      });

      const parsed = parsePegasusSegmentationData(task.result?.data);
      const rows = parsePegasusSceneRows(parsed);

      console.log(`[Pegasus] Chunk ${chunk.chunkIndex} complete: ${rows.length} segments`);

      return {
        chunkIndex: chunk.chunkIndex,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        rows,
        taskId,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[Pegasus] Chunk ${chunk.chunkIndex} (task ${taskId}) failed: ${msg}`);
    }
  });

  return Promise.all(pollPromises);
}

/**
 * Merge chunk results into a single timeline, deduplicating overlaps.
 * Segments in overlap regions are kept from the chunk where they're furthest
 * from the boundary (more reliable detection).
 */
export function mergeChunkResults(
  chunkResults: ChunkTaskResult[],
  videoDuration: number,
): PegasusSceneRow[] {
  // Sort by chunk index
  const sorted = [...chunkResults].sort((a, b) => a.chunkIndex - b.chunkIndex);

  const allRows: Array<PegasusSceneRow & { sourceChunk: number }> = [];

  for (const chunk of sorted) {
    for (const row of chunk.rows) {
      // Adjust timestamps from chunk-relative to original timeline
      const adjustedRow: PegasusSceneRow & { sourceChunk: number } = {
        start_time: row.start_time + chunk.startOffset,
        end_time: row.end_time + chunk.startOffset,
        metadata: row.metadata,
        sourceChunk: chunk.chunkIndex,
      };

      // Clamp to video duration
      adjustedRow.start_time = Math.max(0, adjustedRow.start_time);
      adjustedRow.end_time = Math.min(videoDuration, adjustedRow.end_time);

      if (adjustedRow.end_time - adjustedRow.start_time >= 2) {
        allRows.push(adjustedRow);
      }
    }
  }

  // Sort by start time
  allRows.sort((a, b) => a.start_time - b.start_time);

  // Deduplicate overlapping segments (>50% overlap = duplicate)
  const deduplicated: PegasusSceneRow[] = [];

  for (const row of allRows) {
    // Check if this segment significantly overlaps with an existing one
    const existingOverlap = deduplicated.find((existing) => {
      const overlapStart = Math.max(existing.start_time, row.start_time);
      const overlapEnd = Math.min(existing.end_time, row.end_time);
      const overlapDuration = overlapEnd - overlapStart;
      const minDuration = Math.min(
        existing.end_time - existing.start_time,
        row.end_time - row.start_time,
      );
      // If >50% overlap, consider them duplicates
      return overlapDuration > 0 && overlapDuration / minDuration > 0.5;
    });

    if (!existingOverlap) {
      deduplicated.push(row);
    } else {
      // Keep the one with better metadata or longer duration
      const existingDur = existingOverlap.end_time - existingOverlap.start_time;
      const newDur = row.end_time - row.start_time;
      if (newDur > existingDur * 1.2) {
        // New one is significantly longer, replace
        const idx = deduplicated.indexOf(existingOverlap);
        deduplicated[idx] = row;
      }
      // Otherwise keep existing
    }
  }

  console.log(
    `[Pegasus] Merged ${allRows.length} rows → ${deduplicated.length} after deduplication`,
  );

  return deduplicated;
}

/** Known segment definition IDs — results are keyed by these */
const KNOWN_SEGMENT_DEF_IDS = ["qlio_scene", "qlio_trek_scene"] as const;

/**
 * Parse Pegasus scene rows from result data.
 * Handles qlio_scene and qlio_trek_scene result keys.
 */
export function parsePegasusSceneRows(
  data: Record<string, unknown>,
): PegasusSceneRow[] {
  // Find which definition ID has data
  let raw: unknown[] | undefined;
  let foundId: string | undefined;

  for (const id of KNOWN_SEGMENT_DEF_IDS) {
    if (Array.isArray(data[id])) {
      raw = data[id] as unknown[];
      foundId = id;
      break;
    }
  }

  if (!raw || !foundId) {
    const keys = Object.keys(data).join(", ");
    throw new Error(
      `[Pegasus] Expected one of ${KNOWN_SEGMENT_DEF_IDS.join("/")} array in result, got keys: ${keys}`,
    );
  }

  console.log(`[StoryIQ Pegasus] Parsing ${raw.length} rows from definition: ${foundId}`);

  return raw.map((row, i) => {
    if (!row || typeof row !== "object") {
      throw new Error(`[Pegasus] Invalid row ${i}`);
    }
    const r = row as Record<string, unknown>;
    const start = Number(r.start_time);
    const end = Number(r.end_time);
    const meta = r.metadata;
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(`[Pegasus] Row ${i}: bad start_time/end_time`);
    }
    if (!meta || typeof meta !== "object") {
      throw new Error(`[Pegasus] Row ${i}: missing metadata`);
    }
    return {
      start_time: start,
      end_time: end,
      metadata: meta as Record<string, unknown>,
    };
  });
}

/**
 * Ground `expectedContent` in ASR text for the editor UI. Pegasus never receives
 * this string — it watches the video — but dialogue snippets keep segments
 * auditable and help downstream tooling.
 */
function transcriptSnippetForRange(
  transcript: TranscriptSegment[],
  start: number,
  end: number,
): string {
  const parts = transcript.filter(
    (t) => t.endTime > start && t.startTime < end,
  );
  return parts
    .map((t) => t.text.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 2500);
}

/**
 * Extract title from Pegasus metadata.
 * Prefers new `title` field (3–5 words), falls back to `description` or legacy `summary`.
 */
function titleFromPegasusRow(meta: Record<string, unknown>): string {
  // Prefer new title field (3-5 words)
  const title = typeof meta.title === "string" ? meta.title.trim() : "";
  if (title && title.length >= 5 && title.length <= 60) {
    return title;
  }

  // Fallback: first 5 words of description
  const description = typeof meta.description === "string" ? meta.description.trim() : "";
  if (description) {
    const words = description.split(/\s+/).slice(0, 5).join(" ");
    if (words.length >= 5) {
      return words.length <= 50 ? words : `${words.slice(0, 47)}…`;
    }
  }

  // Legacy fallback: summary field (from old prompts)
  const summary = typeof meta.summary === "string" ? meta.summary.trim() : "";
  if (summary && summary.length >= 10) {
    if (summary.length <= 60) return summary;
    const cut = summary.lastIndexOf(" ", 57);
    return cut > 20 ? `${summary.slice(0, cut)}…` : `${summary.slice(0, 57)}…`;
  }

  // Last resort: use lead_characters or characters
  const chars = meta.lead_characters || meta.characters;
  if (Array.isArray(chars) && chars.length > 0) {
    const charLine = (chars as unknown[])
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(" & ");
    if (charLine) return charLine;
  }

  return "Scene";
}

/**
 * Extract description/reasoning from Pegasus metadata.
 * Prefers new `description` field (7–10 words), falls back to legacy `summary`.
 */
function reasoningFromRow(meta: Record<string, unknown>): string {
  const bits: string[] = [];

  // Prefer new description field
  const description = typeof meta.description === "string" ? meta.description.trim() : "";
  if (description) {
    bits.push(description);
  } else {
    // Legacy fallback: summary
    const summary = typeof meta.summary === "string" ? meta.summary.trim() : "";
    if (summary) {
      bits.push(summary);
    }
  }

  // Add narrative role if present
  const role = typeof meta.narrative_role === "string" ? meta.narrative_role : "";
  if (role && role !== "main_story") {
    bits.push(`Role: ${role.replace(/_/g, " ")}.`);
  }

  // Add story function if present (recap beats) — support both new and legacy schema
  const storyFunction = typeof meta.story_function === "string" ? meta.story_function : "";
  const recapImportance = typeof meta.recap_importance === "string" ? meta.recap_importance : "";
  if (storyFunction) {
    bits.push(`Story role: ${storyFunction}.`);
  } else if (recapImportance) {
    bits.push(`Recap: ${recapImportance}.`);
  }

  return bits.join(" ").slice(0, 500);
}

export function rowsToProposedSegments(
  rows: PegasusSceneRow[],
  transcript: TranscriptSegment[],
  videoDuration: number,
): ProposedSegment[] {
  const out: ProposedSegment[] = [];
  for (const row of rows) {
    let start = Math.max(0, row.start_time);
    let end = Math.min(videoDuration, row.end_time);
    if (end - start < 2) continue;
    const meta = row.metadata;
    
    // Extract narrative role for section tagging
    const role = typeof meta.narrative_role === "string" ? meta.narrative_role : "";
    
    out.push({
      startTime: start,
      endTime: end,
      title: titleFromPegasusRow(meta),
      reasoning: reasoningFromRow(meta),
      expectedContent: transcriptSnippetForRange(transcript, start, end),
      section: role ? `role-${role}` : undefined,
    });
  }
  out.sort((a, b) => a.startTime - b.startTime);
  return out;
}

export interface PegasusPipelineOptions extends GenerationOptions {
  maxPollWaitMs?: number;
  /** Skip classification and assume sports content (faster for known sports videos) */
  assumeSports?: boolean;
  /** Min per-segment length in seconds (overrides defaults) */
  minSegmentDuration?: number;
  /** Max per-segment length in seconds (overrides defaults) */
  maxSegmentDuration?: number;
  /** Pass-through metadata: tv | movie | other */
  assetType?: string;
  /** Pass-through metadata: mobile | tv | tiktok | ig | shorts | facebook */
  platform?: string;
  /** Pass-through metadata: compact_video | full_video | highlights | trailer | episode_recap | season_recap */
  format?: string;
}

/**
 * Generate segments using Pegasus. Classifies video (unless assumeSports=true), then:
 * sports → replay pipeline; otherwise Pegasus segmentation.
 *
 * For chunked videos, runs Pegasus on each chunk in parallel using their
 * existing TwelveLabs asset IDs, then merges results with deduplication.
 */
export async function generateSegmentsWithPegasus(
  twelvelabs: TwelveLabsWrapper,
  options: PegasusPipelineOptions,
): Promise<FinalSegments> {
  const startMs = Date.now();
  const {
    metadata,
    transcript,
    purpose,
    targetDuration,
    userInstructions,
    maxPollWaitMs,
  } = options;

  const client = twelvelabs.getClient();

  // Resolve video context (handles chunked videos)
  const videoContext = await resolveVideoContextForPegasus(twelvelabs, metadata.assetId);

  let targetSeconds =
    targetDuration ??
    (options.targetPercent
      ? Math.round((metadata.duration * options.targetPercent) / 100)
      : undefined);

  // Auto Retain / no explicit target: apply product defaults so output isn't full-length
  if (!targetSeconds || targetSeconds <= 0) {
    if (purpose === Purpose.EPISODE_RECAP) {
      targetSeconds = EPISODE_RECAP_DEFAULT_TARGET_SEC;
      console.log(
        `[StoryIQ Pegasus] episode_recap default target: ${targetSeconds}s`,
      );
    } else if (purpose === Purpose.COMPACT_VIDEO) {
      targetSeconds = Math.round(
        (metadata.duration * COMPACT_DEFAULT_TARGET_PERCENT) / 100,
      );
      console.log(
        `[StoryIQ Pegasus] compact_video default target: ${targetSeconds}s (${COMPACT_DEFAULT_TARGET_PERCENT}% of ${Math.round(metadata.duration)}s)`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Classify video (or skip if assumeSports=true or user provided prompt)
  // -------------------------------------------------------------------------
  let contentType: ContentType;

  if (options.userInstructions) {
    // User prompt overrides classification - use generic pipeline with their instructions
    console.log("[Pegasus] Skipping classification (user provided instructions)");
    contentType = "generic";
  } else if (options.assumeSports) {
    console.log("[Pegasus] Skipping classification (assumeSports=true)");
    contentType = "sports";
  } else {
    console.log("[Pegasus] Classifying...");
    const classifyVideo = await resolveVideoContextForClassification(twelvelabs, metadata.assetId);
    const classifyResult = await classifyContent(
      client,
      classifyVideo,
      metadata.title,
      options.geminiApiKey,
    );
    contentType = classifyResult.contentType;
    console.log(
      `[Pegasus] ${contentType} (confidence=${classifyResult.confidence}, source=${classifyResult.source})`,
    );
  }

  // -------------------------------------------------------------------------
  // Sports → replay detection pipeline (only for highlights, not episode_recap)
  // -------------------------------------------------------------------------
  if (contentType === "sports" && purpose !== Purpose.EPISODE_RECAP) {
    console.log("[Pegasus] Routing to sports replay pipeline");
    return generateSportsHighlights(twelvelabs, {
      metadata,
      transcript,
      userInstructions,
      maxPollWaitMs,
      minSegmentDuration: options.minSegmentDuration,
      maxSegmentDuration: options.maxSegmentDuration,
    });
  }

  // -------------------------------------------------------------------------
  // Get segment definitions for content type and purpose
  // -------------------------------------------------------------------------
  const purposeKey =
    options.format ??
    (purpose === Purpose.EPISODE_RECAP
      ? "episode_recap"
      : purpose === Purpose.FULL_VIDEO
        ? "full_video"
        : purpose === Purpose.HIGHLIGHTS
          ? "highlights"
          : "compact_video");

  const segmentDefinitions = getSegmentDefinitions(contentType, {
    userInstructions,
    targetDurationSeconds: targetSeconds,
    videoDurationSeconds: metadata.duration,
    purpose: purposeKey as
      | "compact_video"
      | "full_video"
      | "highlights"
      | "episode_recap",
  });

  const { minSegmentDuration, maxSegmentDuration } =
    pegasusSegmentDurationBounds({
      minSegmentDuration: options.minSegmentDuration,
      maxSegmentDuration: options.maxSegmentDuration,
    });

  const safeId = `qlio-seg-${metadata.assetId}`.replace(/[^a-zA-Z0-9_-]/g, "-");
  const pollCap = maxPollWaitMs ?? 3_600_000;

  // -------------------------------------------------------------------------
  // Run segmentation — parallel chunks or single video
  // -------------------------------------------------------------------------
  let rows: PegasusSceneRow[];
  let taskIds: string[];

  if (videoContext.isChunked && videoContext.chunks) {
    // PARALLEL CHUNK PROCESSING (fast path — no S3 re-download)
    console.log(
      `[Pegasus] Running parallel segmentation on ${videoContext.chunks.length} chunks (${contentType}, target≈${targetSeconds ?? "n/a"}s)`,
    );

    const chunkResults = await runPegasusOnChunksParallel(
      client,
      videoContext.chunks,
      segmentDefinitions,
      {
        customIdPrefix: safeId,
        minSegmentDuration,
        maxSegmentDuration,
        maxPollWaitMs: pollCap,
      },
    );

    rows = mergeChunkResults(chunkResults, metadata.duration);
    taskIds = chunkResults.map((r) => r.taskId);
  } else if (videoContext.video) {
    // SINGLE VIDEO (non-chunked or fallback)
    console.log(
      `[Pegasus] Creating segmentation task (${contentType}, target≈${targetSeconds ?? "n/a"}s)`,
    );

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

    const parsed = parsePegasusSegmentationData(task.result?.data);
    rows = parsePegasusSceneRows(parsed);
    taskIds = [created.taskId];
  } else {
    throw new Error("[Pegasus] No video context available");
  }

  // -------------------------------------------------------------------------
  // Apply microseries_keep / recap_keep filter (replaces A/B/C filter + scoring)
  // -------------------------------------------------------------------------
  const beforeFilter = rows.length;

  // For compact_video and episode_recap, trust Pegasus keep decisions
  // For full_video and highlights (sports), keep all segments
  if (purpose === Purpose.COMPACT_VIDEO || purpose === Purpose.EPISODE_RECAP) {
    rows = rows.filter((r) => shouldKeepPegasusSegment(r.metadata));
    if (rows.length < beforeFilter) {
      console.log(
        `[StoryIQ Pegasus] Filtered ${beforeFilter - rows.length} segments via microseries_keep/recap_keep`,
      );
    }
  }

  let proposed = rowsToProposedSegments(rows, transcript, metadata.duration);

  if (proposed.length === 0) {
    throw new Error("[Pegasus] No segments after parsing and filters");
  }

  let selectionNotes: string[] = [
    `${beforeFilter} raw → ${proposed.length} after keep filter`,
  ];

  // Trim total runtime toward target (compact only — recap trusts Pegasus recap_keep + prompt)
  if (
    targetSeconds &&
    targetSeconds > 0 &&
    purpose === Purpose.COMPACT_VIDEO
  ) {
    const totalBefore = proposed.reduce(
      (sum, s) => sum + (s.endTime - s.startTime),
      0,
    );
    if (totalBefore > targetSeconds * 1.05) {
      console.log(
        `[StoryIQ Pegasus] Running duration selection (${proposed.length} candidates, ${Math.round(totalBefore)}s → target ${targetSeconds}s)`,
      );
      const pegasusMetadata = buildPegasusMetadataMap(rows);
      const selection = selectSegmentsForTarget(
        proposed,
        { targetDuration: targetSeconds, contentType, purpose },
        pegasusMetadata,
      );
      proposed = selection.selected;
      selectionNotes = [
        ...selectionNotes,
        ...selection.scoringNotes,
        `Duration trim: ${Math.round(totalBefore)}s → ${Math.round(selection.totalDuration)}s`,
      ];
      if (proposed.length === 0) {
        throw new Error("[Pegasus] No segments after duration selection");
      }
    }
  }

  const processingTime = Date.now() - startMs;
  const totalDuration = proposed.reduce(
    (sum, s) => sum + (s.endTime - s.startTime),
    0,
  );
  console.log(
    `[StoryIQ Pegasus] Done in ${processingTime}ms — ${proposed.length} segments, ~${Math.round(totalDuration)}s`,
  );

  const taskSummary = taskIds.length === 1
    ? `task ${taskIds[0]}`
    : `${taskIds.length} parallel tasks`;

  return {
    segments: proposed,
    confidence: 0.88,
    notes: [
      `Pegasus ${taskSummary}; ${contentType}.`,
      ...selectionNotes,
    ],
    attempts: 1,
  };
}
