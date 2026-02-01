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
type SummarizeResponse = TwelvelabsApi.SummarizeResponse;
type Gist = TwelvelabsApi.Gist;

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

// ============================================================================
// Timeout & Retry Configuration
// ============================================================================

const TWELVE_LABS_TIMEOUT_MS = 60_000; // 60 seconds per API call
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

export interface AssetInfo {
  assetId: string;
  isChunked: boolean;
  chunks?: ChunkInfo[];
  twelveLabsVideoId?: string; // For non-chunked videos
  twelveLabsIndexId?: string;
  duration?: number;
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

export interface GistOptions {
  videoId?: string;
  types: ("title" | "topic" | "hashtag")[];
}

export interface GistResult {
  title?: string;
  topics?: string[];
  hashtags?: string[];
}

export interface TranscriptionSegment {
  start: number; // Adjusted to original video timeline
  end: number; // Adjusted to original video timeline
  text: string;
}

// ============================================================================
// Summarize API Types (chapters, highlights, summaries)
// ============================================================================

export type SummarizeType = "summary" | "chapter" | "highlight";

export interface SummarizeOptions {
  videoId?: string;
  type: SummarizeType;
  prompt?: string; // Optional prompt to customize output
  temperature?: number; // 0-1, default 0.2
}

export interface ChapterSegment {
  chapterNumber: number;
  start: number; // seconds
  end: number; // seconds
  chapterTitle: string;
  chapterSummary: string;
}

export interface HighlightSegment {
  start: number; // seconds
  end: number; // seconds
  highlight: string;
  highlightSummary?: string;
}

export interface SummarizeResult {
  type: SummarizeType;
  summary?: string;
  chapters?: ChapterSegment[];
  highlights?: HighlightSegment[];
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
 * Brief scene break info - timestamp + one sentence
 * This is what Claude sees by default
 */
export interface SceneBreak {
  time: number; // seconds
  description: string; // one sentence
}

/**
 * Full scene detail - all available info
 * Available via get_scene_details() tool
 */
export interface SceneDetail {
  time: number; // seconds
  endTime?: number; // seconds (estimated)
  location: string;
  characters: string[];
  description: string;
  visualNotes?: string;
}

/**
 * Combined scene detection result
 */
export interface SceneDetectionResult {
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

// Scene detection constants
const SCENE_CHUNK_DURATION_SEC = 600; // 10 minutes (was 5 - reduces API calls)
const SCENE_CHUNK_OVERLAP_SEC = 30; // 30 second overlap
const SCENE_PARALLEL_CHUNKS = 2; // Max concurrent 12Labs calls (was 4 - reduces rate limit pressure)
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
   * Get video gist (title, topics, hashtags)
   * For chunked videos, aggregates from all chunks IN PARALLEL
   */
  async gist(assetId: string, options: GistOptions): Promise<GistResult> {
    const asset = await this.getAssetInfo(assetId);

    if (!asset.isChunked) {
      const videoId = options.videoId || asset.twelveLabsVideoId;
      if (!videoId) {
        throw new Error("No videoId available for asset");
      }

      const response = (await withRetry(
        () =>
          withTimeout(
            this.client.gist({ videoId, types: options.types }),
            TWELVE_LABS_TIMEOUT_MS,
            "gist"
          ),
        `gist(${videoId})`
      )) as Gist;

      return {
        title: response.title,
        topics: response.topics,
        hashtags: response.hashtags,
      };
    }

    // For chunked videos, query all chunks IN PARALLEL
    const chunks = asset.chunks || [];
    const firstChunk = chunks.find((c) => c.chunkIndex === 0);

    if (!firstChunk?.videoId) {
      throw new Error("First chunk has no videoId");
    }

    console.log(
      `[12Labs] Getting gist from ${chunks.length} chunks in parallel...`
    );

    const gistPromises = chunks.map(async (chunk) => {
      if (!chunk.videoId) return null;

      try {
        const response = (await withRetry(
          () =>
            withTimeout(
              this.client.gist({
                videoId: chunk.videoId!,
                types: options.types,
              }),
              TWELVE_LABS_TIMEOUT_MS,
              `gist-chunk-${chunk.chunkIndex}`
            ),
          `gist(chunk ${chunk.chunkIndex})`
        )) as Gist;

        return {
          chunkIndex: chunk.chunkIndex,
          title: response.title,
          topics: response.topics || [],
          hashtags: response.hashtags || [],
        };
      } catch (err) {
        console.error(`Failed to get gist for chunk ${chunk.chunkIndex}:`, err);
        return null;
      }
    });

    const results = await Promise.all(gistPromises);

    // Aggregate results
    let title: string | undefined;
    const allTopics: Set<string> = new Set();
    const allHashtags: Set<string> = new Set();

    for (const result of results) {
      if (!result) continue;

      // Use title from first chunk only
      if (result.chunkIndex === 0 && result.title) {
        title = result.title;
      }

      result.topics.forEach((t: string) => allTopics.add(t));
      result.hashtags.forEach((h: string) => allHashtags.add(h));
    }

    return {
      title,
      topics: Array.from(allTopics),
      hashtags: Array.from(allHashtags),
    };
  }

