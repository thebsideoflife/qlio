/**
 * StoryIQ - Intelligent Video Segment Generation
 *
 * Pipeline:
 * 1. Read transcript (S3) — for enforcer word boundaries and editor dialogue snippets
 * 2. Segment generation — Pegasus 1.5 video analysis (chunked videos run in parallel)
 * 3. Deterministic constraint enforcement (duration bounds, no overlaps)
 */

import { TwelveLabsWrapper } from "../twelvelabs";
import { createStoryIQTools } from "./tools";
import { generateSegmentsWithPegasus } from "./pegasus-pipeline";
import {
  generateSegmentsWithJockey,
  isJockeyPipelineEnabled,
} from "./jockey-pipeline";
import {
  generateSegmentsWithJockeyV3,
  isJockeyV3Enabled,
} from "./jockey-v3-pipeline";
import {
  Purpose,
  type StoryIQInput,
  type StoryIQOutput,
  type StoryIQGoals,
  type ProposedSegment,
  type VideoMetadata,
  type TranscriptSegment,
  type FinalSegments,
} from "./types";

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Callback for status updates during generation.
 */
export type GenerationStatusCallback = (
  status: "generating",
) => Promise<void>;

/**
 * Generate segments for a video using StoryIQ.
 *
 * This is the main entry point. It orchestrates:
 * 1. Building deep video understanding (if not provided)
 * 2. Generating segment proposals
 * 3. Verifying and revising
 *
 * @param twelvelabs - The TwelveLabsWrapper instance
 * @param input - Generation input (assetId, goals, etc.)
 * @param onStatusChange - Optional callback to report status changes
 */
export async function generateWithStoryIQ(
  twelvelabs: TwelveLabsWrapper,
  input: StoryIQInput,
  onStatusChange?: GenerationStatusCallback,
): Promise<StoryIQOutput> {
  const startTime = Date.now();
  const { assetId, goals } = input;

  console.log(`[StoryIQ] Starting generation for asset ${assetId}`);
  console.log(
    `[StoryIQ] Purpose: ${goals.purpose}, Target: ${
      goals.targetDuration || "auto"
    }s`,
  );
  if (goals.userInstructions) {
    console.log(
      `[StoryIQ] User instructions: "${goals.userInstructions.substring(
        0,
        100,
      )}..."`,
    );
  }

  // Get video duration from asset / TwelveLabs media metadata only.
  // Never derive duration from transcript timestamps.
  let videoDuration = input.videoDuration || 0;

  if (videoDuration > 0) {
    console.log(`[StoryIQ] Using provided video duration: ${videoDuration}s`);
  } else {
    // Try 12Labs metadata
    try {
      const metadata = await twelvelabs.getVideoMetadata(assetId);
      videoDuration = metadata.duration || 0;
      if (videoDuration > 0) {
        console.log(`[StoryIQ] Got duration from 12Labs: ${videoDuration}s`);
      }
    } catch (err) {
      console.warn("[StoryIQ] Failed to get metadata from 12Labs");
    }
  }

  // FAIL FAST: If we still don't have a valid duration, we can't proceed
  if (videoDuration <= 0) {
    throw new Error(
      `Cannot generate segments: Video duration is ${videoDuration}s. ` +
        `Asset may not have been properly indexed. Please re-upload or manually set the duration.`,
    );
  }

  console.log(`[StoryIQ] Video duration: ${videoDuration}s`);

  // Recalculate targetDuration now that videoDuration is known.
  // mapMetadataToGoals runs before videoDuration is resolved (frontend sends null),
  // so goals.targetDuration may be undefined even when targetPercent is set.
  if (
    (goals.purpose === Purpose.COMPACT_VIDEO ||
      goals.purpose === Purpose.HIGHLIGHTS) &&
    goals.targetPercent &&
    !goals.targetDuration &&
    videoDuration > 0
  ) {
    goals.targetDuration = Math.round(
      (videoDuration * goals.targetPercent) / 100,
    );
    console.log(
      `[StoryIQ] Calculated targetDuration: ${goals.targetDuration}s ` +
        `(${goals.targetPercent}% of ${videoDuration}s)`,
    );
  }

  // Create tools for transcript access
  const tools = createStoryIQTools(assetId, {
    transcriptS3Uri: input.transcriptS3Uri,
  });

  // Build simple metadata (replaces VideoUnderstanding)
  const metadata: VideoMetadata = {
    assetId,
    duration: videoDuration,
    title: input.title || "Untitled Video",
  };

  const isJockeyPurpose =
    goals.purpose === Purpose.COMPACT_VIDEO ||
    goals.purpose === Purpose.EPISODE_RECAP;
  const jockeyRequested = input.jockeyEnabled === true;
  const useJockeyV3 =
    jockeyRequested && isJockeyV3Enabled() && isJockeyPurpose;
  const useJockey =
    jockeyRequested &&
    !useJockeyV3 &&
    isJockeyPipelineEnabled() &&
    isJockeyPurpose;

  let finalResult: FinalSegments;

  if (useJockeyV3) {
    // Jockey v3 self-directed path: no transcript preprocess, no brief, no
    // scene cache. Fail loud if the Agents context is missing — no fallback
    // to the legacy path while the v3 flag is on.
    if (!input.jockeyV3) {
      throw new Error(
        "[StoryIQ] JOCKEY_V3_SELF_DIRECTED_ENABLED is on but no Agents API context was provided " +
          "(agentsApiKey required). Refusing to fall back to the legacy path.",
      );
    }

    console.log("[StoryIQ] Phase 2: Jockey v3 self-directed generation...");
    finalResult = await generateSegmentsWithJockeyV3({
      purpose: goals.purpose,
      metadata,
      targetDuration: goals.targetDuration,
      targetPercent: goals.targetPercent,
      userInstructions: goals.userInstructions,
      maxPollWaitMs: input.maxAsyncWaitMs,
      agentsApiKey: input.jockeyV3.agentsApiKey,
      agentsAssetId: input.jockeyV3.agentsAssetId,
      knowledgeStoreId: input.jockeyV3.knowledgeStoreId,
      videoUrlForUpload: input.jockeyV3.videoUrlForUpload,
      onAgentsContextReady: input.jockeyV3.onAgentsContextReady,
    });
  } else {
    // Phase 1: Read transcript (required for legacy paths)
    console.log("[StoryIQ] Phase 1: Reading transcript...");
    const transcript = await tools.read_full_transcript();
    console.log(`[StoryIQ] Got ${transcript.length} transcript segments`);

    if (transcript.length === 0) {
      throw new Error(
        `Cannot generate segments: No transcript found for asset ${assetId}. ` +
          `The video may not have been indexed properly, or it may have no audible speech.`,
      );
    }

    // Phase 2: Segment generation (Jockey for compact/recap when enabled, else Pegasus)
    console.log("[StoryIQ] Phase 2: Segment generation...");

    const generationOptions = {
      metadata,
      transcript,
      purpose: goals.purpose,
      targetDuration: goals.targetDuration,
      targetPercent: goals.targetPercent,
      userInstructions: goals.userInstructions,
      maxPollWaitMs: input.maxAsyncWaitMs,
      geminiApiKey: input.geminiApiKey,
      assumeSports: goals.assumeSports,
      minSegmentDuration: goals.minSegmentDuration,
      maxSegmentDuration: goals.maxSegmentDuration,
      assetType: goals.assetType,
      platform: goals.platform,
      format: goals.format,
    };

    finalResult = useJockey
      ? await generateSegmentsWithJockey(twelvelabs, generationOptions)
      : await generateSegmentsWithPegasus(twelvelabs, generationOptions);
  }

  const processingTime = Date.now() - startTime;
  console.log(
    `[StoryIQ] Complete in ${processingTime}ms, ${finalResult.segments.length} segments`,
  );

  // Calculate actual duration
  const actualDuration = finalResult.segments.reduce(
    (sum, s) => sum + (s.endTime - s.startTime),
    0,
  );

  return {
    segments: finalResult,
    metadata: {
      purpose: goals.purpose,
      targetDuration: goals.targetDuration,
      actualDuration,
      processingTime,
      attempts: finalResult.attempts,
    },
  };
}

