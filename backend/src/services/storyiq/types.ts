/**
 * StoryIQ Type Definitions
 *
 * Core interfaces for the StoryIQ agent system.
 * These types define the contract between tools, prompts, and the agent.
 */

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

// ============================================================================
// Generation Options
// ============================================================================

export interface GenerationOptions {
  metadata: VideoMetadata;
  transcript: TranscriptSegment[];
  purpose: Purpose;
  targetDuration?: number;
  targetPercent?: number;
  userInstructions?: string;
  /** Gemini API key for fallback classification */
  geminiApiKey?: string;
  /** Min per-segment length in seconds */
  minSegmentDuration?: number;
  /** Max per-segment length in seconds */
  maxSegmentDuration?: number;
  /** Pass-through metadata: tv | movie | other */
  assetType?: string;
  /** Pass-through metadata: mobile | tv | tiktok | ig | shorts | facebook */
  platform?: string;
  /** Pass-through metadata: compact_video | full_video | highlights | trailer | episode_recap | season_recap */
  format?: string;
}

// ============================================================================
// Purpose & Goal Types
// ============================================================================

/**
 * Content generation purposes.
 * All use Pegasus 1.5 video segmentation.
 */
export enum Purpose {
  /** Full video split into chapters */
  FULL_VIDEO = "full_video",
  /** Compact video - condense to target percentage */
  COMPACT_VIDEO = "compact_video",
  /** Highlights - key moments (treated same as compact_video) */
  HIGHLIGHTS = "highlights",
  /** Episode recap - "previously on" style summary */
  EPISODE_RECAP = "episode_recap",
}

/**
 * Derive constraint rules from a Purpose.
 */
export function getPurposeConstraints(purpose: Purpose): {
  needsSegmentDuration: boolean;
  needsTotalDuration: boolean;
} {
  const needsSegmentDuration = true; // All purposes need segment duration bounds
  const needsTotalDuration =
    purpose === Purpose.COMPACT_VIDEO || purpose === Purpose.HIGHLIGHTS;
  return { needsSegmentDuration, needsTotalDuration };
}

/**
 * The three content types we support.
 * - sports: Uses replay detection pipeline (what did the broadcast replay?)
 * - serialized_scifi: Trek-style narrative threading
 * - generic: Standard microseries segmentation
 */
export type ContentType = "sports" | "serialized_scifi" | "generic";

export interface StoryIQGoals {
  purpose: Purpose;
  targetDuration?: number; // Calculated target duration in seconds
  targetPercent?: number; // Percentage of original duration (25, 50, 75, etc.)
  userInstructions?: string; // Custom instructions from user
  /** Skip classification and assume sports content (faster for known sports videos) */
  assumeSports?: boolean;
  /** Min per-segment length in seconds */
  minSegmentDuration?: number;
  /** Max per-segment length in seconds */
  maxSegmentDuration?: number;
  /** Pass-through metadata: tv | movie | other */
  assetType?: string;
  /** Pass-through metadata: mobile | tv | tiktok | ig | shorts | facebook */
  platform?: string;
  /** Pass-through metadata: compact_video | full_video | highlights | trailer | episode_recap | season_recap */
  format?: string;
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

/**
 * Jockey v3 self-directed inputs (SPEC-jockey-v3-self-directed-cuts.md).
 * Required when JOCKEY_V3_SELF_DIRECTED_ENABLED is on for compact/recap.
 */
export interface JockeyV3Input {
  /** TwelveLabs Agents API key (jockey1.0) */
  agentsApiKey: string;
  /** Asset id already readable under the Agents key (skips re-upload) */
  agentsAssetId?: string;
  /** Existing knowledge store containing the asset (skips indexing wait) */
  knowledgeStoreId?: string;
  /** Presigned video URL for one-time upload when no agentsAssetId exists */
  videoUrlForUpload?: string;
  /** Persist the Agents asset + store ids for reuse on later runs */
  onAgentsContextReady?: (ctx: {
    agentsAssetId: string;
    knowledgeStoreId: string;
  }) => Promise<void>;
}

export interface StoryIQInput {
  assetId: string;
  goals: StoryIQGoals;
  // Whisper original on S3 (asset.transcriptionUrl). Required for legacy StoryIQ.
  transcriptS3Uri?: string;
  // Optional: video duration in seconds (from frontend or asset record)
  videoDuration?: number;
  // Optional: video title (for prompts)
  title?: string;
  /**
   * Max time to wait on Pegasus async polling (ms). When unset, uses a safe default.
   * Lambdas should pass `getRemainingTimeInMillis() - buffer`.
   */
  maxAsyncWaitMs?: number;
  /** Gemini API key for fallback content classification */
  geminiApiKey?: string;
  /** Jockey v3 self-directed context (only used when the v3 flag is on) */
  jockeyV3?: JockeyV3Input;
  /** When true, use Jockey for compact/recap if env flags allow */
  jockeyEnabled?: boolean;
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