  /**
   * Get video transcription with timestamps adjusted to original video timeline
   * For chunked videos, fetches all chunks IN PARALLEL
   */
  async getTranscription(assetId: string): Promise<TranscriptionSegment[]> {
    const asset = await this.getAssetInfo(assetId);

    if (!asset.isChunked) {
      const videoId = asset.twelveLabsVideoId;
      if (!videoId) {
        throw new Error("No videoId available for asset");
      }

      // Fetch transcription from 12labs API
      const response = await this.fetchTranscription(videoId);
      return response;
    }

    // For chunked videos, fetch all transcriptions IN PARALLEL
    const chunks = asset.chunks || [];
    console.log(
      `[12Labs] Getting transcription from ${chunks.length} chunks in parallel...`
    );

    const transcriptionPromises = chunks.map(async (chunk) => {
      if (!chunk.videoId) return null;

      try {
        const chunkTranscription = await this.fetchTranscription(chunk.videoId);

        // Adjust timestamps to original video timeline
        return {
          chunkIndex: chunk.chunkIndex,
          segments: chunkTranscription.map((segment) => ({
            start: this.toOriginalTimestamp(chunk, segment.start),
            end: this.toOriginalTimestamp(chunk, segment.end),
            text: segment.text,
          })),
        };
      } catch (err) {
        console.error(
          `Failed to get transcription for chunk ${chunk.chunkIndex}:`,
          err
        );
        return null;
      }
    });

    const results = await Promise.all(transcriptionPromises);

    // Merge all segments
    const allSegments: TranscriptionSegment[] = [];
    for (const result of results) {
      if (result) {
        allSegments.push(...result.segments);
      }
    }

    // Sort by start time and remove duplicates from chunk overlaps
    allSegments.sort((a, b) => a.start - b.start);

    // Remove duplicate segments from overlap regions
    const deduped: TranscriptionSegment[] = [];
    for (const segment of allSegments) {
      const last = deduped[deduped.length - 1];
      // Skip if this segment overlaps significantly with the previous one
      if (last && segment.start < last.end - 1) {
        continue;
      }
      deduped.push(segment);
    }

    return deduped;
  }

  /**
   * Fetch transcription from 12labs API for a single video
   * Includes timeout and retry logic
   */
  private async fetchTranscription(
    videoId: string
  ): Promise<TranscriptionSegment[]> {
    try {
      const video = await withRetry(
        () =>
          withTimeout(
            this.client.indexes.videos.retrieve(this.indexId, videoId),
            TWELVE_LABS_TIMEOUT_MS,
            `fetchTranscription(${videoId})`
          ),
        `fetchTranscription(${videoId})`
      );

      // The transcription might be in different places depending on API version
      const anyVideo = video as any;
      const transcription = anyVideo.transcription || anyVideo.transcript || [];

      if (!Array.isArray(transcription)) {
        return [];
      }

      return transcription.map((seg: any) => ({
        start: seg.start || seg.startTime || 0,
        end: seg.end || seg.endTime || 0,
        text: seg.text || seg.value || "",
      }));
    } catch (err) {
      console.error(`Failed to fetch transcription for video ${videoId}:`, err);
      return [];
    }
  }

