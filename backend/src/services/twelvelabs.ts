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
import { TwelveLabs, TwelvelabsApi } from "twelvelabs-js";

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
  startOffset: number; // Start time in original video (seconds)
  endOffset: number; // End time in original video (seconds)
  duration: number;
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
