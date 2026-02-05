/**
 * StoryIQ - Intelligent Video Segment Generation
 *
 * Main orchestration module for the StoryIQ agent.
 *
 * Simplified Pipeline:
 * 1. Read transcript (from S3 cache)
 * 2. Get scene breaks (optional, from cache)
 * 3. Planning - Generate segment proposals with full transcript context
 * 4. Verification - Self-review and revise with transcript context
 *
 * Design Principles:
 * - Give Claude the actual content (transcript + scenes)
 * - No synthesis step - direct data flow
 * - Scenes are optional, transcript is required
 */

import { TwelveLabsWrapper, type SceneBreak } from "../twelvelabs";
import { createStoryIQTools } from "./tools";
import { getPlanningPrompt } from "./prompts";
import {
  verifyAndRevise,
  validateSegmentStructure,
  resolveOverlaps,
} from "./verify";
import {
  parseJSONFromLLM,
  Purpose,
  type StoryIQInput,
  type StoryIQOutput,
  type StoryIQGoals,
  type ProposedSegment,
  type VideoMetadata,
  type TranscriptSegment,
} from "./types";
import { callClaude } from "./claude-client";

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

  // Phase 3: Generate initial segment proposals
  console.log("[StoryIQ] Phase 3: Generating segment proposals...");

  // Log input data stats
  console.log(
    `[StoryIQ] Input: ${sceneBreaks.length} scenes, ${transcript.length} transcript segments`,
  );
  if (sceneBreaks.length > 0 && transcript.length > 0) {
    console.log(
      "[StoryIQ] Scenes will be grouped with dialogue for planning prompt",
    );
  }

  // Log sample of input data for debugging
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

  const proposedSegments = await generateSegmentProposals(
    metadata,
    transcript,
    sceneBreaks,
    goals,
  );

  // Validate structure
  const { valid: validatedSegments, errors } = validateSegmentStructure(
    proposedSegments,
    metadata.duration,
  );

  if (errors.length > 0) {
    console.warn("[StoryIQ] Validation errors:", errors);
  }

  // Resolve overlaps
  const resolvedSegments = resolveOverlaps(validatedSegments);

  // Log if overlaps were resolved
  if (resolvedSegments.length !== validatedSegments.length) {
    console.log(
      `[StoryIQ] Removed ${
        validatedSegments.length - resolvedSegments.length
      } segment(s) due to overlap`,
    );
  }

  // Log resolved duration
  const resolvedDuration = resolvedSegments.reduce(
    (sum, s) => sum + (s.endTime - s.startTime),
    0,
  );
  console.log(
    `[StoryIQ] After overlap resolution: ${resolvedSegments.length} segments, ${resolvedDuration}s total`,
  );

  // Phase 4: Verify and revise
  console.log("[StoryIQ] Phase 4: Verification loop...");
  const finalResult = await verifyAndRevise({
    segments: resolvedSegments,
    metadata,
    transcript,
    sceneBreaks,
    purpose: goals.purpose,
    targetDuration: goals.targetDuration,
    tools,
  });

  const processingTime = Date.now() - startTime;
  console.log(
    `[StoryIQ] Complete in ${processingTime}ms, ${finalResult.attempts} attempt(s)`,
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
// Segment Proposal Generation
// ============================================================================

async function generateSegmentProposals(
  metadata: VideoMetadata,
  transcript: TranscriptSegment[],
  sceneBreaks: SceneBreak[] | null,
  goals: StoryIQGoals,
): Promise<ProposedSegment[]> {
  // Get the appropriate prompt for this purpose
  const prompt = getPlanningPrompt(
    goals.purpose,
    metadata,
    transcript,
    sceneBreaks,
    goals.targetDuration,
    goals.userInstructions,
    goals.targetPercent,
  );

  // Log prompt size for debugging
  const promptChars = prompt.length;
  const estimatedTokens = Math.round(promptChars / 4); // rough estimate
  console.log(
    `[StoryIQ] Planning prompt: ${promptChars} chars (~${estimatedTokens} tokens)`,
  );

  // Use generous max tokens - don't risk truncation
  const maxTokens = 8000;

  try {
    const content = await callClaude({
      model: "sonnet",
      maxTokens,
      messages: [{ role: "user", content: prompt }],
    });

    // Parse JSON response
    const parsed = parseJSONFromLLM<{ plan?: ProposedSegment[] }>(content);

    if (parsed.plan && Array.isArray(parsed.plan)) {
      console.log(
        `[StoryIQ] Generated ${parsed.plan.length} segment proposals`,
      );

      // Log each proposed segment for debugging
      const totalDuration = parsed.plan.reduce(
        (sum, s) => sum + (s.endTime - s.startTime),
        0,
      );
      console.log(
        `[StoryIQ] Proposed segments (total ${Math.round(totalDuration)}s):`,
      );
      parsed.plan.forEach((seg, i) => {
        const duration = Math.round(seg.endTime - seg.startTime);
        console.log(
          `  ${i + 1}. [${Math.round(seg.startTime)}s-${Math.round(
            seg.endTime,
          )}s] (${duration}s) "${seg.title}"`,
        );
      });

      return parsed.plan;
    }

    return [];
  } catch (error) {
    console.error("[StoryIQ] Segment generation failed:", error);
    throw error;
  }
}

// ============================================================================
// Utility: Parse Duration String
// ============================================================================

/**
 * Parse duration from frontend. Handles:
 * - String formats: "3 min", "30s", "Auto"
 * - Number (already in seconds, but this is video duration - ignore for target)
 * - undefined/null
 *
 * Returns duration in seconds, or undefined for "Auto" or invalid input
 */
export function parseDurationString(
  duration: string | number | undefined | null,
): number | undefined {
  // Handle null/undefined
  if (duration === null || duration === undefined) {
    return undefined;
  }

  // If it's a number, it's likely the video duration passed from frontend
  // This is NOT the target duration selection - ignore it
  if (typeof duration === "number") {
    // Numbers are ignored - they're video duration, not target duration
    return undefined;
  }

  // Handle string
  if (typeof duration !== "string") {
    return undefined;
  }

  if (!duration || duration.toLowerCase() === "auto") {
    return undefined;
  }

  const trimmed = duration.trim().toLowerCase();

  // Match patterns like "30s", "30 s", "30sec", "30 sec"
  const secondsMatch = trimmed.match(/^(\d+)\s*s(ec(ond)?s?)?$/);
  if (secondsMatch) {
    return parseInt(secondsMatch[1], 10);
  }

  // Match patterns like "3min", "3 min", "3m", "3 minutes"
  const minutesMatch = trimmed.match(/^(\d+\.?\d*)\s*m(in(ute)?s?)?$/);
  if (minutesMatch) {
    return Math.round(parseFloat(minutesMatch[1]) * 60);
  }

  // Try parsing as raw number string (assume seconds)
  const num = parseFloat(trimmed);
  if (!isNaN(num)) {
    return Math.round(num);
  }

  return undefined;
}

// ============================================================================
// Utility: Map Frontend Metadata to StoryIQ Goals
// ============================================================================

export interface FrontendMetadata {
  type?: string; // "tv" | "movie" | "ugc"
  platform?: string; // "mobile" | "tiktok" | etc.
  purpose?: string; // "full_video" | "compact_video" | "highlights" | etc.
  duration?: string; // "3 min" | "30s" | "Auto" - for non-compact purposes
  targetPercent?: number | string; // For compact_video: 25, 50, 75, or custom
  videoDuration?: number; // Actual video duration in seconds (for reference)
  userPrompt?: string; // Custom instructions from user
}

const MAX_USER_INSTRUCTIONS_LENGTH = 500;

export function mapMetadataToGoals(metadata: FrontendMetadata): StoryIQGoals {
  // Truncate user instructions to prevent overly long prompts
  const userInstructions =
    metadata.userPrompt?.slice(0, MAX_USER_INSTRUCTIONS_LENGTH) || undefined;

  // Parse target percent for compact video
  let targetPercent: number | undefined;
  if (metadata.targetPercent !== undefined) {
    const parsed =
      typeof metadata.targetPercent === "number"
        ? metadata.targetPercent
        : parseInt(String(metadata.targetPercent), 10);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      targetPercent = parsed;
    }
  }

  // Calculate target duration for compact video based on percentage
  let targetDuration = parseDurationString(metadata.duration);
  if (
    (metadata.purpose === "compact_video" ||
      metadata.purpose === "highlights") &&
    targetPercent &&
    metadata.videoDuration
  ) {
    targetDuration = Math.round((metadata.videoDuration * targetPercent) / 100);
  }

  return {
    purpose: (metadata.purpose as Purpose) || Purpose.COMPACT_VIDEO,
    contentType: (metadata.type as "tv" | "movie" | "ugc") || "tv",
    platform: (metadata.platform as any) || "mobile",
    targetDuration,
    targetPercent,
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