  /**
   * Get video summaries, chapters, or highlights using 12Labs Summarize API
   *
   * This is a powerful endpoint that returns:
   * - summary: A brief text summary of the video
   * - chapter: Timestamped chapters with titles and summaries (GREAT for scene breakdown!)
   * - highlight: Timestamped key moments (GREAT for peak moment detection!)
   *
   * For chunked videos, merges results and adjusts timestamps.
   */
  async summarize(
    assetId: string,
    options: SummarizeOptions
  ): Promise<SummarizeResult> {
    const asset = await this.getAssetInfo(assetId);
    const { type, prompt, temperature = 0.2 } = options;

    console.log(`[12Labs] Getting ${type} for asset ${assetId}...`);

    if (!asset.isChunked) {
      // Simple case: non-chunked video
      const videoId = options.videoId || asset.twelveLabsVideoId;
      if (!videoId) {
        throw new Error("No videoId available for asset");
      }

      return this.fetchSummarize(videoId, type, prompt, temperature);
    }

    // Chunked video: get chapters/highlights from each chunk and merge
    const chunks = asset.chunks || [];
    if (chunks.length === 0) {
      throw new Error("Chunked asset has no chunks");
    }

    console.log(
      `[12Labs] Getting ${type} from ${chunks.length} chunks in parallel...`
    );

    const chunkPromises = chunks.map(async (chunk) => {
      if (!chunk.videoId) return null;

      try {
        const result = await this.fetchSummarize(
          chunk.videoId,
          type,
          prompt,
          temperature
        );

        // Adjust timestamps to original video timeline
        return {
          chunkIndex: chunk.chunkIndex,
          startOffset: chunk.startOffset,
          result: this.adjustSummarizeTimestamps(result, chunk.startOffset),
        };
      } catch (err) {
        console.error(
          `Failed to get ${type} for chunk ${chunk.chunkIndex}:`,
          err
        );
        return null;
      }
    });

    const results = await Promise.all(chunkPromises);
    const successfulResults = results
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => a.chunkIndex - b.chunkIndex);

    if (successfulResults.length === 0) {
      throw new Error(`Failed to get ${type} from any chunks`);
    }

    // Merge results
    return this.mergeSummarizeResults(
      successfulResults.map((r) => r.result),
      type
    );
  }

  /**
   * Fetch summarize from 12Labs API for a single video
   */
  private async fetchSummarize(
    videoId: string,
    type: SummarizeType,
    prompt?: string,
    temperature: number = 0.2
  ): Promise<SummarizeResult> {
    // SDK uses camelCase for parameters
    const requestBody: any = {
      videoId, // camelCase, not snake_case
      type,
      temperature,
    };

    if (prompt) {
      requestBody.prompt = prompt;
    }

    const response = (await withRetry(
      () =>
        withTimeout(
          this.client.summarize(requestBody),
          TWELVE_LABS_TIMEOUT_MS,
          `summarize(${videoId})`
        ),
      `summarize(${videoId})`
    )) as SummarizeResponse;

    // Parse response based on type
    if (type === "summary" && "summary" in response) {
      return {
        type: "summary",
        summary: response.summary || String(response),
      };
    }

    if (type === "chapter" && "chapters" in response) {
      const chapters: ChapterSegment[] = (response.chapters || []).map(
        (c, i) => ({
          chapterNumber: c.chapterNumber || i + 1,
          start: c.start || 0,
          end: c.end || 0,
          chapterTitle: c.chapterTitle || "",
          chapterSummary: c.chapterSummary || "",
        })
      );

      return { type: "chapter", chapters };
    }

    if (type === "highlight" && "highlights" in response) {
      const highlights: HighlightSegment[] = (response.highlights || []).map(
        (h) => ({
          start: h.start || 0,
          end: h.end || 0,
          highlight: h.highlight || "",
          highlightSummary: h.highlightSummary || "",
        })
      );

      return { type: "highlight", highlights };
    }

    return { type };
  }

  /**
   * Adjust timestamps in a SummarizeResult by an offset
   */
  private adjustSummarizeTimestamps(
    result: SummarizeResult,
    offset: number
  ): SummarizeResult {
    if (result.chapters) {
      return {
        ...result,
        chapters: result.chapters.map((c) => ({
          ...c,
          start: c.start + offset,
          end: c.end + offset,
        })),
      };
    }

    if (result.highlights) {
      return {
        ...result,
        highlights: result.highlights.map((h) => ({
          ...h,
          start: h.start + offset,
          end: h.end + offset,
        })),
      };
    }

    return result;
  }

