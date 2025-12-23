/**
 * StoryIQ Tools
 *
 * Human-readable tool abstractions over 12Labs.
 * These tools:
 * 1. Hide chunked video complexity (handled by TwelveLabsWrapper)
 * 2. Clean raw 12Labs output through an LLM before returning
 * 3. Use descriptive names that make sense to the agent
 * 4. Fetch cached data (like transcripts) from S3 when available
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { TwelveLabsWrapper } from "../twelvelabs";
import {
  MODEL_HAIKU,
  extractLLMContent,
  type SceneBreakdown,
  type TranscriptSegment,
  type CharacterInfo,
  type EmotionalBeat,
  type VisualNote,
  type SegmentContent,
  type CoverageReport,
  type TimeRange,
  type Purpose,
  type StoryIQTools,
} from "./types";

const bedrock = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || "us-west-2",
});

const s3Client = new S3Client({});

// S3 bucket for caching (same as assets bucket)
const CACHE_BUCKET = process.env.ASSETS_BUCKET || process.env.S3_BUCKET;

// ============================================================================
// 12Labs Query Prompts (what we ask 12Labs)
// ============================================================================

const SCENE_BREAKDOWN_PROMPT = `Provide a detailed scene-by-scene breakdown of this video.

For each distinct scene, provide:
1. Scene number
2. Start time (in seconds)
3. End time (in seconds)
4. Location/setting
5. Characters present
6. What happens (2-3 sentences)
7. Key actions or events
8. Notable dialogue (if any)

Format as a numbered list. Be precise with timestamps.`;

const CHARACTER_ANALYSIS_PROMPT = `Identify all characters/people in this video.

For each character:
1. Name or description (e.g., "Main character", "Woman in red dress")
2. Physical description
3. First appearance timestamp (in seconds)
4. Key moments featuring them (with timestamps)
5. Relationships with other characters

Focus on characters with significant screen time.`;

const EMOTIONAL_BEATS_PROMPT = `Map the emotional intensity throughout this video.

Identify distinct emotional segments and for each provide:
1. Start time (in seconds)
2. End time (in seconds)
3. Emotional intensity: low, medium, high, or peak
4. Primary emotion (tension, joy, sadness, excitement, fear, anger, surprise, etc.)
5. Brief description of what creates this emotion

Pay special attention to:
- Peak emotional moments (mark as "peak")
- Dramatic shifts in tone
- Climactic scenes`;

const VISUAL_STYLE_PROMPT = `Analyze the visual style and pacing of this video.

For distinct visual sections, provide:
1. Start time (in seconds)
2. End time (in seconds)
3. Shot style (close-up, wide shot, montage, tracking, etc.)
4. Pacing (slow, medium, fast)
5. Notable cinematography or visual elements

Note any significant changes in visual approach.`;

// ============================================================================
// LLM Cleaning Prompts (how we structure 12Labs output)
// ============================================================================

const CLEAN_SCENES_PROMPT = `Parse this raw scene analysis into structured JSON.

Raw analysis:
{raw}

Output a JSON array of scenes. Each scene must have:
- sceneNumber: number
- startTime: number (seconds)
- endTime: number (seconds)
- location: string
- characters: string[]
- description: string
- keyActions: string[]
- dialogue: string (optional, empty string if none)

Fix any timestamp inconsistencies. Ensure scenes don't overlap.
Output ONLY valid JSON array, no explanation.`;

const CLEAN_CHARACTERS_PROMPT = `Parse this raw character analysis into structured JSON.

Raw analysis:
{raw}

Output a JSON array of characters. Each character must have:
- name: string
- description: string
- firstAppearance: number (timestamp in seconds)
- keyMoments: array of { timestamp: number, description: string }
- relationships: string[] (optional)

Output ONLY valid JSON array, no explanation.`;

const CLEAN_EMOTIONS_PROMPT = `Parse this raw emotional analysis into structured JSON.

Raw analysis:
{raw}

Output a JSON array of emotional beats. Each beat must have:
- startTime: number (seconds)
- endTime: number (seconds)
- intensity: "low" | "medium" | "high" | "peak"
- emotion: string
- description: string

Ensure beats cover the full video without gaps.
Output ONLY valid JSON array, no explanation.`;

const CLEAN_VISUALS_PROMPT = `Parse this raw visual analysis into structured JSON.

Raw analysis:
{raw}

Output a JSON array of visual notes. Each note must have:
- startTime: number (seconds)
- endTime: number (seconds)
- style: string
- pacing: "slow" | "medium" | "fast"
- notes: string

Output ONLY valid JSON array, no explanation.`;

// ============================================================================
// Helper: Call LLM to clean/structure data (uses Haiku for speed/cost)
// ============================================================================

async function cleanWithLLM<T>(
  rawData: string,
  cleaningPrompt: string
): Promise<T> {
  const prompt = cleaningPrompt.replace("{raw}", rawData);

  // Use Haiku for cleaning tasks - faster and cheaper for JSON extraction
  const command = new InvokeModelCommand({
    modelId: MODEL_HAIKU,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 4000,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  const response = await bedrock.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const content = extractLLMContent(responseBody);

  // Extract JSON array from response
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[0]);
  }

  // Try parsing as-is
  return JSON.parse(content);
}

// ============================================================================
// S3 Cache Helpers
// ============================================================================

/**
 * Get cache key for a tool result
 */
