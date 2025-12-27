/**
 * StoryIQ Verification Loop
 *
 * Phase 4 of the StoryIQ pipeline.
 * The agent reviews its own work and revises if needed.
 *
 * Flow:
 * 1. Get actual content for proposed segments
 * 2. Check coverage requirements
 * 3. Agent reviews its choices
 * 4. Revise or finalize
 */

import {
  parseJSONFromLLM,
  type ProposedSegment,
  type VideoUnderstanding,
  type Purpose,
  type StoryIQTools,
  type ReviewResult,
  type FinalSegments,
  type SegmentContent,
  type CoverageReport,
} from "./types";
import { getReviewPrompt, getRevisionPrompt } from "./prompts";
import { callClaude } from "./claude-client";

const MAX_REVISION_ATTEMPTS = 3;

// ============================================================================
// Main Verification Function
// ============================================================================

export interface VerifyOptions {
  segments: ProposedSegment[];
  understanding: VideoUnderstanding;
  purpose: Purpose;
  targetDuration?: number;
  tools: StoryIQTools;
  attempt?: number;
}

/**
 * Verify proposed segments and revise if needed.
 * Returns final segments with confidence score.
 */
export async function verifyAndRevise(
  options: VerifyOptions
): Promise<FinalSegments> {
  const {
    segments,
    understanding,
    purpose,
    targetDuration,
    tools,
    attempt = 1,
  } = options;

  console.log(`[StoryIQ Verify] Attempt ${attempt}/${MAX_REVISION_ATTEMPTS}`);

  // 1. Get actual content for proposed segments
  const timeRanges = segments.map((s) => ({
    start: s.startTime,
    end: s.endTime,
  }));

  let segmentContent: SegmentContent[];
  try {
    segmentContent = await tools.read_transcript_for_segments(timeRanges);
  } catch (error) {
    console.warn("[StoryIQ Verify] Failed to get segment content:", error);
    segmentContent = timeRanges.map((r) => ({
      startTime: r.start,
      endTime: r.end,
      transcript: "",
      sceneDescriptions: [],
    }));
  }

  // 2. Check coverage requirements (pass emotional beats to avoid re-querying)
  let coverage: CoverageReport;
  try {
    coverage = await tools.check_segment_coverage(
      timeRanges,
      purpose,
      understanding.duration,
      understanding.emotionalArc // Use cached emotional beats
    );
    coverage.targetDuration = targetDuration;
  } catch (error) {
    console.warn("[StoryIQ Verify] Failed to check coverage:", error);
    coverage = {
      totalDuration: segments.reduce(
        (sum, s) => sum + (s.endTime - s.startTime),
        0
      ),
      targetDuration,
      emotionalCoverage: { peaksCovered: 0, peaksTotal: 0 },
      issues: [],
      isValid: true,
    };
  }

  // 3. Agent reviews its own work
  const review = await reviewSegments(
    segments,
    segmentContent,
    coverage,
    purpose
  );

  console.log(
    `[StoryIQ Verify] Review result: confidence=${review.confidence}, needsRevision=${review.needsRevision}`
  );
  if (review.issues.length > 0) {
    console.log(`[StoryIQ Verify] Issues: ${review.issues.join("; ")}`);
  }

  // 4. Revise or finalize
  if (review.needsRevision && attempt < MAX_REVISION_ATTEMPTS) {
    console.log("[StoryIQ Verify] Revising segments...");

    const revisedSegments = await reviseSegments(
      segments,
      review.issues,
      understanding,
      purpose
    );

    // Recursive verification with incremented attempt
    return verifyAndRevise({
      segments: revisedSegments,
      understanding,
      purpose,
      targetDuration,
      tools,
      attempt: attempt + 1,
    });
  }

  // Finalize
  return {
    segments,
    confidence: review.confidence,
    notes: review.needsRevision
      ? [`Max attempts reached. Issues remain: ${review.issues.join("; ")}`]
      : review.suggestions,
    attempts: attempt,
  };
}

// ============================================================================
// Review Function
// ============================================================================

