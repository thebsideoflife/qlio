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
import { TwelveLabs } from "twelvelabs-js";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

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
  private toChunkTimestamp(chunk: ChunkInfo, originalTimestamp: number): number {
    return originalTimestamp - chunk.startOffset;
  }

  /**
   * Convert chunk-relative timestamp to original video timestamp
   */
  private toOriginalTimestamp(chunk: ChunkInfo, chunkTimestamp: number): number {
    return chunkTimestamp + chunk.startOffset;
  }

  /**
   * Analyze video content using 12labs Pegasus
   * For chunked videos, queries relevant chunks and adjusts timestamps
   */
  async analyze(assetId: string, options: AnalyzeOptions): Promise<AnalyzeResult> {
    const asset = await this.getAssetInfo(assetId);

    if (!asset.isChunked) {
      // Simple case: non-chunked video
      const videoId = options.videoId || asset.twelveLabsVideoId;
      if (!videoId) {
        throw new Error("No videoId available for asset");
      }

      const response = await (this.client as any).analyze({
        videoId,
        prompt: options.prompt,
      });

      return {
        data: response?.data ?? response?.text ?? String(response),
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

    // Query each relevant chunk
    const results: string[] = [];
    const sourceChunks: number[] = [];

    for (const chunk of chunksToQuery) {
      if (!chunk.videoId) {
        console.warn(`Chunk ${chunk.chunkIndex} has no videoId, skipping`);
        continue;
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

        const response = await (this.client as any).analyze({
          videoId: chunk.videoId,
          prompt: chunkPrompt,
        });

        const responseText = response?.data ?? response?.text ?? String(response);
        
        // Add chunk context to result
        results.push(
          `[Chunk ${chunk.chunkIndex} (${chunk.startOffset}s-${chunk.endOffset}s)]: ${responseText}`
        );
        sourceChunks.push(chunk.chunkIndex);
      } catch (err) {
        console.error(`Failed to analyze chunk ${chunk.chunkIndex}:`, err);
      }
    }

    if (results.length === 0) {
      throw new Error("Failed to analyze any chunks");
    }

    return {
      data: results.join("\n\n"),
      sourceChunks,
    };
  }

  /**
   * Get video gist (title, topics, hashtags)
   * For chunked videos, aggregates from all chunks
   */
  async gist(assetId: string, options: GistOptions): Promise<GistResult> {
    const asset = await this.getAssetInfo(assetId);

    if (!asset.isChunked) {
      const videoId = options.videoId || asset.twelveLabsVideoId;
      if (!videoId) {
        throw new Error("No videoId available for asset");
      }

      const response = await (this.client as any).gist({
        videoId,
        types: options.types,
      });

      return {
        title: response?.title,
        topics: response?.topics,
        hashtags: response?.hashtags,
      };
    }

    // For chunked videos, get gist from first chunk (usually contains intro/context)
    // and aggregate topics/hashtags from all chunks
    const chunks = asset.chunks || [];
    const firstChunk = chunks.find((c) => c.chunkIndex === 0);

    if (!firstChunk?.videoId) {
      throw new Error("First chunk has no videoId");
    }

    let title: string | undefined;
    const allTopics: Set<string> = new Set();
    const allHashtags: Set<string> = new Set();

    for (const chunk of chunks) {
      if (!chunk.videoId) continue;

      try {
        const response = await (this.client as any).gist({
          videoId: chunk.videoId,
          types: options.types,
        });

        // Use title from first chunk only
        if (chunk.chunkIndex === 0 && response?.title) {
          title = response.title;
        }

        // Aggregate topics and hashtags from all chunks
        if (response?.topics) {
          response.topics.forEach((t: string) => allTopics.add(t));
        }
        if (response?.hashtags) {
          response.hashtags.forEach((h: string) => allHashtags.add(h));
        }
      } catch (err) {
        console.error(`Failed to get gist for chunk ${chunk.chunkIndex}:`, err);
      }
    }

    return {
      title,
      topics: Array.from(allTopics),
      hashtags: Array.from(allHashtags),
    };
  }

  /**
   * Get video transcription with timestamps adjusted to original video timeline
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

    // For chunked videos, fetch and merge transcriptions from all chunks
    const chunks = asset.chunks || [];
    const allSegments: TranscriptionSegment[] = [];

    for (const chunk of chunks) {
      if (!chunk.videoId) continue;

      try {
        const chunkTranscription = await this.fetchTranscription(chunk.videoId);

        // Adjust timestamps to original video timeline
        for (const segment of chunkTranscription) {
          allSegments.push({
            start: this.toOriginalTimestamp(chunk, segment.start),
            end: this.toOriginalTimestamp(chunk, segment.end),
            text: segment.text,
          });
        }
      } catch (err) {
        console.error(
          `Failed to get transcription for chunk ${chunk.chunkIndex}:`,
          err
        );
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
   */
  private async fetchTranscription(
    videoId: string
  ): Promise<TranscriptionSegment[]> {
    try {
      const video = await this.client.indexes.videos.retrieve(
        this.indexId,
        videoId
      );

      // The transcription might be in different places depending on API version
      const anyVideo = video as any;
      const transcription =
        anyVideo.transcription || anyVideo.transcript || [];

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
  const table = assetsTable || process.env.ASSETS_TABLE || process.env.TABLE_NAME;
  const index = indexId || process.env.TWELVE_LABS_INDEX_ID;

  if (!table) {
    throw new Error("Assets table name not provided");
  }
  if (!index) {
    throw new Error("12Labs index ID not provided");
  }

  return new TwelveLabsWrapper(apiKey, table, index);
}

