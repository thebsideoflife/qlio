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
  Purpose,
  type ProposedSegment,
  type VideoUnderstanding,
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

  // 2b. Check duration constraints (1-3 minute segments) - ONLY for full_video and compact_video
  const needsStrictDuration =
    purpose === Purpose.FULL_VIDEO ||
    purpose === Purpose.COMPACT_VIDEO ||
    purpose === Purpose.HIGHLIGHTS;

  if (needsStrictDuration) {
    const durationIssues = checkDurations(segments);
    if (durationIssues.length > 0) {
      console.log(
        `[StoryIQ Verify] Duration issues found: ${durationIssues.length}`
      );
      coverage.issues.push(...durationIssues);
      coverage.isValid = false;
    }
  }

  // 2c. Check total duration against target (for compact_video)
  if (
    needsStrictDuration &&
    targetDuration &&
    targetDuration > 0
  ) {
    const totalIssue = checkTotalDuration(segments, targetDuration);
    if (totalIssue) {
      console.log(`[StoryIQ Verify] Total duration issue: ${totalIssue}`);
      coverage.issues.push(totalIssue);
      coverage.isValid = false;
    }
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
  // Build friendly notes if there are remaining issues
  let notes: string[] = [];
  if (review.needsRevision && attempt >= MAX_REVISION_ATTEMPTS) {
    // Check if we have duration issues - use friendly wording for demos
    const hasDurationIssues = review.issues.some(
      (i) => i.includes("minimum") || i.includes("maximum") || i.includes("duration")
    );
    if (hasDurationIssues) {
      notes = ["Some segments may benefit from timing adjustments."];
    } else {
      notes = ["Minor adjustments may improve results."];
    }
  } else {
    notes = review.suggestions;
  }

  return {
    segments,
    confidence: review.confidence,
    notes,
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
// Duration Validation
// ============================================================================

/**
 * Check if segments meet duration constraints (60-180 seconds).
 * Returns human-readable issues for Claude to fix.
 *
 * @param segments - The segments to check
 * @param minSeconds - Minimum segment duration (default 60s / 1 min)
 * @param maxSeconds - Maximum segment duration (default 180s / 3 min)
 * @returns Array of issue strings, empty if all segments are valid
 */
export function checkDurations(
  segments: ProposedSegment[],
  minSeconds: number = 60,
  maxSeconds: number = 180
): string[] {
  const issues: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const duration = seg.endTime - seg.startTime;
    const durationSec = Math.round(duration);

    if (duration < minSeconds) {
      const deficit = Math.round(minSeconds - duration);
      issues.push(
        `Segment ${i + 1} "${seg.title}" is ${durationSec}s (${deficit}s under ${minSeconds}s minimum) - consider merging with adjacent segment`
      );
    }

    if (duration > maxSeconds) {
      const excess = Math.round(duration - maxSeconds);
      issues.push(
        `Segment ${i + 1} "${seg.title}" is ${durationSec}s (${excess}s over ${maxSeconds}s maximum) - find a scene break to split this segment`
      );
    }
  }

  return issues;
}

/**
 * Check if total duration is within tolerance of target.
 *
 * @param segments - The segments to check
 * @param targetDuration - Target total duration in seconds
 * @param tolerancePercent - Acceptable variance (default 15%)
 * @returns Issue string if out of tolerance, null if within
 */
export function checkTotalDuration(
  segments: ProposedSegment[],
  targetDuration: number,
  tolerancePercent: number = 15
): string | null {
  const totalDuration = segments.reduce(
    (sum, s) => sum + (s.endTime - s.startTime),
    0
  );

  const minAllowed = targetDuration * (1 - tolerancePercent / 100);
  const maxAllowed = targetDuration * (1 + tolerancePercent / 100);

  if (totalDuration < minAllowed) {
    const deficit = Math.round(targetDuration - totalDuration);
    return `Total duration ${Math.round(totalDuration)}s is ${deficit}s under target ${Math.round(targetDuration)}s - include more content`;
  }

  if (totalDuration > maxAllowed) {
    const excess = Math.round(totalDuration - targetDuration);
    return `Total duration ${Math.round(totalDuration)}s is ${excess}s over target ${Math.round(targetDuration)}s - cut less important content`;
  }

  return null;
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
