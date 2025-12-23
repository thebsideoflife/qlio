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

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { TwelveLabsWrapper } from "../twelvelabs";
import { createStoryIQTools } from "./tools";
import { synthesizeVideoUnderstanding } from "./synthesize";
import { getPlanningPrompt } from "./prompts";
import {
  verifyAndRevise,
  validateSegmentStructure,
  resolveOverlaps,
} from "./verify";
import {
  MODEL_SONNET,
  extractLLMContent,
  parseJSONFromLLM,
  type StoryIQInput,
  type StoryIQOutput,
  type StoryIQGoals,
  type ProposedSegment,
  type VideoUnderstanding,
  type Purpose,
} from "./types";

const bedrock = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || "us-west-2",
});

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Generate segments for a video using StoryIQ.
 *
 * This is the main entry point. It orchestrates:
 * 1. Building deep video understanding (if not provided)
 * 2. Generating segment proposals
 * 3. Verifying and revising
 */
export async function generateWithStoryIQ(
  twelvelabs: TwelveLabsWrapper,
  input: StoryIQInput
): Promise<StoryIQOutput> {
  const startTime = Date.now();
  const { assetId, goals } = input;

  console.log(`[StoryIQ] Starting generation for asset ${assetId}`);
  console.log(
    `[StoryIQ] Purpose: ${goals.purpose}, Target: ${
      goals.targetDuration || "auto"
    }s`
  );

  // Create tools bound to this asset (with S3 transcript if available)
  const tools = createStoryIQTools(twelvelabs, assetId, {
    transcriptS3Uri: input.transcriptS3Uri,
  });

  // Phase 1 & 2: Build video understanding (or use provided)
  let understanding: VideoUnderstanding;
  if (input.videoUnderstanding) {
    console.log("[StoryIQ] Using provided VideoUnderstanding");
    understanding = input.videoUnderstanding;
  } else {
    console.log("[StoryIQ] Phase 1-2: Building VideoUnderstanding...");
    const metadata = await twelvelabs.getVideoMetadata(assetId);

    understanding = await synthesizeVideoUnderstanding({
      assetId,
      duration: metadata.duration,
      tools,
    });
  }

  // Phase 3: Generate initial segment proposals
  console.log("[StoryIQ] Phase 3: Generating segment proposals...");
  const proposedSegments = await generateSegmentProposals(understanding, goals);

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
  goals: StoryIQGoals
): Promise<ProposedSegment[]> {
  // Get the appropriate prompt for this purpose
  const prompt = getPlanningPrompt(
    goals.purpose,
    understanding,
    goals.targetDuration
  );

  // Determine max tokens based on purpose
  // Binge mode may need many segments
  const maxTokens = goals.purpose === "binge" ? 4000 : 2000;

  try {
    const command = new InvokeModelCommand({
      modelId: MODEL_SONNET,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: maxTokens,
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
  purpose?: string; // "binge" | "highlights" | etc.
  duration?: string; // "3 min" | "30s" | "Auto" - target duration selection
  videoDuration?: number; // Actual video duration in seconds (for reference)
}

export function mapMetadataToGoals(metadata: FrontendMetadata): StoryIQGoals {
  return {
    purpose: (metadata.purpose as Purpose) || "highlights",
    contentType: (metadata.type as "tv" | "movie" | "ugc") || "tv",
    platform: (metadata.platform as any) || "mobile",
    targetDuration: parseDurationString(metadata.duration),
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
  VideoUnderstanding,
  Purpose,
} from "./types";
