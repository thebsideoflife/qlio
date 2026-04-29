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
// Video Metadata (Simple - replaces VideoUnderstanding)
// ============================================================================

/**
 * Simple video metadata - just what we need for prompts.
 * Replaces the bloated VideoUnderstanding type.
 */
export interface VideoMetadata {
  assetId: string;
  duration: number; // seconds
  title: string;
}

// ============================================================================
// Transcript Types
// ============================================================================

export interface TranscriptSegment {
  startTime: number;
  endTime: number;
  speaker?: string;
  text: string;
}

/**
 * Scene with grouped dialogue - combines visual scene info with audio transcript.
 * This structure helps Claude see what's happening visually AND audibly together.
 */
export interface SceneWithDialogue {
  sceneIndex: number;
  startTime: number; // When scene starts
  endTime: number; // When scene ends (next scene starts or video ends)
  // Visual info from SceneBreak
  who: string;
  action: string;
  mood: string;
  audio: string;
  // ALL dialogue in this scene (no truncation)
  dialogue: TranscriptSegment[];
  // Summary stats
  wordCount: number;
}

// ============================================================================
// Purpose & Goal Types
// ============================================================================

/**
 * Content generation purposes.
 * Each maps to a specific prompt template and output format.
 */
export enum Purpose {
  /** Full video split into chapters (target 90s, max 3 min) */
  FULL_VIDEO = "full_video",
  /** Compact video - condense to target percentage (target 90s, max 3 min) */
  COMPACT_VIDEO = "compact_video",
  /** Legacy: kept for backwards compatibility, treated as compact_video */
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

/**
 * Derive constraint rules from a Purpose.
 * Single source of truth — used by enforcer, tool builder, and tool-generation.
 */
export function getPurposeConstraints(purpose: Purpose): {
  needsSegmentDuration: boolean;
  needsTotalDuration: boolean;
} {
  const needsSegmentDuration =
    purpose === Purpose.FULL_VIDEO ||
    purpose === Purpose.COMPACT_VIDEO ||
    purpose === Purpose.HIGHLIGHTS;
  const needsTotalDuration =
    purpose !== Purpose.FULL_VIDEO &&
    (purpose === Purpose.COMPACT_VIDEO || purpose === Purpose.HIGHLIGHTS);
  return { needsSegmentDuration, needsTotalDuration };
}

export interface StoryIQGoals {
  purpose: Purpose;
  targetDuration?: number; // Calculated target duration in seconds
  targetPercent?: number; // For compact_video: percentage of original (25, 50, 75, etc.)
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
 * Tool interface for StoryIQ agent.
 * Provides access to transcript and verification utilities.
 */
export interface StoryIQTools {
  // Primary data source
  read_full_transcript(): Promise<TranscriptSegment[]>;

  // Verification tools (Phase 4)
  read_transcript_for_segments(
    segments: TimeRange[],
  ): Promise<SegmentContent[]>;
  check_segment_coverage(
    segments: TimeRange[],
    purpose: Purpose,
    videoDuration: number,
  ): Promise<CoverageReport>;
}

// ============================================================================
// Agent State Types
// ============================================================================

export interface StoryIQInput {
  assetId: string;
  goals: StoryIQGoals;
  // Optional: S3 URI for cached transcript (faster than re-fetching from 12Labs)
  transcriptS3Uri?: string;
  // Optional: video duration in seconds (from frontend or asset record)
  videoDuration?: number;
  // Optional: video title (for prompts)
  title?: string;
}

export interface StoryIQOutput {
  segments: FinalSegments;
  metadata: {
    purpose: Purpose;
    targetDuration?: number;
    actualDuration: number;
    processingTime: number;
    attempts: number;
  };
}

// ============================================================================
// Custom Errors
// ============================================================================

/**
 * Thrown when scene detection is in progress or just started.
 * Handler should catch this and return 202 to frontend.
 */
export class SceneDetectionPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SceneDetectionPendingError";
  }
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
        200,
      )}`,
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
    try {
      return JSON.parse(objectMatch[0]);
    } catch (error) {
      // Log the problematic JSON for debugging
      const errorPos =
        error instanceof SyntaxError
          ? parseInt(error.message.match(/position (\d+)/)?.[1] || "0")
          : 0;
      const context = objectMatch[0].substring(
        Math.max(0, errorPos - 100),
        Math.min(objectMatch[0].length, errorPos + 100),
      );
      console.error(
        `[parseJSONFromLLM] JSON parse error near position ${errorPos}:`,
      );
      console.error(`[parseJSONFromLLM] Context: ...${context}...`);
      throw error;
    }
  }

  // Try to extract JSON array
  const arrayMatch = content.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0]);
    } catch (error) {
      const errorPos =
        error instanceof SyntaxError
          ? parseInt(error.message.match(/position (\d+)/)?.[1] || "0")
          : 0;
      const context = arrayMatch[0].substring(
        Math.max(0, errorPos - 100),
        Math.min(arrayMatch[0].length, errorPos + 100),
      );
      console.error(
        `[parseJSONFromLLM] JSON parse error near position ${errorPos}:`,
      );
      console.error(`[parseJSONFromLLM] Context: ...${context}...`);
      throw error;
    }
  }

  // Try parsing as-is
  return JSON.parse(content);
}
