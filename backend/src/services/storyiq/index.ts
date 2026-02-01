/**
 * StoryIQ - Intelligent Video Segment Generation
 *
 * Main orchestration module for the StoryIQ agent.
 *
 * Pipeline:
 * 1. Deep Understanding - Query 12Labs for comprehensive video analysis
 * 2. Synthesis - Build unified VideoUnderstanding
 * 3. Planning - Generate segment proposals based on purpose
 * 4. Verification - Self-review and revise if needed
 *
 * Design Principles (12-Factor Agents):
 * - JSON extraction as foundation
 * - Explicit prompts (owned, not buried in frameworks)
 * - Clear control flow: prompt → parse → validate → loop
 * - Stateless design (all state passed explicitly)
 * - Small, focused operations
 */

import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { TwelveLabsWrapper, type SceneBreak } from "../twelvelabs";
import { createStoryIQTools } from "./tools";
import { synthesizeVideoUnderstanding } from "./synthesize";
import { getPlanningPrompt } from "./prompts";
import {
  verifyAndRevise,
  validateSegmentStructure,
  resolveOverlaps,
} from "./verify";
import {
  parseJSONFromLLM,
  Purpose,
  SceneDetectionPendingError,
  type StoryIQInput,
  type StoryIQOutput,
  type StoryIQGoals,
  type ProposedSegment,
  type VideoUnderstanding,
} from "./types";
import { callClaude } from "./claude-client";

// Lambda client for async scene detection
const lambdaClient = new LambdaClient({});
const s3Client = new S3Client({});
const DETECT_SCENES_FUNCTION = process.env.DETECT_SCENES_FUNCTION;
const SCENE_CACHE_BUCKET =
  process.env.BUCKET_NAME || process.env.ASSETS_BUCKET || process.env.S3_BUCKET;

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Callback for status updates during generation.
 * Allows the caller to update DynamoDB job status.
 */
export type GenerationStatusCallback = (
  status: "detecting_scenes" | "generating"
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
  onStatusChange?: GenerationStatusCallback
): Promise<StoryIQOutput> {
  const startTime = Date.now();
  const { assetId, goals } = input;

  console.log(`[StoryIQ] Starting generation for asset ${assetId}`);
  console.log(
    `[StoryIQ] Purpose: ${goals.purpose}, Target: ${
      goals.targetDuration || "auto"
    }s`
  );
  if (goals.userInstructions) {
    console.log(
      `[StoryIQ] User instructions: "${goals.userInstructions.substring(
        0,
        100
      )}..."`
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
        `Asset may not have been properly indexed. Please re-upload or manually set the duration.`
    );
  }

  console.log(`[StoryIQ] Video duration: ${videoDuration}s`);

  // Create tools with duration for cache validation
  const tools = createStoryIQTools(twelvelabs, assetId, {
    transcriptS3Uri: input.transcriptS3Uri,
    videoDuration,
  });

  // Phase 1 & 2: Build video understanding (or use provided)
  let understanding: VideoUnderstanding;
  if (input.videoUnderstanding) {
    console.log("[StoryIQ] Using provided VideoUnderstanding");
    understanding = input.videoUnderstanding;
  } else {
    console.log("[StoryIQ] Phase 1-2: Building VideoUnderstanding...");

    understanding = await synthesizeVideoUnderstanding({
      assetId,
      duration: videoDuration,
      tools,
    });
  }

  // Phase 2b: Detect scenes for full_video/compact_video/highlights (provides cut points for Claude)
  let sceneBreaks: SceneBreak[] = [];
  const needsSceneDetection =
    goals.purpose === Purpose.FULL_VIDEO ||
    goals.purpose === Purpose.COMPACT_VIDEO ||
    goals.purpose === Purpose.HIGHLIGHTS;

  if (needsSceneDetection) {
    console.log("[StoryIQ] Checking scene cache...");

    // Check cache status
    const cacheCheck = await twelvelabs.getSceneCacheFromS3(assetId);

    if (cacheCheck.result) {
      // Cache hit - use cached scenes
      sceneBreaks = cacheCheck.result.brief;
      console.log(`[StoryIQ] Scene cache hit: ${sceneBreaks.length} scenes`);
    } else if (cacheCheck.failed) {
      // Detection failed (e.g., rate limit) - proceed without scenes
      // Claude can still make good decisions using transcript data
      console.warn(
        `[StoryIQ] Scene detection previously failed: ${cacheCheck.failedReason}. ` +
          `Proceeding without scene data - Claude will use transcript.`
      );
      sceneBreaks = [];
    } else {
      // Need to wait for scene detection (either start it or wait for existing)
      if (!cacheCheck.inProgress) {
        // No cache and not in progress - start detection
        console.log("[StoryIQ] Scene cache miss, starting async detection");
        await markSceneDetectionInProgress(assetId);
        await invokeDetectScenesLambda(assetId);
      } else {
        console.log("[StoryIQ] Scene detection already in progress");
      }

      // Update status to detecting_scenes and poll until ready
      await onStatusChange?.("detecting_scenes");
      sceneBreaks = await pollForSceneCache(twelvelabs, assetId);

      // Update status back to generating
      await onStatusChange?.("generating");
    }
  }

  // Phase 3: Generate initial segment proposals
  console.log("[StoryIQ] Phase 3: Generating segment proposals...");
  const proposedSegments = await generateSegmentProposals(
    understanding,
    goals,
    sceneBreaks
  );

  // Validate structure
  const { valid: validatedSegments, errors } = validateSegmentStructure(
    proposedSegments,
    understanding.duration
  );

  if (errors.length > 0) {
    console.warn("[StoryIQ] Validation errors:", errors);
  }

  // Resolve overlaps
  const resolvedSegments = resolveOverlaps(validatedSegments);

  // Phase 4: Verify and revise
  console.log("[StoryIQ] Phase 4: Verification loop...");
  const finalResult = await verifyAndRevise({
    segments: resolvedSegments,
    understanding,
    purpose: goals.purpose,
    targetDuration: goals.targetDuration,
    tools,
  });

  const processingTime = Date.now() - startTime;
  console.log(
    `[StoryIQ] Complete in ${processingTime}ms, ${finalResult.attempts} attempt(s)`
  );

  // Calculate actual duration
  const actualDuration = finalResult.segments.reduce(
    (sum, s) => sum + (s.endTime - s.startTime),
    0
  );

  return {
    segments: finalResult,
    videoUnderstanding: understanding,
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
  understanding: VideoUnderstanding,
  goals: StoryIQGoals,
  sceneBreaks: SceneBreak[] = []
): Promise<ProposedSegment[]> {
  // Get the appropriate prompt for this purpose
  const prompt = getPlanningPrompt(
    goals.purpose,
    understanding,
    goals.targetDuration,
    goals.userInstructions,
    sceneBreaks,
    goals.targetPercent
  );

  // Determine max tokens based on purpose
  // Full video and compact video modes may need many segments
  const maxTokens =
    goals.purpose === Purpose.FULL_VIDEO ||
    goals.purpose === Purpose.COMPACT_VIDEO
      ? 4000
      : 2000;

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
        `[StoryIQ] Generated ${parsed.plan.length} segment proposals`
      );
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
  duration: string | number | undefined | null
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
// Async Scene Detection
// ============================================================================

/**
 * Write in_progress marker to S3 cache before invoking Lambda.
 * Prevents race condition where multiple requests start detection.
 */
async function markSceneDetectionInProgress(assetId: string): Promise<void> {
  if (!SCENE_CACHE_BUCKET) {
    console.warn("[StoryIQ] No cache bucket configured");
    return;
  }

  const key = `scene-cache/${assetId}.json`;
  const body = JSON.stringify({
    status: "in_progress",
    startedAt: new Date().toISOString(),
    assetId,
  });

  await s3Client.send(
    new PutObjectCommand({
      Bucket: SCENE_CACHE_BUCKET,
      Key: key,
      Body: body,
      ContentType: "application/json",
    })
  );

  console.log(`[StoryIQ] Marked scene detection in_progress for ${assetId}`);
}

/**
 * Invoke the detectScenes Lambda asynchronously.
 * Does not wait for completion - returns immediately.
 */
async function invokeDetectScenesLambda(assetId: string): Promise<void> {
  if (!DETECT_SCENES_FUNCTION) {
    console.warn(
      "[StoryIQ] DETECT_SCENES_FUNCTION not configured, cannot invoke async detection"
    );
    throw new Error("Scene detection not configured");
  }

  const payload = { assetId };

  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: DETECT_SCENES_FUNCTION,
      InvocationType: "Event", // Async - fire and forget
      Payload: JSON.stringify(payload),
    })
  );

  console.log(`[StoryIQ] Invoked detectScenes Lambda for ${assetId} (async)`);
}