  /**
   * Merge multiple SummarizeResults into one
   */
  private mergeSummarizeResults(
    results: SummarizeResult[],
    type: SummarizeType
  ): SummarizeResult {
    if (type === "summary") {
      // Concatenate summaries
      const summaries = results.map((r) => r.summary).filter(Boolean);
      return {
        type: "summary",
        summary: summaries.join(" "),
      };
    }

    if (type === "chapter") {
      // Merge and renumber chapters
      const allChapters: ChapterSegment[] = [];
      for (const result of results) {
        if (result.chapters) {
          allChapters.push(...result.chapters);
        }
      }

      // Sort by start time and renumber
      allChapters.sort((a, b) => a.start - b.start);
      allChapters.forEach((c, i) => (c.chapterNumber = i + 1));

      return { type: "chapter", chapters: allChapters };
    }

    if (type === "highlight") {
      // Merge highlights
      const allHighlights: HighlightSegment[] = [];
      for (const result of results) {
        if (result.highlights) {
          allHighlights.push(...result.highlights);
        }
      }

      // Sort by start time
      allHighlights.sort((a, b) => a.start - b.start);

      return { type: "highlight", highlights: allHighlights };
    }

    return { type };
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
    const cached = await this.getSceneCacheFromS3(assetId);
    if (cached) {
      console.log(`[12Labs] Scene cache hit for ${assetId}`);
      return cached;
    }

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

    // 4. Build time windows - use chunk-aware windows for chunked videos
    // to prevent windows from spanning chunk boundaries
    const windows = isChunked
      ? this.buildChunkAwareWindows(asset.chunks!)
      : this.buildSceneDetectionWindows(videoDuration);
    console.log(
      `[12Labs] Detecting scenes in ${windows.length} windows ` +
        `(${SCENE_CHUNK_DURATION_SEC}s each${isChunked ? ", chunk-aware" : ""})`
    );

    // 5. Get video ID(s) for the asset
    const videoIds = await this.getVideoIds(assetId);
    if (videoIds.length === 0) {
      throw new Error(`No video IDs available for asset ${assetId}`);
    }

    // 6. Run detection in parallel batches
    const allScenes: SceneDetail[] = [];
    let hitRateLimit = false;
    let windowsSucceeded = 0;
    let windowsErrored = 0;

    for (let i = 0; i < windows.length; i += SCENE_PARALLEL_CHUNKS) {
      // Stop early if we hit rate limit
      if (hitRateLimit) {
        console.warn(
          `[12Labs] Stopping scene detection due to rate limit, processed ${i}/${windows.length} windows`
        );
        break;
      }

      const batch = windows.slice(i, i + SCENE_PARALLEL_CHUNKS);

      const batchPromises = batch.map(async (window) => {
        // Find the right videoId for this time window
        let videoId: string;
        let adjustedStart = window.start;
        let adjustedEnd = window.end;
        // Offset to convert video timestamps to original timeline
        // - Non-chunked: 0 (video time = original time)
        // - Chunked: chunk.startOffset (chunk video time + offset = original time)
        let timelineOffset = 0;

        if (isChunked && asset.chunks) {
          // Find chunk that contains this window's start
          const chunk = asset.chunks.find(
            (c) => window.start >= c.startOffset && window.start < c.endOffset
          );
          if (!chunk?.videoId) {
            console.warn(
              `[12Labs] No chunk found for window ${window.start}-${window.end}s`
            );
            return { scenes: [], rateLimited: false, error: true };
          }
          videoId = chunk.videoId;
          // Use actualStartOffset for precise timing (accounts for FFmpeg keyframe seeking)
          // Fall back to startOffset if actualStartOffset not available
          const chunkOffset = chunk.actualStartOffset ?? chunk.startOffset;
          const chunkDuration = chunk.actualDuration ?? chunk.duration;
          // Adjust times to be chunk-relative (for the API call)
          // Clamp to valid range in case actual offset differs from intended
          adjustedStart = Math.max(0, window.start - chunkOffset);
          adjustedEnd = Math.min(window.end - chunkOffset, chunkDuration);
          // Offset to convert chunk-video timestamps back to original timeline
          timelineOffset = chunkOffset;
        } else {
          videoId = videoIds[0];
          // Non-chunked: video timestamps ARE original timestamps
          timelineOffset = 0;
        }

        try {
          const scenes = await this.detectScenesInWindow(
            videoId,
            adjustedStart,
            adjustedEnd,
            timelineOffset
          );
          // Empty scenes is valid (no scene changes in window)
          return { scenes, rateLimited: false, error: false };
        } catch (err: any) {
          // Check for rate limit error
          if (
            err?.statusCode === 429 ||
            err?.message?.includes("429") ||
            err?.message?.includes("rate limit")
          ) {
            console.error(
              `[12Labs] Rate limit hit for window ${window.start}-${window.end}s`
            );
            return { scenes: [], rateLimited: true, error: true };
          }
          console.warn(
            `[12Labs] Scene detection failed for window ${window.start}-${window.end}s:`,
            err
          );
          return { scenes: [], rateLimited: false, error: true };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      for (const result of batchResults) {
        if (result.rateLimited) {
          hitRateLimit = true;
        }
        // Track success and errors explicitly
        if (result.error) {
          windowsErrored++;
        } else {
          windowsSucceeded++;
        }
        allScenes.push(...result.scenes);
      }
    }

    // 7. Merge and deduplicate scenes from overlapping windows
    const mergedScenes = this.mergeOverlappingScenes(allScenes);

    // Account for skipped windows (from early rate limit exit)
    const windowsProcessed = windowsSucceeded + windowsErrored;
    const windowsSkipped = windows.length - windowsProcessed;
    const totalErrored = windowsErrored + windowsSkipped;
    const isComplete = totalErrored === 0;

    console.log(
      `[12Labs] Detected ${mergedScenes.length} scenes total ` +
        `(${windowsSucceeded}/${windows.length} windows succeeded` +
        `${windowsErrored > 0 ? `, ${windowsErrored} errored` : ""}` +
        `${windowsSkipped > 0 ? `, ${windowsSkipped} skipped` : ""}` +
        `${hitRateLimit ? ", hit rate limit" : ""})`
    );

    // 8. Build result with both brief and detailed versions
    const result: SceneDetectionResult = {
      assetId,
      brief: mergedScenes.map((s) => ({
        time: s.time,
        description: s.description,
      })),
      detailed: mergedScenes,
      detectedAt: new Date().toISOString(),
      meta: {
        windowsTotal: windows.length,
        windowsSucceeded,
        windowsErrored: totalErrored, // Includes skipped windows
        hitRateLimit,
        isComplete,
      },
    };

    // 9. Cache in S3 (only if complete)
    await this.saveSceneCacheToS3(assetId, result);

    return result;
  }

  /**
   * Build time windows for scene detection
   */
  private buildSceneDetectionWindows(
    duration: number
  ): Array<{ start: number; end: number }> {
    const windows: Array<{ start: number; end: number }> = [];

    for (
      let start = 0;
      start < duration;
      start += SCENE_CHUNK_DURATION_SEC - SCENE_CHUNK_OVERLAP_SEC
    ) {
      const end = Math.min(start + SCENE_CHUNK_DURATION_SEC, duration);
      windows.push({ start, end });

      // If this window reaches the end, stop
      if (end >= duration) break;
    }

    return windows;
  }

  /**
   * Build scene detection windows that respect chunk boundaries.
   * This prevents windows from spanning multiple chunks, which would cause
   * parts of the video to be skipped.
   */
  private buildChunkAwareWindows(
    chunks: ChunkInfo[]
  ): Array<{ start: number; end: number }> {
    const windows: Array<{ start: number; end: number }> = [];

    for (const chunk of chunks) {
      // Build windows within this chunk
      for (
        let start = chunk.startOffset;
        start < chunk.endOffset;
        start += SCENE_CHUNK_DURATION_SEC - SCENE_CHUNK_OVERLAP_SEC
      ) {
        // Cap end at chunk boundary
        const end = Math.min(start + SCENE_CHUNK_DURATION_SEC, chunk.endOffset);
        windows.push({ start, end });

        // If this window reaches the chunk end, move to next chunk
        if (end >= chunk.endOffset) break;
      }
    }

    return windows;
  }

  /**
   * Detect scenes in a single time window using 12Labs analyze API
   */
  private async detectScenesInWindow(
    videoId: string,
    startTime: number,
    endTime: number,
    timelineOffset: number // Add this to results to get original timeline
  ): Promise<SceneDetail[]> {
    // Simple prompt - model just reports what it sees, we handle all timestamp math
    const prompt = `Analyze the video from ${Math.round(
      startTime
    )}s to ${Math.round(endTime)}s.

List all scene changes. A scene change is:
- A hard cut (visual transition between shots)
- A location change
- A significant time jump

For each scene, provide:
- time: timestamp in seconds
- endTime: when scene ends in seconds
- location: where the scene takes place
- characters: who appears
- description: what happens (one sentence)
- visualNotes: camera style, lighting, pacing`;

    const schema = {
      type: "object",
      properties: {
        scenes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              time: { type: "number" },
              endTime: { type: "number" },
              location: { type: "string" },
              characters: { type: "array", items: { type: "string" } },
              description: { type: "string" },
              visualNotes: { type: "string" },
            },
            required: ["time", "description"],
          },
        },
      },
      required: ["scenes"],
    };

    try {
      const response = await withTimeout(
        this.client.analyze({
          videoId,
          prompt,
          responseFormat: {
            type: "json_schema",
            jsonSchema: schema,
          },
          temperature: 0.1, // Low temperature for consistent scene detection
          maxTokens: 2000,
        }),
        TWELVE_LABS_TIMEOUT_MS,
        `detectScenes(${videoId})`
      );

      const data = response.data;
      if (!data) {
        return [];
      }

      // Parse JSON response - handle various formats
      let parsed: { scenes?: any[] };
      try {
        // Try direct JSON parse first
        parsed = JSON.parse(data);
      } catch {
        // Try to extract JSON from markdown code blocks
        const jsonMatch = data.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
          try {
            parsed = JSON.parse(jsonMatch[1].trim());
          } catch {
            throw new Error(
              `Failed to parse scene detection response as JSON (markdown extraction failed)`
            );
          }
        } else {
          // Last resort: try to find JSON object in response
          const objMatch = data.match(/\{[\s\S]*"scenes"[\s\S]*\}/);
          if (objMatch) {
            try {
              parsed = JSON.parse(objMatch[0]);
            } catch {
              throw new Error(
                `Failed to parse scene detection response as JSON (object extraction failed)`
              );
            }
          } else {
            throw new Error(
              `Failed to parse scene detection response as JSON (no valid JSON found)`
            );
          }
        }
      }

      if (!parsed.scenes || !Array.isArray(parsed.scenes)) {
        // Valid response but no scenes found - this is OK (not an error)
        return [];
      }

      // Filter to requested range, then shift timestamps to original timeline
      // Model returns timestamps relative to video file (0-based)
      // We add timelineOffset to convert to original video timeline
      return parsed.scenes
        .filter((s: any) => {
          const sceneTime = s.time || 0;
          // Keep scenes within requested range (with small buffer for edge cases)
          return sceneTime >= startTime - 5 && sceneTime <= endTime + 5;
        })
        .map((s: any) => ({
          // Shift timestamp to original timeline
          time: (s.time || 0) + timelineOffset,
          endTime: s.endTime ? s.endTime + timelineOffset : undefined,
          location: s.location || "Unknown",
          characters: Array.isArray(s.characters) ? s.characters : [],
          description: s.description || "",
          visualNotes: s.visualNotes || "",
        }));
    } catch (err) {
      // Throw so caller can mark this as an error
      console.error(`[12Labs] Scene detection error for window:`, err);
      throw err;
    }
  }

