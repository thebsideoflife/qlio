/**
 * TwelveLabs Wrapper Service
 *
 * This service provides a transparent abstraction layer over the 12labs SDK
 * that handles chunked videos. For videos that were split into multiple chunks
 * for indexing, this wrapper:
 *
 * 1. Queries all chunks and aggregates results
 * 2. Adjusts timestamps from chunk-relative to original video timeline
 * 3. Merges transcriptions and other data across chunks
 *
 * Consumers of this service don't need to know whether a video was chunked -
 * they always work with original video timestamps.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { TwelveLabs, TwelvelabsApi } from "twelvelabs-js";

const s3Client = new S3Client({});

// Re-export SDK types we use
type NonStreamAnalyzeResponse = TwelvelabsApi.NonStreamAnalyzeResponse;

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

// ============================================================================
// Timeout & Retry Configuration
// ============================================================================

const TWELVE_LABS_TIMEOUT_MS = 600_000; // 10 minutes — let 12Labs take as long as it needs
const MAX_RETRIES = 0; // No retries - if it times out once, it will timeout again
const RETRY_DELAY_MS = 1000;

/**
 * Wrap a promise with a timeout
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  operation: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`12Labs ${operation} timed out after ${ms}ms`));
    }, ms);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Retry a function with exponential backoff
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  operation: string,
  maxRetries = MAX_RETRIES
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const isRetryable =
        !err.message?.includes("not found") &&
        !err.message?.includes("Invalid");

      if (attempt < maxRetries && isRetryable) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `[12Labs] ${operation} failed (attempt ${attempt + 1}/${
            maxRetries + 1
          }), retrying in ${delay}ms:`,
          err.message
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError;
}

export interface ChunkInfo {
  chunkIndex: number;
  s3Key: string;
  startOffset: number; // Intended start time in original video (seconds)
  endOffset: number; // End time in original video (seconds)
  duration: number; // Intended duration
  actualStartOffset?: number; // Precise start (accounts for FFmpeg keyframe seeking)
  actualDuration?: number; // Precise duration after extraction
  taskId?: string;
  videoId?: string; // 12labs video ID for this chunk
}

/** TwelveLabs rejects `time_ranges`/`start_time` that extend past the indexed asset. Prefer splitter `duration` over offset math (`endOffset − actualStart` can overshoot FFmpeg vs TwelveLabs). */
export function pegasusIndexedVideoDurationSec(chunk: ChunkInfo): number {
  const minLen = 4.001;
  if (
    chunk.duration > 0 &&
    Number.isFinite(chunk.duration)
  ) {
    // Small trim avoids floating-point endpoints past the muxed/indexed duration cap.
    return Math.max(minLen, chunk.duration - 0.05);
  }
  if (
    chunk.actualDuration != null &&
    chunk.actualDuration > 0 &&
    Number.isFinite(chunk.actualDuration)
  ) {
    return Math.max(minLen, chunk.actualDuration - 0.05);
  }
  return Math.max(
    minLen,
    chunk.endOffset - (chunk.actualStartOffset ?? chunk.startOffset),
  );
}

export interface AssetInfo {
  assetId: string;
  isChunked: boolean;
  chunks?: ChunkInfo[];
  twelveLabsVideoId?: string; // For non-chunked videos
  twelveLabsIndexId?: string;
  duration?: number;
  /** Raw file location for Pegasus when `asset_id` is not usable (e.g. chunked). */
  s3VideoUrl?: string;
  s3Key?: string;
  transcriptionUrl?: string;
  status?: string;
}

export interface AnalyzeOptions {
  videoId?: string; // Optional - can derive from assetId
  prompt: string;
  startTime?: number; // In original video timeline
  endTime?: number; // In original video timeline
}

export interface AnalyzeResult {
  data: string;
  // For chunked videos, includes which chunk(s) the result came from
  sourceChunks?: number[];
}

export interface VideoMetadata {
  duration: number;
  width?: number;
  height?: number;
  fps?: number;
}