async function reviewSegments(
  segments: ProposedSegment[],
  segmentContent: SegmentContent[],
  coverage: CoverageReport,
  purpose: Purpose
): Promise<ReviewResult> {
  const prompt = getReviewPrompt(segments, segmentContent, coverage, purpose);

  try {
    const content = await callClaude({
      model: "sonnet",
      maxTokens: 1000,
      messages: [{ role: "user", content: prompt }],
    });

    const parsed = parseJSONFromLLM<Partial<ReviewResult>>(content);
    return {
      needsRevision: parsed.needsRevision ?? false,
      confidence: parsed.confidence ?? 0.7,
      issues: parsed.issues ?? [],
      suggestions: parsed.suggestions ?? [],
    };
  } catch (error) {
    console.error("[StoryIQ Verify] Review failed:", error);
    // On failure, assume segments are okay to avoid infinite loops
    return {
      needsRevision: false,
      confidence: 0.5,
      issues: ["Review failed - proceeding with current segments"],
      suggestions: [],
    };
  }
}

// ============================================================================
// Revision Function
// ============================================================================

async function reviseSegments(
  originalSegments: ProposedSegment[],
  issues: string[],
  understanding: VideoUnderstanding,
  purpose: Purpose
): Promise<ProposedSegment[]> {
  const prompt = getRevisionPrompt(
    originalSegments,
    issues,
    understanding,
    purpose
  );

  try {
    const content = await callClaude({
      model: "sonnet",
      maxTokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });

    const parsed = parseJSONFromLLM<{ plan?: ProposedSegment[] }>(content);
    if (parsed.plan && Array.isArray(parsed.plan)) {
      return parsed.plan;
    }

    return originalSegments;
  } catch (error) {
    console.error("[StoryIQ Verify] Revision failed:", error);
    return originalSegments;
  }
}

// ============================================================================
// Validation Utilities
// ============================================================================

/**
 * Basic validation of segment structure.
 * Catches obvious LLM errors before verification loop.
 */
export function validateSegmentStructure(
  segments: ProposedSegment[],
  videoDuration: number
): { valid: ProposedSegment[]; errors: string[] } {
  const errors: string[] = [];
  const valid: ProposedSegment[] = [];

  for (const seg of segments) {
    // Check required fields
    if (typeof seg.startTime !== "number" || typeof seg.endTime !== "number") {
      errors.push(`Segment missing timestamps: ${seg.title || "untitled"}`);
      continue;
    }

    // Check bounds
    if (seg.startTime < 0) {
      seg.startTime = 0;
      errors.push(`Fixed negative start time for: ${seg.title}`);
    }

    if (seg.endTime > videoDuration) {
      seg.endTime = videoDuration;
      errors.push(`Fixed end time exceeding duration for: ${seg.title}`);
    }

    // Check minimum duration (5 seconds)
    if (seg.endTime - seg.startTime < 5) {
      errors.push(
        `Segment too short (${seg.endTime - seg.startTime}s): ${seg.title}`
      );
      continue;
    }

    // Check order
    if (seg.endTime <= seg.startTime) {
      errors.push(`Invalid segment (end <= start): ${seg.title}`);
      continue;
    }

    // Ensure required string fields
    if (!seg.title) {
      seg.title = `Segment ${valid.length + 1}`;
    }
    if (!seg.reasoning) {
      seg.reasoning = "Selected for narrative value";
    }
    if (!seg.expectedContent) {
      seg.expectedContent = "Content from this time range";
    }

    valid.push(seg);
  }

  return { valid, errors };
}

/**
 * Check for overlapping segments and merge or reject.
 */
export function resolveOverlaps(
  segments: ProposedSegment[]
): ProposedSegment[] {
  if (segments.length <= 1) return segments;

  // Sort by start time
  const sorted = [...segments].sort((a, b) => a.startTime - b.startTime);
  const resolved: ProposedSegment[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const previous = resolved[resolved.length - 1];

    // Check for overlap
    if (current.startTime < previous.endTime) {
      // Adjust current to start after previous
      const adjustedStart = previous.endTime;
      if (current.endTime - adjustedStart >= 5) {
        resolved.push({
          ...current,
          startTime: adjustedStart,
        });
      }
      // Otherwise skip this segment (too short after adjustment)
    } else {
      resolved.push(current);
    }
  }

  return resolved;
}