function getCacheKey(assetId: string, toolName: string): string {
  return `storyiq-cache/${assetId}/${toolName}.json`;
}

/**
 * Try to fetch cached result from S3
 */
async function getFromCache<T>(
  assetId: string,
  toolName: string
): Promise<T | null> {
  if (!CACHE_BUCKET) return null;

  try {
    const key = getCacheKey(assetId, toolName);
    const command = new GetObjectCommand({ Bucket: CACHE_BUCKET, Key: key });
    const response = await s3Client.send(command);
    const bodyString = await response.Body?.transformToString();
    if (bodyString) {
      console.log(`[StoryIQ Tools] Cache hit for ${toolName}`);
      return JSON.parse(bodyString);
    }
  } catch (err: any) {
    // NoSuchKey is expected for cache miss
    if (err.name !== "NoSuchKey") {
      console.warn(
        `[StoryIQ Tools] Cache read error for ${toolName}:`,
        err.message
      );
    }
  }
  return null;
}

/**
 * Save result to S3 cache
 */
async function saveToCache<T>(
  assetId: string,
  toolName: string,
  data: T
): Promise<void> {
  if (!CACHE_BUCKET) return;

  try {
    const key = getCacheKey(assetId, toolName);
    const command = new PutObjectCommand({
      Bucket: CACHE_BUCKET,
      Key: key,
      Body: JSON.stringify(data),
      ContentType: "application/json",
    });
    await s3Client.send(command);
    console.log(`[StoryIQ Tools] Cached ${toolName}`);
  } catch (err: any) {
    console.warn(
      `[StoryIQ Tools] Cache write error for ${toolName}:`,
      err.message
    );
  }
}

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
 * All chunk handling is transparent through TwelveLabsWrapper.
 *
 * @param transcriptS3Uri - If provided, transcript is fetched from S3 (faster).
 *                          Otherwise falls back to 12Labs API.
 */