// ============================================================================
// Scene Detection Types
// ============================================================================

/**
 * Enriched scene break with visual/audio context.
 * Uses pipe-delimited format from 12Labs for token efficiency.
 *
 * Fields:
 * - time: timestamp in seconds
 * - who: people visible (2-5 words)
 * - action: what's happening visually (3-8 words)
 * - mood: emotional tone (tense/calm/funny/sad/exciting/dramatic/romantic/scary)
 * - audio: notable sounds (2-5 words, or "dialogue" if just talking)
 */
export interface SceneBreak {
  time: number; // seconds
  who: string; // people visible
  action: string; // what's happening visually
  mood: string; // emotional tone
  audio: string; // notable sounds
}

/**
 * Full scene detail - all available info
 * Available via get_scene_details() tool
 *
 * Includes enriched fields from pipe-delimited 12Labs response:
 * who, action, mood, audio
 */
export interface SceneDetail {
  time: number; // seconds
  endTime?: number; // seconds (estimated)
  location: string;
  characters: string[];
  description: string;
  visualNotes?: string;
  // Enriched fields from new pipe-delimited format
  who?: string;
  action?: string;
  mood?: string;
  audio?: string;
}

/**
 * Combined scene detection result
 */
export interface SceneDetectionResult {
  status: "complete"; // Explicitly mark as complete
  assetId: string;
  brief: SceneBreak[]; // For prompt context
  detailed: SceneDetail[]; // For tool queries
  detectedAt: string;
  // Error tracking for cache invalidation
  meta?: {
    windowsTotal: number;
    windowsSucceeded: number;
    windowsErrored: number; // Explicit error count (API failures, rate limits, config issues)
    hitRateLimit: boolean;
    isComplete: boolean; // true if windowsErrored === 0
  };
}

/**
 * Scene cache can be in_progress, complete, or failed
 */
export interface SceneCacheInProgress {
  status: "in_progress";
  startedAt: string;
  assetId: string;
}

export interface SceneCacheFailed {
  status: "failed";
  failedAt: string;
  error: string;
  assetId: string;
}

export type SceneCacheResult =
  | SceneDetectionResult
  | SceneCacheInProgress
  | SceneCacheFailed;

/**
 * Result of checking scene cache - includes status flags for caller
 */
export interface SceneCacheCheckResult {
  inProgress: boolean;
  failed: boolean;
  failedReason?: string;
  result: SceneDetectionResult | null;
}

// Scene cache bucket
const SCENE_CACHE_BUCKET =
  process.env.BUCKET_NAME || process.env.ASSETS_BUCKET || process.env.S3_BUCKET;

/**
 * Wrapper class for 12labs operations that handles chunked videos transparently
 */
export class TwelveLabsWrapper {
  private client: TwelveLabs;
  private assetsTable: string;
  private indexId: string;

  constructor(apiKey: string, assetsTable: string, indexId: string) {
    this.client = new TwelveLabs({ apiKey });
    this.assetsTable = assetsTable;
    this.indexId = indexId;
  }

  /**
   * Get asset info including chunk metadata if applicable
   */
  async getAssetInfo(assetId: string): Promise<AssetInfo> {
    const result = await docClient.send(
      new GetCommand({
        TableName: this.assetsTable,
        Key: { assetId },
      })
    );

    if (!result.Item) {
      throw new Error(`Asset not found: ${assetId}`);
    }

    return {
      assetId,
      isChunked: result.Item.isChunked || false,
      chunks: result.Item.chunks,
      twelveLabsVideoId: result.Item.twelveLabsVideoId,
      twelveLabsIndexId: result.Item.twelveLabsIndexId,
      duration: result.Item.duration,
      s3VideoUrl: result.Item.s3VideoUrl,
      s3Key: result.Item.key,
      transcriptionUrl: result.Item.transcriptionUrl,
      status: result.Item.status,
    };
  }