// ============================================================================
// Utility: Map Frontend Request to StoryIQ Goals
// ============================================================================

export interface GenerateMetadata {
  userPrompt?: string;
  videoDuration?: number;
  /** IQ panel purpose */
  purpose?: "compact_video" | "highlights" | "full_video" | "episode_recap";
  /** Omitted or null = Auto (no fixed %). 25 / 50 / 75 when set. */
  targetPercent?: number | null;
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

const MAX_USER_INSTRUCTIONS_LENGTH = 8000;

/**
 * Map frontend request to StoryIQ goals.
 */
export function mapMetadataToGoals(metadata: GenerateMetadata): StoryIQGoals {
  const userInstructions =
    metadata.userPrompt?.slice(0, MAX_USER_INSTRUCTIONS_LENGTH) || undefined;

  let purpose: Purpose;
  switch (metadata.purpose) {
    case "highlights":
      purpose = Purpose.HIGHLIGHTS;
      break;
    case "full_video":
      purpose = Purpose.FULL_VIDEO;
      break;
    case "episode_recap":
      purpose = Purpose.EPISODE_RECAP;
      break;
    case "compact_video":
    default:
      purpose = Purpose.COMPACT_VIDEO;
      break;
  }

  const goals: StoryIQGoals = { purpose, userInstructions };

  if (
    metadata.targetPercent != null &&
    typeof metadata.targetPercent === "number" &&
    metadata.targetPercent > 0 &&
    metadata.targetPercent <= 100
  ) {
    goals.targetPercent = Math.round(metadata.targetPercent);
  }

  // Pass through duration bounds if provided
  if (typeof metadata.minSegmentDuration === "number" && metadata.minSegmentDuration >= 2) {
    goals.minSegmentDuration = metadata.minSegmentDuration;
  }
  if (typeof metadata.maxSegmentDuration === "number" && metadata.maxSegmentDuration > 0) {
    goals.maxSegmentDuration = metadata.maxSegmentDuration;
  }

  // Pass through metadata fields
  if (metadata.assetType) {
    goals.assetType = metadata.assetType;
  }
  if (metadata.platform) {
    goals.platform = metadata.platform;
  }
  if (metadata.format) {
    goals.format = metadata.format;
  }

  // Skip classification for highlights (always sports for now)
  // Can be overridden by explicit assumeSports=false in metadata
  if (metadata.assumeSports !== false && purpose === Purpose.HIGHLIGHTS) {
    goals.assumeSports = true;
  } else if (metadata.assumeSports === true) {
    goals.assumeSports = true;
  }

  return goals;
}

// ============================================================================
// Export Types
// ============================================================================

export type {
  StoryIQInput,
  StoryIQOutput,
  StoryIQGoals,
  ProposedSegment,
  VideoMetadata,
  TranscriptSegment,
  Purpose,
  JockeyV3Input,
} from "./types";

export { SceneDetectionPendingError } from "./types";