  /**
   * Sort scenes from overlapping windows by time.
   * No deduplication - we preserve all scenes to avoid losing legitimate
   * back-to-back cuts. Claude can mentally dedupe when reviewing.
   */
  private mergeOverlappingScenes(scenes: SceneDetail[]): SceneDetail[] {
    if (scenes.length === 0) return [];

    // Just sort by time, no dedup
    return [...scenes].sort((a, b) => a.time - b.time);
  }

  /**
   * Get cached scene detection from S3
   */
  private async getSceneCacheFromS3(
    assetId: string
  ): Promise<SceneDetectionResult | null> {
    if (!SCENE_CACHE_BUCKET) return null;

    try {
      const key = `scene-cache/${assetId}.json`;
      const response = await s3Client.send(
        new GetObjectCommand({
          Bucket: SCENE_CACHE_BUCKET,
          Key: key,
        })
      );

      const bodyString = await response.Body?.transformToString();
      if (!bodyString) return null;

      const parsed = JSON.parse(bodyString);

      // Validate required fields to catch corrupted cache
      if (
        !parsed.assetId ||
        !Array.isArray(parsed.brief) ||
        !Array.isArray(parsed.detailed) ||
        !parsed.detectedAt
      ) {
        console.warn(
          `[12Labs] Invalid scene cache structure for ${assetId}, ignoring`
        );
        return null;
      }

      return parsed as SceneDetectionResult;
    } catch (err: any) {
      if (err.name !== "NoSuchKey") {
        console.warn(`[12Labs] Failed to read scene cache:`, err.message);
      }
      return null;
    }
  }

  /**
   * Save scene detection to S3 cache.
   * Only caches complete results - incomplete results are not cached
   * so next request will re-run detection.
   */
  private async saveSceneCacheToS3(
    assetId: string,
    result: SceneDetectionResult
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
      await s3Client.send(
        new PutObjectCommand({
          Bucket: SCENE_CACHE_BUCKET,
          Key: key,
          Body: JSON.stringify(result),
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
