/**
 * StoryIQ Type Definitions
 *
 * Core interfaces for the StoryIQ agent system.
 * These types define the contract between tools, prompts, and the agent.
 */

// ============================================================================
// Model Configuration (single source of truth)
// ============================================================================

/** Claude Sonnet 4.5 - for complex reasoning tasks (planning, review, synthesis) */
export const MODEL_SONNET = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

/** Claude Haiku 4.5 - for fast/cheap tasks (JSON cleaning, extraction) */
export const MODEL_HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

// ============================================================================
// Video Understanding Types (Output of Phase 1 & 2)
// ============================================================================

export interface SceneBreakdown {
  sceneNumber: number;
  startTime: number;
  endTime: number;
  location: string;
  characters: string[];
  description: string;
  keyActions: string[];
  dialogue?: string; // Notable dialogue if any
}

export interface CharacterInfo {
  name: string;
  description: string;
  firstAppearance: number; // timestamp
  keyMoments: Array<{
    timestamp: number;
    description: string;
  }>;
  relationships?: string[];
}

export interface EmotionalBeat {
  startTime: number;
  endTime: number;
  intensity: "low" | "medium" | "high" | "peak";
  emotion: string; // e.g., "tension", "joy", "sadness", "excitement"
  description: string;
}

export interface VisualNote {
  startTime: number;
  endTime: number;
  style: string; // e.g., "close-up", "wide shot", "montage"
  pacing: "slow" | "medium" | "fast";
  notes: string;
}

export interface TranscriptSegment {
  startTime: number;
  endTime: number;
  speaker?: string;
  text: string;
}

/**
 * Unified understanding of the video content.
 * Built from multiple 12Labs queries and synthesized by LLM.
 */
export interface VideoUnderstanding {
  // Metadata
  assetId: string;
  duration: number;
  title: string;

  // High-level understanding
  logline: string; // One sentence summary
  themes: string[];
  tone: string;
  genre?: string;

  // Detailed breakdowns
  scenes: SceneBreakdown[];
  characters: CharacterInfo[];
  emotionalArc: EmotionalBeat[];
  visualNotes: VisualNote[];
  transcript: TranscriptSegment[];

  // Quick lookups (built during synthesis)
  peakMoments: Array<{ timestamp: number; reason: string }>;
}

// ============================================================================
// Purpose & Goal Types
// ============================================================================

/**
 * Content generation purposes.
 * Each maps to a specific prompt template and output format.
 */
export enum Purpose {
  /** Full video split into microdrama chapters (5-10 min each) */
  FULL_VIDEO = "full_video",
  /** Condensed highlights reel */
  HIGHLIGHTS = "highlights",
  /** Movie-style trailer (2-2.5 min) */
  TRAILER = "trailer",
  /** Short tune-in promotional spot (15-30s) */
  TUNEIN = "tunein",
  /** Recap & tease bridge content */
  BRIDGE = "bridge",
  /** "Previously on..." episode recap */
  EPISODE_RECAP = "episode_recap",
  /** Full season recap */
  SEASON_RECAP = "season_recap",
  /** Social media optimized clip */
  SOCIAL_SEGMENT = "social_segment",
}

export type ContentType = "tv" | "movie" | "ugc";

export type Platform =
  | "mobile"
  | "tv"
  | "auto"
  | "tiktok"
  | "ig"
  | "shorts"
  | "facebook"
  | "youtube";

export interface StoryIQGoals {
  purpose: Purpose;
  contentType: ContentType;
  platform: Platform;
  targetDuration?: number; // Advisory, in seconds
  userInstructions?: string; // Custom instructions from user
}

// ============================================================================
// Segment Types (Agent Output)
// ============================================================================

export interface ProposedSegment {
  startTime: number;
  endTime: number;
  title: string;
  reasoning: string;
  expectedContent: string;
  // For structured formats (trailer, bridge, etc.)
  section?: string;
}

export interface SegmentContent {
  startTime: number;
  endTime: number;
  transcript: string;
  sceneDescriptions: string[];
}

export interface CoverageReport {
  totalDuration: number;
  targetDuration?: number;
  gaps?: Array<{ start: number; end: number }>; // For full_video mode
  emotionalCoverage: {
    peaksCovered: number;
    peaksTotal: number;
  };
  issues: string[];
  isValid: boolean;
}

// ============================================================================
// Verification Types
// ============================================================================

export interface ReviewResult {
  needsRevision: boolean;
  confidence: number; // 0-1
  issues: string[];
  suggestions: string[];
}

export interface FinalSegments {
  segments: ProposedSegment[];
  confidence: number;
  notes: string[];
  attempts: number;
}

// ============================================================================
// Tool Interfaces
// ============================================================================

export interface TimeRange {
  start: number;
  end: number;
}

/**
 * Human-readable tool interface for StoryIQ agent.
 * These abstract away 12Labs complexity and chunk handling.
 */
export interface StoryIQTools {
  // Deep understanding tools (Phase 1)
  read_scene_breakdown(): Promise<SceneBreakdown[]>;
  read_full_transcript(): Promise<TranscriptSegment[]>;
  read_character_analysis(): Promise<CharacterInfo[]>;
  read_emotional_beats(): Promise<EmotionalBeat[]>;
  read_visual_style_notes(): Promise<VisualNote[]>;

  // Verification tools (Phase 4)
  read_transcript_for_segments(
    segments: TimeRange[]
  ): Promise<SegmentContent[]>;
  check_segment_coverage(
    segments: TimeRange[],
    purpose: Purpose,
    videoDuration: number,
    emotionalBeats?: EmotionalBeat[]
  ): Promise<CoverageReport>;
}

// ============================================================================
// Agent State Types
// ============================================================================

export interface StoryIQInput {
  assetId: string;
  goals: StoryIQGoals;
  // Optional: pre-computed understanding (for retries)
  videoUnderstanding?: VideoUnderstanding;
  // Optional: S3 URI for cached transcript (faster than re-fetching from 12Labs)
  transcriptS3Uri?: string;
  // Optional: video duration in seconds (from frontend or asset record)
  videoDuration?: number;
}

export interface StoryIQOutput {
  segments: FinalSegments;
  videoUnderstanding: VideoUnderstanding;
  metadata: {
    purpose: Purpose;
    targetDuration?: number;
    actualDuration: number;
    processingTime: number;
    attempts: number;
  };
}

// ============================================================================
// Utility: Safe LLM Response Extraction
// ============================================================================

/**
 * Safely extract text content from Bedrock LLM response.
 * Throws descriptive error if response is malformed.
 */
export function extractLLMContent(responseBody: any): string {
  if (!responseBody?.content?.[0]?.text) {
    throw new Error(
      `Invalid LLM response structure: ${JSON.stringify(responseBody).substring(
        0,
        200
      )}`
    );
  }
  return responseBody.content[0].text;
}

/**
 * Parse JSON from LLM response, handling common extraction patterns.
 * Tries to find JSON object or array in the response text.
 */
export function parseJSONFromLLM<T>(content: string): T {
  // Try to extract JSON object
  const objectMatch = content.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    return JSON.parse(objectMatch[0]);
  }

  // Try to extract JSON array
  const arrayMatch = content.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    return JSON.parse(arrayMatch[0]);
  }

  // Try parsing as-is
  return JSON.parse(content);
}