export function createStoryIQTools(
  twelvelabs: TwelveLabsWrapper,
  assetId: string,
  options: CreateToolsOptions = {}
): StoryIQTools {
  // In-memory cache for transcript (also cached in S3)
  let cachedTranscript: TranscriptSegment[] | null = null;

  return {
    /**
     * Get detailed scene-by-scene breakdown of the video.
     * Results are cached in S3 for subsequent calls.
     */
    async read_scene_breakdown(): Promise<SceneBreakdown[]> {
      // Check S3 cache first
      const cached = await getFromCache<SceneBreakdown[]>(assetId, "scenes");
      if (cached) return cached;

      console.log("[StoryIQ Tools] Reading scene breakdown...");

      const raw = await twelvelabs.analyze(assetId, {
        prompt: SCENE_BREAKDOWN_PROMPT,
      });

      const cleaned = await cleanWithLLM<SceneBreakdown[]>(
        raw.data,
        CLEAN_SCENES_PROMPT
      );

      console.log(`[StoryIQ Tools] Found ${cleaned.length} scenes`);

      // Cache for next time
      await saveToCache(assetId, "scenes", cleaned);

      return cleaned;
    },

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
     * Get character analysis with appearances and relationships.
     * Results are cached in S3 for subsequent calls.
     */
    async read_character_analysis(): Promise<CharacterInfo[]> {
      // Check S3 cache first
      const cached = await getFromCache<CharacterInfo[]>(assetId, "characters");
      if (cached) return cached;

      console.log("[StoryIQ Tools] Reading character analysis...");

      const raw = await twelvelabs.analyze(assetId, {
        prompt: CHARACTER_ANALYSIS_PROMPT,
      });

      const cleaned = await cleanWithLLM<CharacterInfo[]>(
        raw.data,
        CLEAN_CHARACTERS_PROMPT
      );

      console.log(`[StoryIQ Tools] Found ${cleaned.length} characters`);

      // Cache for next time
      await saveToCache(assetId, "characters", cleaned);

      return cleaned;
    },

    /**
     * Get emotional intensity mapping across the video.
     * Results are cached in S3 for subsequent calls.
     */
    async read_emotional_beats(): Promise<EmotionalBeat[]> {
      // Check S3 cache first
      const cached = await getFromCache<EmotionalBeat[]>(assetId, "emotions");
      if (cached) return cached;

      console.log("[StoryIQ Tools] Reading emotional beats...");

      const raw = await twelvelabs.analyze(assetId, {
        prompt: EMOTIONAL_BEATS_PROMPT,
      });

      const cleaned = await cleanWithLLM<EmotionalBeat[]>(
        raw.data,
        CLEAN_EMOTIONS_PROMPT
      );

      console.log(`[StoryIQ Tools] Found ${cleaned.length} emotional beats`);

      // Cache for next time
      await saveToCache(assetId, "emotions", cleaned);

      return cleaned;
    },

    /**
     * Get visual style and pacing notes.
     * Results are cached in S3 for subsequent calls.
     */
    async read_visual_style_notes(): Promise<VisualNote[]> {
      // Check S3 cache first
      const cached = await getFromCache<VisualNote[]>(assetId, "visuals");
      if (cached) return cached;

      console.log("[StoryIQ Tools] Reading visual style notes...");

      const raw = await twelvelabs.analyze(assetId, {
        prompt: VISUAL_STYLE_PROMPT,
      });

      const cleaned = await cleanWithLLM<VisualNote[]>(
        raw.data,
        CLEAN_VISUALS_PROMPT
      );

      console.log(`[StoryIQ Tools] Found ${cleaned.length} visual notes`);

      // Cache for next time
      await saveToCache(assetId, "visuals", cleaned);

      return cleaned;
    },

    /**
     * Get detailed content for specific segments (for verification).
     * Uses cached transcript to avoid re-fetching.
     */
    async read_transcript_for_segments(
      segments: TimeRange[]
    ): Promise<SegmentContent[]> {
      console.log(
        `[StoryIQ Tools] Reading content for ${segments.length} segments...`
      );

      // Use cached transcript (will fetch if not cached)
      const fullTranscript = await this.read_full_transcript();

      // Get scene descriptions for context
      const scenePrompt = `For the time ranges provided, describe what happens visually.
Time ranges: ${segments.map((s) => `${s.start}s-${s.end}s`).join(", ")}

For each range, provide a brief description of the visual content.`;

      const sceneDescriptions = await twelvelabs.analyze(assetId, {
        prompt: scenePrompt,
      });

      // Build segment content
      const results: SegmentContent[] = segments.map((seg) => {
        // Filter transcript to this segment
        const segmentTranscript = fullTranscript
          .filter((t) => t.startTime >= seg.start && t.endTime <= seg.end)
          .map((t) => t.text)
          .join(" ");

        return {
          startTime: seg.start,
          endTime: seg.end,
          transcript: segmentTranscript,
          sceneDescriptions: [sceneDescriptions.data], // Simplified for now
        };
      });

      return results;
    },

    /**
     * Check if segments meet coverage requirements for the given purpose.
     * Note: emotionalBeats should be passed from VideoUnderstanding to avoid re-querying.
     */
    async check_segment_coverage(
      segments: TimeRange[],
      purpose: Purpose,
      videoDuration: number,
      emotionalBeats?: EmotionalBeat[]
    ): Promise<CoverageReport> {
      console.log(`[StoryIQ Tools] Checking coverage for ${purpose}...`);

      const issues: string[] = [];

      // Calculate total duration of selected segments
      const totalDuration = segments.reduce(
        (sum, seg) => sum + (seg.end - seg.start),
        0
      );

      // For binge mode: check for gaps
      let gaps: Array<{ start: number; end: number }> | undefined;
      if (purpose === "binge") {
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

      // Check emotional peak coverage (use provided beats to avoid re-querying)
      let peaksCovered = 0;
      let peaksTotal = 0;

      if (emotionalBeats && emotionalBeats.length > 0) {
        const peaks = emotionalBeats.filter((e) => e.intensity === "peak");
        peaksTotal = peaks.length;

        for (const peak of peaks) {
          const peakMid = (peak.startTime + peak.endTime) / 2;
          const covered = segments.some(
            (seg) => peakMid >= seg.start && peakMid <= seg.end
          );
          if (covered) peaksCovered++;
        }

        if (purpose === "highlights" && peaksCovered < peaksTotal) {
          issues.push(
            `Missing ${peaksTotal - peaksCovered} of ${peaksTotal} peak moments`
          );
        }
      }

      return {
        totalDuration,
        gaps,
        emotionalCoverage: {
          peaksCovered,
          peaksTotal,
        },
        issues,
        isValid: issues.length === 0,
      };
    },
  };
}
