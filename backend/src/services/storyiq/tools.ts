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
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  TwelveLabsWrapper,
  type ChapterSegment,
  type HighlightSegment,
  type SceneDetectionResult,
  type SceneDetail,
} from "../twelvelabs";
import {
  type SceneBreakdown,
  type TranscriptSegment,
  type CharacterInfo,
  type EmotionalBeat,
  type VisualNote,
  type SegmentContent,
  type CoverageReport,
  type TimeRange,
  Purpose,
  type StoryIQTools,
} from "./types";
// callClaude import removed - no longer needed after removing analyze API

const s3Client = new S3Client({});

// S3 bucket for caching (same as assets bucket)
const CACHE_BUCKET =
  process.env.BUCKET_NAME || process.env.ASSETS_BUCKET || process.env.S3_BUCKET;

/**
 * Format seconds as "M:SS" for display
 */
function formatTimeForDisplay(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

// NOTE: analyze API prompts removed - they were causing timeouts on long videos.
// Now we only use 12Labs summarize API (chapters/highlights) which returns structured data directly.

// ============================================================================
// Helper Functions for Parsing 12Labs Summarize Output
// ============================================================================

/**
 * Extract location from chapter title/summary
 */
function extractLocation(title: string, summary: string): string {
  // Try to find location-like phrases
  const combined = `${title} ${summary}`;

  // Common location patterns
  const locationPatterns = [
    /(?:at|in|inside|outside|near|by|on)\s+(?:the\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/,
    /(?:^|\.\s+)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:scene|setting|location)/i,
  ];

  for (const pattern of locationPatterns) {
    const match = combined.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  // Fallback: use first capitalized phrase from title
  const titleWords = title.split(/\s+/);
  return titleWords[0] || "Unknown";
}

/**
 * Extract character names from text
 */
function extractCharacters(text: string): string[] {
  const characters: string[] = [];

  // Look for capitalized names (simple heuristic)
  const namePattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g;
  let match;

  while ((match = namePattern.exec(text)) !== null) {
    const name = match[1];
    // Filter out common non-name words
    const nonNames = [
      "The",
      "This",
      "That",
      "When",
      "What",
      "Where",
      "How",
      "Why",
      "And",
      "But",
      "Then",
    ];
    if (!nonNames.includes(name) && !characters.includes(name)) {
      characters.push(name);
    }
  }

  return characters.slice(0, 5); // Limit to 5 characters
}

/**
 * Extract key actions from summary text
 */
function extractKeyActions(summary: string): string[] {
  // Split into sentences and take first 3 as key actions
  const sentences = summary.split(/[.!?]+/).filter((s) => s.trim().length > 10);
  return sentences.slice(0, 3).map((s) => s.trim());
}

/**
 * Detect primary emotion from highlight text
 */
function detectEmotion(highlight: string, summary: string): string {
  const combined = (highlight + " " + summary).toLowerCase();

  const emotionKeywords: Record<string, string[]> = {
    tension: [
      "tension",
      "suspense",
      "tense",
      "nervous",
      "anxious",
      "confrontation",
    ],
    excitement: [
      "exciting",
      "thrill",
      "action",
      "chase",
      "fight",
      "battle",
      "victory",
    ],
    sadness: [
      "sad",
      "tragic",
      "loss",
      "death",
      "cry",
      "tear",
      "grief",
      "mourn",
    ],
    joy: ["happy", "joy", "celebrate", "laugh", "love", "reunion", "smile"],
    fear: ["fear", "scary", "horror", "terrif", "frighten", "panic"],
    surprise: [
      "surprise",
      "shock",
      "unexpected",
      "reveal",
      "twist",
      "discover",
    ],
    anger: ["angry", "rage", "fury", "fight", "conflict", "argument"],
  };

  for (const [emotion, keywords] of Object.entries(emotionKeywords)) {
    if (keywords.some((kw) => combined.includes(kw))) {
      return emotion;
    }
  }

  return "dramatic"; // Default emotion
}

// ============================================================================
// S3 Cache Helpers
// ============================================================================

// Cache TTL: 7 days in milliseconds
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CacheWrapper<T> {
  data: T;
  cachedAt: string;
}

/**
 * Get cache key for a tool result
 */
function getCacheKey(assetId: string, toolName: string): string {
  return `storyiq-cache/${assetId}/${toolName}.json`;
}

/**
 * Try to fetch cached result from S3.
 * Validates:
 * - TTL (7 days)
 * - Scene timestamps don't exceed video duration (if provided)
 */
async function getFromCache<T>(
  assetId: string,
  toolName: string,
  videoDuration?: number
): Promise<T | null> {
  if (!CACHE_BUCKET) return null;

  try {
    const key = getCacheKey(assetId, toolName);
    const command = new GetObjectCommand({ Bucket: CACHE_BUCKET, Key: key });
    const response = await s3Client.send(command);
    const bodyString = await response.Body?.transformToString();

    if (!bodyString) return null;

    const parsed = JSON.parse(bodyString);

    // Check if this is the new wrapper format with TTL
    if (parsed.cachedAt && parsed.data) {
      const wrapper = parsed as CacheWrapper<T>;
      const cacheAge = Date.now() - new Date(wrapper.cachedAt).getTime();

      // TTL check
      if (cacheAge > CACHE_TTL_MS) {
        console.log(
          `[StoryIQ Tools] Cache expired for ${toolName} (age: ${Math.round(
            cacheAge / 1000 / 60 / 60
          )}h)`
        );
        return null;
      }

      // Validate scene timestamps if this is scene data and we have duration
      if (
        toolName === "scenes" &&
        videoDuration &&
        Array.isArray(wrapper.data)
      ) {
        const scenes = wrapper.data as any[];
        const maxEndTime = Math.max(...scenes.map((s) => s.endTime || 0));

        // If max timestamp exceeds duration by more than 50%, cache is bad
        if (maxEndTime > videoDuration * 1.5) {
          console.warn(
            `[StoryIQ Tools] Invalidating bad scene cache: maxEndTime ${maxEndTime}s > duration ${videoDuration}s`
          );
          return null;
        }
      }

      console.log(`[StoryIQ Tools] Cache hit for ${toolName}`);
      return wrapper.data;
    }

    // Legacy format (no wrapper) - return as-is but log warning
    console.log(`[StoryIQ Tools] Cache hit for ${toolName} (legacy format)`);
    return parsed as T;
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
 * Save result to S3 cache with timestamp for TTL
 */
async function saveToCache<T>(
  assetId: string,
  toolName: string,
  data: T
): Promise<void> {
  if (!CACHE_BUCKET) return;

  try {
    const key = getCacheKey(assetId, toolName);
    const wrapper: CacheWrapper<T> = {
      data,
      cachedAt: new Date().toISOString(),
    };
    const command = new PutObjectCommand({
      Bucket: CACHE_BUCKET,
      Key: key,
      Body: JSON.stringify(wrapper),
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
  /** Video duration in seconds (for cache validation) */
  videoDuration?: number;
}

/**
 * Creates the StoryIQ tools bound to a specific asset.
 * All chunk handling is transparent through TwelveLabsWrapper.
 *
 * @param transcriptS3Uri - If provided, transcript is fetched from S3 (faster).
 *                          Otherwise falls back to 12Labs API.
 * @param videoDuration - If provided, used to validate cached scene timestamps.
 */
export function createStoryIQTools(
  twelvelabs: TwelveLabsWrapper,
  assetId: string,
  options: CreateToolsOptions = {}
): StoryIQTools {
  // In-memory cache for transcript (also cached in S3)
  let cachedTranscript: TranscriptSegment[] | null = null;

  // In-memory cache for scene detection (also cached in S3 by twelvelabs)
  let cachedSceneDetection: SceneDetectionResult | null = null;

  return {
    /**
     * Get detailed scene-by-scene breakdown of the video.
     *
     * OPTIMIZED: Uses 12Labs summarize API with type="chapter" which returns
     * timestamped chapters directly, reducing LLM calls and improving accuracy.
     *
     * Results are cached in S3 for subsequent calls.
     */
    async read_scene_breakdown(): Promise<SceneBreakdown[]> {
      // Check S3 cache first (with duration validation)
      const cached = await getFromCache<SceneBreakdown[]>(
        assetId,
        "scenes",
        options.videoDuration
      );
      if (cached) return cached;

      console.log(
        "[StoryIQ Tools] Reading scene breakdown via chapters API..."
      );

      try {
        // Use 12Labs summarize API with chapters - returns timestamped data directly!
        const chaptersResult = await twelvelabs.summarize(assetId, {
          type: "chapter",
          prompt:
            "Provide detailed chapter breakdowns including location and key actions.",
        });

        if (chaptersResult.chapters && chaptersResult.chapters.length > 0) {
          // Convert chapters to SceneBreakdown format
          const scenes: SceneBreakdown[] = chaptersResult.chapters.map(
            (ch: ChapterSegment) => ({
              sceneNumber: ch.chapterNumber,
              startTime: ch.start,
              endTime: ch.end,
              location: extractLocation(ch.chapterTitle, ch.chapterSummary),
              characters: extractCharacters(ch.chapterSummary),
              description: ch.chapterSummary,
              keyActions: extractKeyActions(ch.chapterSummary),
              dialogue: "",
            })
          );

          console.log(
            `[StoryIQ Tools] Found ${scenes.length} scenes via chapters API`
          );
          await saveToCache(assetId, "scenes", scenes);
          return scenes;
        }
      } catch (err) {
        console.warn("[StoryIQ Tools] Chapters API failed:", err);
        // Don't fallback to analyze - it times out on long videos
        return [];
      }

      return []; // No chapters found
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
     * Get character analysis.
     * DISABLED: 12Labs analyze API is unreliable/slow for long videos.
     * Characters are extracted from scene descriptions instead.
     */
    async read_character_analysis(): Promise<CharacterInfo[]> {
      // Check S3 cache first
      const cached = await getFromCache<CharacterInfo[]>(assetId, "characters");
      if (cached) return cached;

      // Don't call analyze API - it times out on long videos
      // Characters will be extracted from scene descriptions by LLM
      console.log("[StoryIQ Tools] Skipping character analysis (disabled)");
      return [];
    },

    /**
     * Get emotional beats via 12Labs highlights API only.
     * analyze API is disabled due to timeouts on long videos.
     */
    async read_emotional_beats(): Promise<EmotionalBeat[]> {
      const cached = await getFromCache<EmotionalBeat[]>(assetId, "emotions");
      if (cached) return cached;

      console.log(
        "[StoryIQ Tools] Reading emotional beats via highlights API..."
      );

      try {
        const result = await twelvelabs.summarize(assetId, {
          type: "highlight",
          prompt:
            "Identify the most emotionally impactful and dramatic moments.",
        });

        const emotionalBeats: EmotionalBeat[] = (result?.highlights || []).map(
          (h: HighlightSegment) => ({
            startTime: h.start,
            endTime: h.end,
            intensity: "peak" as const,
            emotion: detectEmotion(h.highlight, h.highlightSummary || ""),
            description:
              h.highlight +
              (h.highlightSummary ? `: ${h.highlightSummary}` : ""),
          })
        );

        emotionalBeats.sort((a, b) => a.startTime - b.startTime);
        console.log(
          `[StoryIQ Tools] Found ${emotionalBeats.length} emotional beats`
        );

        await saveToCache(assetId, "emotions", emotionalBeats);
        return emotionalBeats;
      } catch (err) {
        console.warn("[StoryIQ Tools] Highlights API failed:", err);
        return [];
      }
    },

    /**
     * Get visual style and pacing notes.
     * Results are cached in S3 for subsequent calls.
     */
    /**
     * Get visual style and pacing notes.
     * DISABLED: 12Labs analyze API is unreliable/slow for long videos.
     */
    async read_visual_style_notes(): Promise<VisualNote[]> {
      // Check S3 cache first
      const cached = await getFromCache<VisualNote[]>(assetId, "visuals");
      if (cached) return cached;

      // Don't call analyze API - it times out on long videos
      console.log("[StoryIQ Tools] Skipping visual style analysis (disabled)");
      return [];
    },

    /**
     * Get detailed scene information for a specific time range.
     * Claude can call this when it needs more context to make cut decisions.
     *
     * Returns formatted text with location, characters, description, and visual notes
     * for all scenes within the specified time range.
     */
    async get_scene_details(
      startTime: number,
      endTime: number
    ): Promise<string> {
      console.log(
        `[StoryIQ Tools] Getting scene details for ${startTime}s - ${endTime}s`
      );

      // Ensure scene detection has run (lazy load)
      if (!cachedSceneDetection) {
        try {
          cachedSceneDetection = await twelvelabs.detectScenes(assetId);
        } catch (err) {
          console.warn("[StoryIQ Tools] Scene detection failed:", err);
          return "Scene details not available.";
        }
      }

      // Filter scenes to the requested time range
      const scenes = cachedSceneDetection.detailed.filter(
        (s) => s.time >= startTime && s.time <= endTime
      );

      if (scenes.length === 0) {
        return `No scenes found between ${formatTimeForDisplay(
          startTime
        )} and ${formatTimeForDisplay(endTime)}.`;
      }

      // Format scenes as readable text
      const formatted = scenes.map((s) => {
        const lines = [
          `SCENE at ${formatTimeForDisplay(s.time)}:`,
          `  Location: ${s.location || "Unknown"}`,
          `  Characters: ${
            s.characters.length > 0 ? s.characters.join(", ") : "None visible"
          }`,
          `  Description: ${s.description}`,
        ];
        if (s.visualNotes) {
          lines.push(`  Visual: ${s.visualNotes}`);
        }
        return lines.join("\n");
      });

      return formatted.join("\n\n");
    },

    /**
     * Get detailed content for specific segments (for verification).
     * Uses ONLY cached data to avoid slow 12Labs API calls during verification.
     * Scene descriptions are derived from cached scene breakdown, not re-queried.
     */
    async read_transcript_for_segments(
      segments: TimeRange[]
    ): Promise<SegmentContent[]> {
      console.log(
        `[StoryIQ Tools] Reading content for ${segments.length} segments...`
      );

      // Use cached transcript (will fetch if not cached)
      const fullTranscript = await this.read_full_transcript();

      // Use cached scene breakdown for descriptions (no new 12Labs calls!)
      const cachedScenes = await getFromCache<SceneBreakdown[]>(
        assetId,
        "scenes",
        options.videoDuration
      );

      // Build segment content using only cached data
      const results: SegmentContent[] = segments.map((seg) => {
        // Filter transcript to this segment
        const segmentTranscript = fullTranscript
          .filter((t) => t.startTime >= seg.start && t.endTime <= seg.end)
          .map((t) => t.text)
          .join(" ");

        // Get scene descriptions that overlap with this segment (from cache)
        const overlappingScenes = (cachedScenes || []).filter(
          (scene) => scene.startTime < seg.end && scene.endTime > seg.start
        );
        const sceneDescriptions = overlappingScenes.map((s) => s.description);

        return {
          startTime: seg.start,
          endTime: seg.end,
          transcript: segmentTranscript,
          sceneDescriptions:
            sceneDescriptions.length > 0
              ? sceneDescriptions
              : ["No cached scene data available"],
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
