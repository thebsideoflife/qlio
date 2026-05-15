/**
 * StoryIQ Tools
 *
 * Provides transcript access and segment verification for StoryIQ.
 * - Fetches transcripts from S3 (fast) or 12Labs API (fallback)
 * - Checks segment coverage requirements for different content purposes
 */

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { TwelveLabsWrapper } from "../twelvelabs";
import {
  type TranscriptSegment,
  type SegmentContent,
  type CoverageReport,
  type TimeRange,
  Purpose,
  type StoryIQTools,
} from "./types";

const s3Client = new S3Client({});

// ============================================================================
// S3 Transcript Fetching
// ============================================================================

/**
 * Parse S3 URI and fetch JSON content.
 */
async function fetchTranscriptFromS3(
  s3Uri: string
): Promise<TranscriptSegment[]> {
  if (!s3Uri || !s3Uri.startsWith("s3://")) {
    throw new Error(`Invalid S3 URI: ${s3Uri}`);
  }

  const parts = s3Uri.replace("s3://", "").split("/");
  const bucket = parts[0];
  const key = parts.slice(1).join("/");

  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await s3Client.send(command);

  const bodyString = await response.Body?.transformToString();
  if (!bodyString) {
    throw new Error("Empty response from S3");
  }

  const data = JSON.parse(bodyString);

  // Transform to our format (S3 format may differ slightly)
  return data.map((seg: any) => ({
    startTime: seg.start ?? seg.startTime ?? 0,
    endTime: seg.end ?? seg.endTime ?? 0,
    text: seg.text ?? seg.value ?? "",
    speaker: seg.speaker,
  }));
}

// ============================================================================
// Tool Factory
// ============================================================================

export interface CreateToolsOptions {
  /** S3 URI for cached transcript (from asset.transcriptionUrl) */
  transcriptS3Uri?: string;
}

/**
 * Creates the StoryIQ tools bound to a specific asset.
 *
 * @param transcriptS3Uri - If provided, transcript is fetched from S3 (faster).
 *                          Otherwise falls back to 12Labs API.
 */
export function createStoryIQTools(
  twelvelabs: TwelveLabsWrapper,
  assetId: string,
  options: CreateToolsOptions = {}
): StoryIQTools {
  // In-memory cache for transcript
  let cachedTranscript: TranscriptSegment[] | null = null;

  return {
    /**
     * Get full transcript with timestamps and speaker labels.
     * Fetches from S3 if available (cached from indexing), otherwise from 12Labs.
     */
    async read_full_transcript(): Promise<TranscriptSegment[]> {
      // Return in-memory cached if available
      if (cachedTranscript) {
        console.log("[StoryIQ Tools] Returning cached transcript");
        return cachedTranscript;
      }

      console.log("[StoryIQ Tools] Reading full transcript...");

      // Try S3 first (faster, already processed during indexing)
      if (options.transcriptS3Uri) {
        try {
          console.log("[StoryIQ Tools] Fetching transcript from S3...");
          cachedTranscript = await fetchTranscriptFromS3(
            options.transcriptS3Uri
          );
          console.log(
            `[StoryIQ Tools] Got ${cachedTranscript.length} transcript segments from S3`
          );
          return cachedTranscript;
        } catch (err) {
          console.warn(
            "[StoryIQ Tools] S3 transcript fetch failed, falling back to 12Labs:",
            err
          );
        }
      }

      // Fallback to 12Labs API
      const transcript = await twelvelabs.getTranscription(assetId);
      cachedTranscript = transcript.map((seg) => ({
        startTime: seg.start,
        endTime: seg.end,
        text: seg.text,
      }));

      console.log(
        `[StoryIQ Tools] Got ${cachedTranscript.length} transcript segments from 12Labs`
      );
      return cachedTranscript;
    },

    /**
     * Get transcript content for specific segments (for verification).
     * Returns the transcript text within each segment's time range.
     */
    async read_transcript_for_segments(
      segments: TimeRange[]
    ): Promise<SegmentContent[]> {
      console.log(
        `[StoryIQ Tools] Reading content for ${segments.length} segments...`
      );

      // Use cached transcript (will fetch if not cached)
      const fullTranscript = await this.read_full_transcript();

      // Build segment content from transcript
      const results: SegmentContent[] = segments.map((seg) => {
        // Filter transcript segments that OVERLAP with this segment
        // (not just those completely contained within it)
        const segmentTranscript = fullTranscript
          .filter((t) => t.startTime < seg.end && t.endTime > seg.start)
          .map((t) => t.text)
          .join(" ");

        return {
          startTime: seg.start,
          endTime: seg.end,
          transcript: segmentTranscript,
          sceneDescriptions: [],
        };
      });

      return results;
    },

    /**
     * Check if segments meet coverage requirements for the given purpose.
     */
    async check_segment_coverage(
      segments: TimeRange[],
      purpose: Purpose,
      videoDuration: number
    ): Promise<CoverageReport> {
      console.log(`[StoryIQ Tools] Checking coverage for ${purpose}...`);

      const issues: string[] = [];

      // Calculate total duration of selected segments
      const totalDuration = segments.reduce(
        (sum, seg) => sum + (seg.end - seg.start),
        0
      );

      // For full_video mode: check for gaps (all content must be covered)
      let gaps: Array<{ start: number; end: number }> | undefined;
      if (purpose === Purpose.FULL_VIDEO) {
        gaps = [];
        const sorted = [...segments].sort((a, b) => a.start - b.start);

        // Check start
        if (sorted[0]?.start > 1) {
          gaps.push({ start: 0, end: sorted[0].start });
          issues.push(`Gap at start: 0s to ${sorted[0].start}s`);
        }

        // Check between segments
        for (let i = 1; i < sorted.length; i++) {
          const prevEnd = sorted[i - 1].end;
          const currStart = sorted[i].start;
          if (currStart - prevEnd > 1) {
            gaps.push({ start: prevEnd, end: currStart });
            issues.push(`Gap: ${prevEnd}s to ${currStart}s`);
          }
        }

        // Check end
        const lastEnd = sorted[sorted.length - 1]?.end || 0;
        if (videoDuration - lastEnd > 1) {
          gaps.push({ start: lastEnd, end: videoDuration });
          issues.push(`Gap at end: ${lastEnd}s to ${videoDuration}s`);
        }
      }

      return {
        totalDuration,
        gaps,
        issues,
        isValid: issues.length === 0,
      };
    },
  };
}