  /**
   * Find which chunk contains a given timestamp in the original video
   */
  private findChunkForTimestamp(
    chunks: ChunkInfo[],
    timestamp: number
  ): ChunkInfo | undefined {
    return chunks.find(
      (chunk) => timestamp >= chunk.startOffset && timestamp < chunk.endOffset
    );
  }

  /**
   * Convert original video timestamp to chunk-relative timestamp
   */
  private toChunkTimestamp(
    chunk: ChunkInfo,
    originalTimestamp: number
  ): number {
    return originalTimestamp - chunk.startOffset;
  }

  /**
   * Convert chunk-relative timestamp to original video timestamp
   */
  private toOriginalTimestamp(
    chunk: ChunkInfo,
    chunkTimestamp: number
  ): number {
    return chunkTimestamp + chunk.startOffset;
  }

  /**
   * Analyze video content using 12labs Pegasus
   * For chunked videos, queries relevant chunks IN PARALLEL with timeout/retry
   */
  async analyze(
    assetId: string,
    options: AnalyzeOptions
  ): Promise<AnalyzeResult> {
    const asset = await this.getAssetInfo(assetId);

    if (!asset.isChunked) {
      // Simple case: non-chunked video
      const videoId = options.videoId || asset.twelveLabsVideoId;
      if (!videoId) {
        throw new Error("No videoId available for asset");
      }

      const response = (await withRetry(
        () =>
          withTimeout(
            this.client.analyze({ videoId, prompt: options.prompt }),
            TWELVE_LABS_TIMEOUT_MS,
            "analyze"
          ),
        `analyze(${videoId})`
      )) as NonStreamAnalyzeResponse;

      return {
        data: response.data ?? String(response),
      };
    }

    // Chunked video: determine which chunks to query
    const chunks = asset.chunks || [];
    if (chunks.length === 0) {
      throw new Error("Chunked asset has no chunks");
    }

    let chunksToQuery: ChunkInfo[] = [];

    if (options.startTime !== undefined && options.endTime !== undefined) {
      // Query only chunks that overlap with the requested time range
      chunksToQuery = chunks.filter(
        (chunk) =>
          chunk.endOffset > options.startTime! &&
          chunk.startOffset < options.endTime!
      );
    } else {
      // Query all chunks
      chunksToQuery = chunks;
    }

    if (chunksToQuery.length === 0) {
      throw new Error("No chunks found for the specified time range");
    }

    console.log(
      `[12Labs] Analyzing ${chunksToQuery.length} chunks in parallel...`
    );

    // Query all chunks IN PARALLEL with timeout and retry
    const chunkPromises = chunksToQuery.map(async (chunk) => {
      if (!chunk.videoId) {
        console.warn(`Chunk ${chunk.chunkIndex} has no videoId, skipping`);
        return null;
      }

      try {
        // Modify prompt to include chunk context if needed
        let chunkPrompt = options.prompt;

        // If the prompt asks about specific times, adjust them
        if (options.startTime !== undefined && options.endTime !== undefined) {
          const chunkStart = Math.max(
            0,
            this.toChunkTimestamp(chunk, options.startTime)
          );
          const chunkEnd = Math.min(
            chunk.duration,
            this.toChunkTimestamp(chunk, options.endTime)
          );

          // Add time context to prompt
          chunkPrompt = chunkPrompt.replace(
            /from (\d+\.?\d*)s? to (\d+\.?\d*)s?/gi,
            `from ${chunkStart.toFixed(1)}s to ${chunkEnd.toFixed(1)}s`
          );
        }

        const response = (await withRetry(
          () =>
            withTimeout(
              this.client.analyze({
                videoId: chunk.videoId!,
                prompt: chunkPrompt,
              }),
              TWELVE_LABS_TIMEOUT_MS,
              `analyze-chunk-${chunk.chunkIndex}`
            ),
          `analyze(chunk ${chunk.chunkIndex})`
        )) as NonStreamAnalyzeResponse;

        const responseText = response.data ?? String(response);

        return {
          chunkIndex: chunk.chunkIndex,
          startOffset: chunk.startOffset,
          endOffset: chunk.endOffset,
          data: responseText,
        };
      } catch (err) {
        console.error(`Failed to analyze chunk ${chunk.chunkIndex}:`, err);
        return null;
      }
    });

    // Wait for all chunks (parallel)
    const chunkResults = await Promise.all(chunkPromises);

    // Filter out failures and sort by chunk index
    const successfulResults = chunkResults
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => a.chunkIndex - b.chunkIndex);