/**
 * Poll the S3 scene cache until detection completes.
 * Returns the detected scenes, or empty array if detection fails.
 *
 * This keeps the Lambda running and waiting, ensuring generation completes
 * in one execution rather than requiring frontend retry.
 */
async function pollForSceneCache(
  twelvelabs: TwelveLabsWrapper,
  assetId: string,
  options: {
    maxWaitMs?: number;
    pollIntervalMs?: number;
  } = {}
): Promise<SceneBreak[]> {
  // 8 min max for scene polling, leaving ~2 min buffer for Claude generation
  // (generateSegments Lambda has 10 min timeout)
  const { maxWaitMs = 8 * 60 * 1000, pollIntervalMs = 15000 } = options;
  const startTime = Date.now();

  console.log(
    `[StoryIQ] Polling for scene cache (max ${maxWaitMs / 1000}s, interval ${
      pollIntervalMs / 1000
    }s)...`
  );

  while (Date.now() - startTime < maxWaitMs) {
    // Wait before checking (scene detection takes at least 30s)
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[StoryIQ] Checking scene cache... (${elapsed}s elapsed)`);

    const cacheCheck = await twelvelabs.getSceneCacheFromS3(assetId);

    if (cacheCheck.result) {
      console.log(
        `[StoryIQ] Scene cache ready after ${elapsed}s: ${cacheCheck.result.brief.length} scenes`
      );
      return cacheCheck.result.brief;
    }

    if (cacheCheck.failed) {
      console.warn(
        `[StoryIQ] Scene detection failed after ${elapsed}s: ${cacheCheck.failedReason}. ` +
          `Proceeding without scene data.`
      );
      return [];
    }

    if (!cacheCheck.inProgress) {
      // Unexpected state - cache disappeared but not complete or failed
      console.warn(
        `[StoryIQ] Unexpected cache state after ${elapsed}s - not in_progress, not complete, not failed. Proceeding without scenes.`
      );
      return [];
    }

    // Still in progress - continue polling
  }

  // Timeout - proceed without scenes rather than failing
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.warn(
    `[StoryIQ] Scene detection polling timed out after ${elapsed}s. Proceeding without scene data.`
  );
  return [];
}

// ============================================================================
// Export Types
// ============================================================================

export type {
  StoryIQInput,
  StoryIQOutput,
  StoryIQGoals,
  ProposedSegment,
  VideoUnderstanding,
  Purpose,
} from "./types";

export { SceneDetectionPendingError } from "./types";
