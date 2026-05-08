/**
 * StoryIQ - Intelligent Video Segment Generation
 *
 * Main orchestration module for the StoryIQ agent.
 *
 * Tool-Based Pipeline:
 * 1. Read transcript (from S3 cache)
 * 2. Get scene breaks (optional, from cache)
 * 3. Tool conversation - Claude creates segments via add/remove/update/finish tools
 *    with inline validation and actual transcript content returned per segment
 * 4. Quality review - separate reviewer checks titles vs content
 * 5. Deterministic fallback - enforcer guarantees hard constraints
 *
 * Design Principles:
 * - Give Claude actual content via tool results (not just prompts)
 * - Inline constraint validation (tools reject bad segments immediately)
 * - Budget tracking per tool call (Claude always knows remaining time)
 * - Scenes are optional, transcript is required
 */

import { TwelveLabsWrapper, type SceneBreak } from "../twelvelabs";
import { createStoryIQTools } from "./tools";
import { generateSegmentsWithTools } from "./tool-generation";
import {
  Purpose,
  type StoryIQInput,
  type StoryIQOutput,
  type StoryIQGoals,
  type ProposedSegment,
  type VideoMetadata,
  type TranscriptSegment,
} from "./types";

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Callback for status updates during generation.
 * Allows the caller to update DynamoDB job status.
 */
export type GenerationStatusCallback = (
  status: "detecting_scenes" | "generating",
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
 * @param onStatusChange - Optional callback to report status changes (for detecting_scenes)
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

  // Get video duration - prioritize input (from frontend/asset), then 12Labs, then transcript
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
  const tools = createStoryIQTools(twelvelabs, assetId, {
    transcriptS3Uri: input.transcriptS3Uri,
  });

  // Build simple metadata (replaces VideoUnderstanding)
  const metadata: VideoMetadata = {
    assetId,
    duration: videoDuration,
    title: input.title || "Untitled Video",
  };

  // Phase 1: Read transcript (required)
  console.log("[StoryIQ] Phase 1: Reading transcript...");
  const transcript = await tools.read_full_transcript();
  console.log(`[StoryIQ] Got ${transcript.length} transcript segments`);

  if (transcript.length === 0) {
    throw new Error(
      `Cannot generate segments: No transcript found for asset ${assetId}. ` +
        `The video may not have been indexed properly, or it may have no audible speech.`,
    );
  }

  // Phase 2: Get scene breaks (optional)
  let sceneBreaks: SceneBreak[] = [];
  const needsSceneDetection =
    goals.purpose === Purpose.FULL_VIDEO ||
    goals.purpose === Purpose.COMPACT_VIDEO ||
    goals.purpose === Purpose.HIGHLIGHTS;

  if (needsSceneDetection) {
    console.log("[StoryIQ] Checking scene cache...");

    // Check cache status - scenes are optional, we never auto-trigger detection
    const cacheCheck = await twelvelabs.getSceneCacheFromS3(assetId);

    if (cacheCheck.result) {
      // Cache hit - use cached scenes
      sceneBreaks = cacheCheck.result.brief;
      console.log(`[StoryIQ] Scene cache hit: ${sceneBreaks.length} scenes`);

      // Log scene cache metadata for debugging
      const meta = cacheCheck.result.meta;
      if (meta) {
        console.log(
          `[StoryIQ] Scene cache meta: ${meta.windowsSucceeded}/${meta.windowsTotal} windows, complete=${meta.isComplete}, rateLimit=${meta.hitRateLimit}`,
        );
      }
      console.log(
        `[StoryIQ] Scene cache detectedAt: ${cacheCheck.result.detectedAt}`,
      );
    } else {
      // No cache available - proceed without scenes
      // Scene detection must be triggered manually via the detect-scenes Lambda
      if (cacheCheck.failed) {
        console.warn(
          `[StoryIQ] Scene detection previously failed: ${cacheCheck.failedReason}. ` +
            `Proceeding without scene data.`,
        );
      } else if (cacheCheck.inProgress) {
        console.log(
          "[StoryIQ] Scene detection in progress but not waiting. Proceeding without scenes.",
        );
      } else {
        console.log(
          "[StoryIQ] No scene cache found. Run detect-scenes Lambda manually to populate. Proceeding without scenes.",
        );
      }
      sceneBreaks = [];
    }
  }

  // Log input data stats
  console.log(
    `[StoryIQ] Input: ${sceneBreaks.length} scenes, ${transcript.length} transcript segments`,
  );
  if (sceneBreaks.length > 0) {
    console.log(`[StoryIQ] Sample scene breaks (first 3):`);
    sceneBreaks.slice(0, 3).forEach((s, i) => {
      console.log(
        `  ${i + 1}. ${Math.floor(s.time / 60)}:${String(
          Math.floor(s.time % 60),
        ).padStart(2, "0")} | ${s.who} | ${s.action} | ${s.mood}`,
      );
    });
  }
  if (transcript.length > 0) {
    console.log(`[StoryIQ] Sample transcript (first 3 segments):`);
    transcript.slice(0, 3).forEach((t, i) => {
      console.log(
        `  ${i + 1}. ${Math.floor(t.startTime / 60)}:${String(
          Math.floor(t.startTime % 60),
        ).padStart(2, "0")} "${t.text.substring(0, 80)}..."`,
      );
    });
  }

  // Phase 3: Gemini-based segment generation + deterministic constraint enforcement
  console.log("[StoryIQ] Phase 3: Segment generation...");

  const finalResult = await generateSegmentsWithTools({
    metadata,
    transcript,
    sceneBreaks,
    purpose: goals.purpose,
    targetDuration: goals.targetDuration,
    targetPercent: goals.targetPercent,
    userInstructions: goals.userInstructions,
  });

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
}

const MAX_USER_INSTRUCTIONS_LENGTH = 500;
const DEFAULT_TARGET_PERCENT = 75;

export function mapMetadataToGoals(metadata: GenerateMetadata): StoryIQGoals {
  const userInstructions =
    metadata.userPrompt?.slice(0, MAX_USER_INSTRUCTIONS_LENGTH) || undefined;

  return {
    purpose: Purpose.COMPACT_VIDEO,
    targetPercent: DEFAULT_TARGET_PERCENT,
    userInstructions,
  };
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
} from "./types";

export { SceneDetectionPendingError } from "./types";