    if (successfulResults.length === 0) {
      throw new Error("Failed to analyze any chunks");
    }

    console.log(
      `[12Labs] Successfully analyzed ${successfulResults.length}/${chunksToQuery.length} chunks`
    );

    const results = successfulResults.map(
      (r) =>
        `[Chunk ${r.chunkIndex} (${r.startOffset}s-${r.endOffset}s)]: ${r.data}`
    );
    const sourceChunks = successfulResults.map((r) => r.chunkIndex);

    return {
      data: results.join("\n\n"),
      sourceChunks,
    };
  }

  /**
   * Get video metadata (duration, dimensions, etc.)
   * For chunked videos, returns total duration
   */
  async getVideoMetadata(assetId: string): Promise<VideoMetadata> {
    const asset = await this.getAssetInfo(assetId);

    if (!asset.isChunked) {
      const videoId = asset.twelveLabsVideoId;
      if (!videoId) {
        throw new Error("No videoId available for asset");
      }

      const video = await this.client.indexes.videos.retrieve(
        this.indexId,
        videoId
      );

      const anyVideo = video as any;
      return {
        duration: anyVideo.metadata?.duration || asset.duration || 0,
        width: anyVideo.metadata?.width,
        height: anyVideo.metadata?.height,
        fps: anyVideo.metadata?.fps,
      };
    }

    // For chunked videos, sum up chunk durations
    const chunks = asset.chunks || [];
    const totalDuration = chunks.reduce((sum, chunk) => {
      // Use endOffset of last chunk as total duration
      return Math.max(sum, chunk.endOffset);
    }, 0);

    // Get dimensions from first chunk
    const firstChunk = chunks.find((c) => c.chunkIndex === 0);
    let width: number | undefined;
    let height: number | undefined;
    let fps: number | undefined;

    if (firstChunk?.videoId) {
      try {
        const video = await this.client.indexes.videos.retrieve(
          this.indexId,
          firstChunk.videoId
        );
        const anyVideo = video as any;
        width = anyVideo.metadata?.width;
        height = anyVideo.metadata?.height;
        fps = anyVideo.metadata?.fps;
      } catch (err) {
        console.error("Failed to get metadata from first chunk:", err);
      }
    }

    return {
      duration: totalDuration,
      width,
      height,
      fps,
    };
  }

  /**
   * Get the underlying 12labs client for direct access when needed
   */
  getClient(): TwelveLabs {
    return this.client;
  }

  /**
   * Get all video IDs for an asset (single ID for non-chunked, multiple for chunked)
   */
  async getVideoIds(assetId: string): Promise<string[]> {
    const asset = await this.getAssetInfo(assetId);

    if (!asset.isChunked) {
      return asset.twelveLabsVideoId ? [asset.twelveLabsVideoId] : [];
    }

    const chunks = asset.chunks || [];
    return chunks
      .filter((c) => c.videoId)
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map((c) => c.videoId!);
  }

  // ==========================================================================
  // Scene Detection
  // ==========================================================================

  /**
   * Detect all scene changes in a video.
   * Uses 5-minute parallel chunks to avoid timeouts.
   * Results are cached in S3.
   *
   * Returns both brief (for prompts) and detailed (for tool) scene data.
   */
  async detectScenes(assetId: string): Promise<SceneDetectionResult> {
    // 1. Check S3 cache first
    const cacheCheck = await this.getSceneCacheFromS3(assetId);
    if (cacheCheck.result) {
      console.log(`[12Labs] Scene cache hit for ${assetId}`);
      return cacheCheck.result;
    }
    // Note: We don't check inProgress here because this method is called
    // by the detectScenes Lambda which should run to completion

    console.log(
      `[12Labs] Scene cache miss for ${assetId}, detecting scenes...`
    );

    // 2. Get asset info and video IDs
    const asset = await this.getAssetInfo(assetId);
    const videoDuration = asset.duration || 0;

    if (videoDuration <= 0) {
      throw new Error(
        `Cannot detect scenes: video duration unknown for ${assetId}`
      );
    }

    // 3. Determine if video is chunked
    const isChunked =
      asset.isChunked && asset.chunks && asset.chunks.length > 1;

    // 4. Get video ID(s) for the asset
    const videoIds = await this.getVideoIds(assetId);
    if (videoIds.length === 0) {
      throw new Error(`No video IDs available for asset ${assetId}`);
    }

    // 5. Detect scenes
    // IMPORTANT: 12Labs bills full video duration per analyze() call!
    // - Non-chunked: ONE call for entire video (bills video duration once)
    // - Chunked: ONE call per chunk (each chunk is a separate shorter video)
    let allScenes: SceneDetail[] = [];
    let hitRateLimit = false;
    let windowsSucceeded = 0;
    let windowsErrored = 0;
    let windowsTotal = 1;

    if (!isChunked) {
      // NON-CHUNKED: Single API call for entire video
      console.log(
        `[12Labs] Non-chunked video: single API call for ${Math.round(
          videoDuration
        )}s`
      );
      windowsTotal = 1;

      try {
        allScenes = await this.detectScenesForEntireVideo(
          videoIds[0],
          videoDuration
        );
        windowsSucceeded = 1;
      } catch (err: any) {
        const is429 =
          err?.status === 429 ||
          err?.statusCode === 429 ||
          err?.message?.includes("429");
        if (is429) hitRateLimit = true;
        windowsErrored = 1;
        console.error(`[12Labs] Scene detection failed:`, err?.message);
      }
    } else {
      // CHUNKED: One call per chunk (each chunk is a separate video file)
      const chunks = asset.chunks!.filter((c) => c.videoId);
      windowsTotal = chunks.length;
      console.log(`[12Labs] Chunked video: ${chunks.length} chunks to analyze`);

      for (const chunk of chunks) {
        if (hitRateLimit) {
          console.warn(
            `[12Labs] Stopping due to rate limit after ${windowsSucceeded}/${chunks.length} chunks`
          );
          break;
        }

        try {
          const chunkDuration = chunk.actualDuration ?? chunk.duration;
          const chunkOffset = chunk.actualStartOffset ?? chunk.startOffset;

          const scenes = await this.detectScenesForEntireVideo(
            chunk.videoId!,
            chunkDuration
          );

          // Adjust timestamps to original timeline
          const adjusted = scenes.map((s) => ({
            ...s,
            time: s.time + chunkOffset,
            endTime: s.endTime ? s.endTime + chunkOffset : undefined,
          }));
          allScenes.push(...adjusted);
          windowsSucceeded++;
          console.log(
            `[12Labs] Chunk ${chunk.chunkIndex}: ${scenes.length} scenes`
          );
        } catch (err: any) {
          const is429 =
            err?.status === 429 ||
            err?.statusCode === 429 ||
            err?.message?.includes("429");
          if (is429) hitRateLimit = true;
          windowsErrored++;
          console.error(
            `[12Labs] Chunk ${chunk.chunkIndex} failed:`,
            err?.message
          );
        }
      }
    }

    // 6. Merge scenes (sort by time)
    const mergedScenes = this.mergeOverlappingScenes(allScenes);

    const windowsSkipped = windowsTotal - windowsSucceeded - windowsErrored;
    const totalErrored = windowsErrored + windowsSkipped;
    const isComplete = totalErrored === 0;

    console.log(
      `[12Labs] Detected ${mergedScenes.length} scenes total ` +
        `(${windowsSucceeded}/${windowsTotal} ${
          isChunked ? "chunks" : "calls"
        } succeeded` +
        `${windowsErrored > 0 ? `, ${windowsErrored} errored` : ""}` +
        `${windowsSkipped > 0 ? `, ${windowsSkipped} skipped` : ""}` +
        `${hitRateLimit ? ", hit rate limit" : ""})`
    );

    // 7. Build result with both brief and detailed versions
    const result = {
      assetId,
      brief: mergedScenes.map((s) => ({
        time: s.time,
        who: s.who || "",
        action: s.action || "",
        mood: s.mood || "",
        audio: s.audio || "",
      })),
      detailed: mergedScenes,
      detectedAt: new Date().toISOString(),
      meta: {
        windowsTotal,
        windowsSucceeded,
        windowsErrored: totalErrored,
        hitRateLimit,
        isComplete,
      },
    };

    // 8. Cache in S3 (only if complete)
    await this.saveSceneCacheToS3(assetId, result);

    // Return with status field
    return { ...result, status: "complete" as const };
  }

  /**
   * Detect all scenes in a video with a single API call.
   * This is more efficient than windowed calls since 12Labs bills full video duration per call.
   *
   * Uses pipe-delimited format for ~40-50% token savings vs JSON.
   * Target: ~65 scenes per hour chunk (1 per ~55s).
   */
  private async detectScenesForEntireVideo(
    videoId: string,
    duration: number
  ): Promise<SceneDetail[]> {
    // Target ~1 scene per 55 seconds, min 15, max 70 per chunk
    const targetScenes = Math.min(70, Math.max(15, Math.round(duration / 55)));

    // Pipe-delimited prompt for token efficiency
    const prompt = `Analyze this ${Math.round(
      duration
    )} second video for scene changes.

For each scene, provide these fields separated by | (pipe):
1. time: timestamp in seconds (integer)
2. who: people visible (2-5 words)
3. action: what's happening visually (3-8 words)
4. mood: one word (tense/calm/funny/sad/exciting/dramatic/romantic/scary/neutral)
5. audio: notable sounds (2-5 words, or "dialogue" if just talking)

Output format - first line is header, then one scene per line:
time|who|action|mood|audio
0|HBO logo|static logo on screen|neutral|theme music
45|man in robe|walking to bathroom|calm|silence
120|two men|arguing in car|tense|radio playing

Target ~${targetScenes} scenes spread across the full video.
Mark scenes for: hard cuts, location changes, time jumps, or significant mood shifts.
Be concise. No extra text or explanation.`;

    // Retry loop for rate limits
    const maxAttempts = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Use streaming to keep connection alive for long videos
        const stream = await this.client.analyzeStream(
          {
            videoId,
            prompt,
            // No JSON schema - using plain text pipe-delimited format
            temperature: 0.1,
            maxTokens: 4096,
          },
          { timeoutInSeconds: 600 } // 10 minutes for long videos
        );

        // Collect all text chunks from the stream
        let fullText = "";
        for await (const event of stream) {
          if (event.eventType === "text_generation") {
            fullText += event.text;
          }
        }

        const data = fullText;
        if (!data) return [];

        // Parse pipe-delimited response
        const scenes = this.parsePipeDelimitedScenes(data);

        console.log(
          `[12Labs] Detected ${scenes.length} scenes in ${Math.round(
            duration
          )}s video`
        );

        return scenes;
      } catch (err: any) {
        const is429 =
          err?.status === 429 ||
          err?.statusCode === 429 ||
          err?.message?.includes("429") ||
          err?.message?.toLowerCase().includes("rate limit");

        if (is429 && attempt < maxAttempts) {
          let waitSec = 30 * attempt;
          const retryAfter =
            err?.rawResponse?.headers?.get?.("retry-after") ||
            err?.headers?.["retry-after"];
          if (retryAfter) {
            const parsed = parseInt(retryAfter, 10);
            if (!isNaN(parsed) && parsed > 0) {
              waitSec = Math.min(parsed + 5, 180);
            }
          }
          console.warn(
            `[12Labs] Rate limited, waiting ${waitSec}s before retry ${
              attempt + 1
            }/${maxAttempts}`
          );
          await new Promise((r) => setTimeout(r, waitSec * 1000));
          lastError = err;
          continue;
        }

        // Log detailed error info for debugging
        console.error(`[12Labs] Scene detection error:`, err);
        if (err?.body) {
          try {
            // Try to read the response body for more details
            let bodyText: string;
            if (typeof err.body === "string") {
              bodyText = err.body;
            } else if (err.body.getReader) {
              // ReadableStream - need to consume it
              const reader = err.body.getReader();
              const chunks: Uint8Array[] = [];
              let done = false;
              while (!done) {
                const result = await reader.read();
                done = result.done;
                if (result.value) chunks.push(result.value);
              }
              const decoder = new TextDecoder();
              bodyText = chunks.map((c) => decoder.decode(c)).join("");
            } else {
              bodyText = JSON.stringify(err.body);
            }
            console.error(`[12Labs] Error body:`, bodyText);
          } catch (e) {
            console.error(`[12Labs] Could not read error body:`, e);
          }
        }
        throw err;
      }
    }

    throw lastError || new Error("Scene detection failed after retries");
  }

  /**
   * Parse pipe-delimited scene response from 12Labs.
   * Format: time|who|action|mood|audio (one scene per line, header row first)
   */
  private parsePipeDelimitedScenes(response: string): SceneDetail[] {
    const lines = response.trim().split("\n");
    const scenes: SceneDetail[] = [];

    for (const line of lines) {
      // Skip header row and empty lines
      if (
        !line.trim() ||
        line.toLowerCase().startsWith("time|") ||
        line.toLowerCase().includes("|who|")
      ) {
        continue;
      }

      const parts = line.split("|");
      if (parts.length < 5) continue;

      const time = parseInt(parts[0].trim(), 10);
      if (isNaN(time)) continue;

      const who = parts[1]?.trim() || "";
      const action = parts[2]?.trim() || "";
      const mood = parts[3]?.trim() || "";
      const audio = parts[4]?.trim() || "";

      // Build description from the enriched fields for backwards compatibility
      const description = `${who} - ${action}`.trim();

      scenes.push({
        time,
        endTime: undefined,
        location: "", // Not used in new format
        characters: who ? [who] : [],
        description,
        visualNotes: mood ? `Mood: ${mood}` : "",
        // Enriched fields for new SceneBreak format
        who,
        action,
        mood,
        audio,
      });
    }

    return scenes;
  }

  /**
   * Sort scenes by time.
   * No deduplication - we preserve all scenes to avoid losing legitimate
   * back-to-back cuts. Claude can mentally dedupe when reviewing.
   */
  private mergeOverlappingScenes(scenes: SceneDetail[]): SceneDetail[] {
    if (scenes.length === 0) return [];

    // Just sort by time, no dedup
    return [...scenes].sort((a, b) => a.time - b.time);
  }

  /**
   * Get cached scene detection from S3.
   * Returns { inProgress: true, result: null } if detection is running.
   * Returns { inProgress: false, result: data } if complete.
   * Returns { inProgress: false, result: null } if no cache or stale.
   */
  async getSceneCacheFromS3(assetId: string): Promise<SceneCacheCheckResult> {
    if (!SCENE_CACHE_BUCKET) {
      return { inProgress: false, failed: false, result: null };
    }

    try {
      const key = `scene-cache/${assetId}.json`;
      const response = await s3Client.send(
        new GetObjectCommand({
          Bucket: SCENE_CACHE_BUCKET,
          Key: key,
        })
      );

      const bodyString = await response.Body?.transformToString();
      if (!bodyString) {
        return { inProgress: false, failed: false, result: null };
      }

      const parsed = JSON.parse(bodyString);

      // Check status field
      if (parsed.status === "in_progress") {
        // Check if stale (> 20 minutes)
        const startedAt = new Date(parsed.startedAt).getTime();
        const now = Date.now();
        const staleThresholdMs = 20 * 60 * 1000; // 20 minutes

        if (now - startedAt > staleThresholdMs) {
          console.log(
            `[12Labs] Scene detection stale for ${assetId} (started ${Math.round(
              (now - startedAt) / 60000
            )} min ago)`
          );
          return {
            inProgress: false,
            failed: true,
            failedReason: "Stale (timed out)",
            result: null,
          };
        }

        console.log(`[12Labs] Scene detection in progress for ${assetId}`);
        return { inProgress: true, failed: false, result: null };
      }

      if (parsed.status === "failed") {
        console.log(
          `[12Labs] Previous scene detection failed for ${assetId}: ${parsed.error}`
        );
        return {
          inProgress: false,
          failed: true,
          failedReason: parsed.error,
          result: null,
        };
      }

      // Validate complete result structure
      if (
        parsed.status !== "complete" ||
        !parsed.assetId ||
        !Array.isArray(parsed.brief) ||
        !Array.isArray(parsed.detailed) ||
        !parsed.detectedAt
      ) {
        console.warn(
          `[12Labs] Invalid scene cache structure for ${assetId}, ignoring`
        );
        return { inProgress: false, failed: false, result: null };
      }

      return {
        inProgress: false,
        failed: false,
        result: parsed as SceneDetectionResult,
      };
    } catch (err: any) {
      if (err.name !== "NoSuchKey") {
        console.warn(`[12Labs] Failed to read scene cache:`, err.message);
      }
      return { inProgress: false, failed: false, result: null };
    }
  }

  /**
   * Save scene detection to S3 cache.
   * Only caches complete results - incomplete results are not cached
   * so next request will re-run detection.
   */
  private async saveSceneCacheToS3(
    assetId: string,
    result: Omit<SceneDetectionResult, "status">
  ): Promise<void> {
    if (!SCENE_CACHE_BUCKET) return;

    // Only cache complete results
    if (!result.meta?.isComplete) {
      console.log(
        `[12Labs] Not caching incomplete result for ${assetId} ` +
          `(${result.meta?.windowsSucceeded}/${result.meta?.windowsTotal} windows succeeded)`
      );
      return;
    }

    try {
      const key = `scene-cache/${assetId}.json`;
      // Add status: "complete" when saving
      const cacheData: SceneDetectionResult = {
        ...result,
        status: "complete",
      };
      await s3Client.send(
        new PutObjectCommand({
          Bucket: SCENE_CACHE_BUCKET,
          Key: key,
          Body: JSON.stringify(cacheData),
          ContentType: "application/json",
        })
      );
      console.log(
        `[12Labs] Cached complete scene detection for ${assetId} ` +
          `(${result.meta.windowsSucceeded}/${result.meta.windowsTotal} windows)`
      );
    } catch (err: any) {
      console.warn(`[12Labs] Failed to cache scene detection:`, err.message);
    }
  }
}

/**
 * Create a TwelveLabsWrapper instance with environment configuration
 */
export function createTwelveLabsWrapper(
  apiKey: string,
  assetsTable?: string,
  indexId?: string
): TwelveLabsWrapper {
  const table =
    assetsTable || process.env.ASSETS_TABLE || process.env.TABLE_NAME;
  const index = indexId || process.env.TWELVE_LABS_INDEX_ID;

  if (!table) {
    throw new Error("Assets table name not provided");
  }
  if (!index) {
    throw new Error("12Labs index ID not provided");
  }

  return new TwelveLabsWrapper(apiKey, table, index);
}
