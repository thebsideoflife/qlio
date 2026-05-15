/**
 * StoryIQ Constraint Enforcer
 *
 * Deterministic constraint enforcement for video segments.
 * All creative/quality decisions happen in Pegasus segmentation.
 * This module only guarantees hard constraints are met (duration bounds, no overlaps, etc).
 */

import {
  Purpose,
  getPurposeConstraints,
  type ProposedSegment,
  type VideoMetadata,
  type TranscriptSegment,
} from "./types";

// ============================================================================
// Types
// ============================================================================

/** Record of what the enforcer changed, so callers can report/log */
export interface EnforcerChange {
  type: "clamped" | "overlap" | "split" | "dropped" | "added";
  detail: string;
}

export interface EnforceResult {
  segments: ProposedSegment[];
  changes: EnforcerChange[];
}

// ============================================================================
// Enforcer: Deterministic Constraint Fixing
// ============================================================================

/**
 * Run all deterministic constraint fixes and return what was changed.
 * This is the safety net — it runs AFTER the tool conversation and quality review.
 *
 * Self-guarding: derives constraint rules from `purpose` so callers can't
 * accidentally enforce total duration for full_video, etc.
 *
 * Order matters:
 * 1. Clamp to video duration (discard/trim out-of-bounds)
 * 2. Resolve overlaps (split at midpoint, snap to word boundary)
 * 3. Split oversized segments (>180s → multiple segments)
 * 4. Enforce total duration (drop/add segments to hit target)
 */
export function enforceConstraints(
  segments: ProposedSegment[],
  metadata: VideoMetadata,
  transcript: TranscriptSegment[],
  purpose: Purpose,
  targetDuration?: number,
): EnforceResult {
  const { needsSegmentDuration, needsTotalDuration } =
    getPurposeConstraints(purpose);
  const changes: EnforcerChange[] = [];
  let current = segments.map((s) => ({ ...s })); // deep copy

  // 1. Clamp to video duration
  const beforeClamp = current.length;
  current = clampToVideoDuration(current, metadata.duration);
  if (current.length < beforeClamp) {
    changes.push({
      type: "clamped",
      detail: `Removed ${beforeClamp - current.length} segment(s) past video end (${Math.round(metadata.duration)}s)`,
    });
  }

  // 2. Resolve overlaps
  const beforeOverlap = current.length;
  const beforeOverlapSegments = current.map((s) => ({
    start: s.startTime,
    end: s.endTime,
  }));
  current = resolveOverlaps(current, transcript);
  // Check if any boundaries actually moved
  const overlapsFixed = current.some(
    (s, i) =>
      i < beforeOverlapSegments.length &&
      (Math.abs(s.startTime - beforeOverlapSegments[i].start) > 0.1 ||
        Math.abs(s.endTime - beforeOverlapSegments[i].end) > 0.1),
  );
  if (overlapsFixed || current.length < beforeOverlap) {
    changes.push({
      type: "overlap",
      detail: `Resolved overlapping segments`,
    });
  }

  // 3. Split oversized segments
  if (needsSegmentDuration) {
    const beforeSplit = current.length;
    current = splitOversizedSegments(current, transcript);
    if (current.length > beforeSplit) {
      changes.push({
        type: "split",
        detail: `Split ${current.length - beforeSplit} oversized segment(s) exceeding 180s`,
      });
    }
  }

  // 4. Enforce total duration (only for purposes that need it)
  if (needsTotalDuration && targetDuration && targetDuration > 0) {
    const beforeEnforce = current.length;
    const beforeDuration = current.reduce(
      (sum, s) => sum + (s.endTime - s.startTime),
      0,
    );
    current = enforceTotalDuration(
      current,
      targetDuration,
      transcript,
      metadata.duration,
    );
    const afterDuration = current.reduce(
      (sum, s) => sum + (s.endTime - s.startTime),
      0,
    );

    if (current.length < beforeEnforce) {
      changes.push({
        type: "dropped",
        detail: `Dropped ${beforeEnforce - current.length} segment(s) to meet target duration (${Math.round(beforeDuration)}s → ${Math.round(afterDuration)}s, target ${Math.round(targetDuration)}s)`,
      });
    }
    if (current.length > beforeEnforce) {
      changes.push({
        type: "added",
        detail: `Added ${current.length - beforeEnforce} segment(s) to meet target duration (${Math.round(beforeDuration)}s → ${Math.round(afterDuration)}s, target ${Math.round(targetDuration)}s)`,
      });
    }
  }

  // 5. Fill gaps for FULL_VIDEO (must cover entire video)
  if (purpose === Purpose.FULL_VIDEO) {
    const beforeFill = current.length;
    const { segments: filled, gapsFilled } = fillGapsForFullVideo(
      current,
      transcript,
      metadata.duration,
    );
    current = filled;
    if (gapsFilled > 0) {
      changes.push({
        type: "added",
        detail: `Filled ${gapsFilled} gap(s) for full video coverage`,
      });
    }
    if (current.length > beforeFill) {
      console.log(
        `[StoryIQ Enforcer] FULL_VIDEO: Added ${current.length - beforeFill} segment(s) to fill gaps`,
      );
    }
  }

  return { segments: current, changes };
}

// ============================================================================
// Fill Gaps for FULL_VIDEO
// ============================================================================

/**
 * Fill all gaps for FULL_VIDEO purpose.
 * - Small gaps (5s < gap < 60s): extend an adjacent segment
 * - Large gaps (>= 60s): add new segment(s)
 * - Ensures first segment starts at 0 and last ends at videoDuration
 */
function fillGapsForFullVideo(
  segments: ProposedSegment[],
  transcript: TranscriptSegment[],
  videoDuration: number,
): { segments: ProposedSegment[]; gapsFilled: number } {
  if (segments.length === 0) {
    // No segments at all - create one covering the whole video (will be split later if needed)
    return {
      segments: [
        {
          startTime: 0,
          endTime: videoDuration,
          title: getFirstSentenceInRange(transcript, 0, 120) || "Full Video",
          reasoning: "Created by enforcer - no segments provided",
          expectedContent: "Content from this time range",
        },
      ],
      gapsFilled: 1,
    };
  }

  let result = segments.map((s) => ({ ...s })); // Deep copy
  result.sort((a, b) => a.startTime - b.startTime);
  let gapsFilled = 0;

  // 1. Handle gap at start (0 → first segment)
  if (result[0].startTime > 5) {
    const gapSize = result[0].startTime;
    if (gapSize < 60) {
      // Small gap: extend first segment backward
      console.log(
        `[StoryIQ Enforcer] FULL_VIDEO: Extending first segment backward from ${result[0].startTime.toFixed(1)}s to 0s`,
      );
      result[0].startTime = 0;
      gapsFilled++;
    } else {
      // Large gap: add new segment(s)
      const newSegs = createSegmentsForGap(0, result[0].startTime, transcript);
      result = [...newSegs, ...result];
      gapsFilled += newSegs.length;
    }
  } else if (result[0].startTime > 0) {
    // Tiny gap, just extend to 0
    result[0].startTime = 0;
  }

  // 2. Handle gaps between segments
  // Re-sort after potential additions
  result.sort((a, b) => a.startTime - b.startTime);

  let i = 0;
  while (i < result.length - 1) {
    const curr = result[i];
    const next = result[i + 1];
    const gapSize = next.startTime - curr.endTime;

    if (gapSize > 5) {
      if (gapSize < 60) {
        // Small gap: extend one of the neighbors
        // Prefer extending the shorter one (keeps segments balanced)
        const currDuration = curr.endTime - curr.startTime;
        const nextDuration = next.endTime - next.startTime;

        if (currDuration <= nextDuration && currDuration + gapSize <= 180) {
          // Extend current forward
          console.log(
            `[StoryIQ Enforcer] FULL_VIDEO: Extending "${curr.title}" forward by ${gapSize.toFixed(1)}s`,
          );
          curr.endTime = next.startTime;
          gapsFilled++;
        } else if (nextDuration + gapSize <= 180) {
          // Extend next backward
          console.log(
            `[StoryIQ Enforcer] FULL_VIDEO: Extending "${next.title}" backward by ${gapSize.toFixed(1)}s`,
          );
          next.startTime = curr.endTime;
          gapsFilled++;
        } else {
          // Both would exceed 180s, split the gap between them
          const midpoint = curr.endTime + gapSize / 2;
          console.log(
            `[StoryIQ Enforcer] FULL_VIDEO: Splitting ${gapSize.toFixed(1)}s gap between "${curr.title}" and "${next.title}"`,
          );
          curr.endTime = midpoint;
          next.startTime = midpoint;
          gapsFilled++;
        }
      } else {
        // Large gap: insert new segment(s)
        const newSegs = createSegmentsForGap(
          curr.endTime,
          next.startTime,
          transcript,
        );
        result.splice(i + 1, 0, ...newSegs);
        gapsFilled += newSegs.length;
        i += newSegs.length; // Skip past inserted segments
      }
    }
    i++;
  }

  // 3. Handle gap at end (last segment → videoDuration)
  result.sort((a, b) => a.startTime - b.startTime);
  const last = result[result.length - 1];
  if (last.endTime < videoDuration - 5) {
    const gapSize = videoDuration - last.endTime;
    if (gapSize < 60) {
      // Small gap: extend last segment forward
      console.log(
        `[StoryIQ Enforcer] FULL_VIDEO: Extending last segment forward from ${last.endTime.toFixed(1)}s to ${videoDuration.toFixed(1)}s`,
      );
      last.endTime = videoDuration;
      gapsFilled++;
    } else {
      // Large gap: add new segment(s)
      const newSegs = createSegmentsForGap(
        last.endTime,
        videoDuration,
        transcript,
      );
      result = [...result, ...newSegs];
      gapsFilled += newSegs.length;
    }
  } else if (last.endTime < videoDuration) {
    // Tiny gap, just extend to end
    last.endTime = videoDuration;
  }

  return { segments: result, gapsFilled };
}

/**
 * Create segment(s) to fill a gap. For gaps > 180s, creates multiple segments.
 */
function createSegmentsForGap(
  gapStart: number,
  gapEnd: number,
  transcript: TranscriptSegment[],
): ProposedSegment[] {
  const gapSize = gapEnd - gapStart;
  const segments: ProposedSegment[] = [];

  // How many segments do we need? Target ~90s each, max 180s
  const numSegments = Math.ceil(gapSize / 150); // ~150s target for comfortable fit under 180s
  const segmentDuration = gapSize / numSegments;

  let currentStart = gapStart;
  for (let i = 0; i < numSegments; i++) {
    const isLast = i === numSegments - 1;
    const currentEnd = isLast ? gapEnd : currentStart + segmentDuration;

    const title = getFirstSentenceInRange(transcript, currentStart, currentEnd);

    segments.push({
      startTime: currentStart,
      endTime: currentEnd,
      title: title || `Scene at ${formatTime(currentStart)}`,
      reasoning: "Added by enforcer to fill gap for full video coverage",
      expectedContent: "Content from this time range",
    });

    console.log(
      `[StoryIQ Enforcer] FULL_VIDEO: Adding segment "${segments[segments.length - 1].title}" (${currentStart.toFixed(1)}s - ${currentEnd.toFixed(1)}s)`,
    );

    currentStart = currentEnd;
  }

  return segments;
}

// ============================================================================
// Clamp to Video Duration
// ============================================================================

/**
 * Clamp all segments to the actual video duration.
 * Discards segments entirely outside the video, clamps partial segments.
 * This is critical because Claude can generate timestamps past the video end
 * during revision (especially for well-known content where it "remembers" more scenes).
 */
function clampToVideoDuration(
  segments: ProposedSegment[],
  videoDuration: number,
): ProposedSegment[] {
  const clamped: ProposedSegment[] = [];

  for (const seg of segments) {
    // Skip segments that start at or past the video end
    if (seg.startTime >= videoDuration) {
      console.log(
        `[StoryIQ Enforcer] Discarding segment "${seg.title}" - starts at ${Math.round(seg.startTime)}s, past video end ${Math.round(videoDuration)}s`,
      );
      continue;
    }

    // Clamp start time
    const startTime = Math.max(0, seg.startTime);

    // Clamp end time
    const endTime = Math.min(seg.endTime, videoDuration);

    // Ensure segment is still long enough after clamping
    if (endTime - startTime < 5) {
      console.log(
        `[StoryIQ Enforcer] Discarding segment "${seg.title}" - too short after clamping (${Math.round(endTime - startTime)}s)`,
      );
      continue;
    }

    clamped.push({ ...seg, startTime, endTime });
  }

  if (clamped.length < segments.length) {
    console.warn(
      `[StoryIQ Enforcer] Clamped ${segments.length - clamped.length} segment(s) that exceeded video duration of ${Math.round(videoDuration)}s`,
    );
  }

  return clamped;
}

// ============================================================================
// Overlap Resolution
// ============================================================================

/**
 * Deterministically resolve overlapping segments by splitting at the midpoint
 * of the overlap, snapping to the nearest word boundary if transcript is available.
 *
 * @param segments - The segments to fix
 * @param transcript - Optional transcript for word boundary snapping
 * @returns Segments with no overlaps
 */
export function resolveOverlaps(
  segments: ProposedSegment[],
  transcript?: TranscriptSegment[],
): ProposedSegment[] {
  if (segments.length <= 1) return segments;

  // Sort by start time
  const sorted = [...segments].sort((a, b) => a.startTime - b.startTime);
  const resolved = sorted.map((s) => ({ ...s })); // Deep copy

  for (let i = 1; i < resolved.length; i++) {
    const prev = resolved[i - 1];
    const curr = resolved[i];

    if (curr.startTime < prev.endTime) {
      // Overlap detected - split at midpoint
      const overlapMid = (prev.endTime + curr.startTime) / 2;

      // Try to snap to nearest word boundary
      let splitPoint = overlapMid;
      if (transcript && transcript.length > 0) {
        splitPoint = findNearestWordBoundary(overlapMid, transcript);
      }

      // Ensure split point is between the two segments' non-overlapping regions
      // prev must keep at least its startTime + 5s
      // curr must keep at least 5s before its endTime
      const minSplit = prev.startTime + 5;
      const maxSplit = curr.endTime - 5;
      splitPoint = Math.max(minSplit, Math.min(maxSplit, splitPoint));

      prev.endTime = splitPoint;
      curr.startTime = splitPoint;

      console.log(
        `[StoryIQ Enforcer] Resolved overlap: "${prev.title}" now ends at ${splitPoint.toFixed(1)}s, "${curr.title}" now starts at ${splitPoint.toFixed(1)}s`,
      );
    }
  }

  // Remove any segments that became too short (< 5s) after adjustment
  return resolved.filter((s) => s.endTime - s.startTime >= 5);
}

/**
 * Find the nearest word end time to a target timestamp.
 * Used for snapping overlap split points to word boundaries.
 */
function findNearestWordBoundary(
  target: number,
  transcript: TranscriptSegment[],
): number {
  let closest = target;
  let minDist = Infinity;

  for (const seg of transcript) {
    const dist = Math.abs(seg.endTime - target);
    if (dist < minDist) {
      minDist = dist;
      closest = seg.endTime;
    }
    // Also check start times
    const startDist = Math.abs(seg.startTime - target);
    if (startDist < minDist) {
      minDist = startDist;
      closest = seg.startTime;
    }
  }

  return closest;
}

// ============================================================================
// Split Oversized Segments
// ============================================================================

/**
 * Split any segments exceeding maxDuration into smaller pieces.
 * Splits at sentence boundaries when possible, falling back to word boundaries.
 * This is the programmatic safety net for when Claude leaves oversized segments
 * (e.g., a 656s "End Credits" segment that should have been split during revision).
 */
function splitOversizedSegments(
  segments: ProposedSegment[],
  transcript: TranscriptSegment[],
  maxDuration: number = 180,
): ProposedSegment[] {
  const result: ProposedSegment[] = [];

  for (const seg of segments) {
    const duration = seg.endTime - seg.startTime;

    if (duration <= maxDuration) {
      result.push(seg);
      continue;
    }

    // How many pieces do we need?
    const numParts = Math.ceil(duration / maxDuration);
    const targetPartDuration = duration / numParts;

    console.log(
      `[StoryIQ Enforcer] Splitting "${seg.title}" (${Math.round(duration)}s) into ${numParts} segments (~${Math.round(targetPartDuration)}s each)`,
    );

    let currentStart = seg.startTime;
    for (let p = 0; p < numParts; p++) {
      const isLast = p === numParts - 1;
      let partEnd = isLast ? seg.endTime : currentStart + targetPartDuration;

      // Snap to sentence/word boundary if not the last piece
      if (!isLast && transcript.length > 0) {
        partEnd = findBestSplitPoint(
          currentStart,
          partEnd,
          seg.endTime,
          transcript,
          60, // min segment duration
        );
      }

      // Generate a title from transcript content, or fall back to "(Part N)" suffix
      const partTitle =
        numParts <= 1
          ? seg.title
          : getFirstSentenceInRange(transcript, currentStart, partEnd) ||
            `${seg.title} (Part ${p + 1})`;

      result.push({
        startTime: currentStart,
        endTime: partEnd,
        title: partTitle,
        reasoning:
          p === 0
            ? seg.reasoning
            : `Continuation of "${seg.title}" - split to meet duration limits`,
        expectedContent: seg.expectedContent || "Content from this time range",
      });

      currentStart = partEnd;
    }
  }

  if (result.length > segments.length) {
    console.log(
      `[StoryIQ Enforcer] Split oversized segments: ${segments.length} → ${result.length} segments`,
    );
  }

  return result;
}

/**
 * Find the best timestamp to split a segment, preferring sentence boundaries.
 * Looks for sentence-ending punctuation (.?!) in transcript near the target split point,
 * then falls back to the nearest word boundary.
 *
 * @param segStart - Start of the current segment (to enforce minimum duration)
 * @param target - The ideal split point
 * @param segEnd - End of the original segment (to enforce minimum remainder)
 * @param transcript - Transcript segments for boundary snapping
 * @param minPartDuration - Minimum duration for each resulting part (default 60s)
 */
function findBestSplitPoint(
  segStart: number,
  target: number,
  segEnd: number,
  transcript: TranscriptSegment[],
  minPartDuration: number = 60,
): number {
  // Hard bounds: each side must be at least minPartDuration
  const minSplit = segStart + minPartDuration;
  const maxSplit = segEnd - minPartDuration;

  if (minSplit >= maxSplit) {
    // Can't satisfy both - just split at target
    return Math.max(segStart + 5, Math.min(segEnd - 5, target));
  }

  const clampedTarget = Math.max(minSplit, Math.min(maxSplit, target));

  // Search window: +/- 15 seconds around the target
  const searchStart = Math.max(minSplit, clampedTarget - 15);
  const searchEnd = Math.min(maxSplit, clampedTarget + 15);

  // First pass: look for sentence boundaries (punctuation at end of text)
  let bestSentence: number | null = null;
  let bestSentenceDist = Infinity;

  for (const seg of transcript) {
    if (seg.endTime >= searchStart && seg.endTime <= searchEnd) {
      const text = seg.text.trim();
      if (text.match(/[.?!]$/)) {
        const dist = Math.abs(seg.endTime - clampedTarget);
        if (dist < bestSentenceDist) {
          bestSentenceDist = dist;
          bestSentence = seg.endTime;
        }
      }
    }
  }

  if (bestSentence !== null) {
    return bestSentence;
  }

  // Second pass: nearest word boundary
  return findNearestWordBoundary(clampedTarget, transcript);
}

// ============================================================================
// Total Duration Enforcement
// ============================================================================

/**
 * Enforce total duration by dropping or adding segments.
 * Called as a last resort after the tool conversation.
 *
 * If over: drop shortest eligible middle segments (deterministic)
 * If under: add segments in largest gaps using transcript data
 *
 * @param videoDuration - Total video length in seconds (required to find gaps at start/end)
 */
export function enforceTotalDuration(
  segments: ProposedSegment[],
  targetDuration: number,
  transcript: TranscriptSegment[],
  videoDuration: number,
): ProposedSegment[] {
  if (!targetDuration || targetDuration <= 0 || segments.length === 0) {
    return segments;
  }

  let result = segments.map((s) => ({ ...s })); // Deep copy

  // --- OVER TARGET: drop segments ---
  const MAX_DROP_ITERATIONS = 20; // Safety valve
  let dropIterations = 0;
  while (dropIterations < MAX_DROP_ITERATIONS) {
    const total = result.reduce((sum, s) => sum + (s.endTime - s.startTime), 0);
    if (total <= targetDuration * 1.15) break; // Within 15% tolerance
    if (result.length <= 1) break; // Can't drop the only segment

    const dropped = dropOneSegment(result);
    if (dropped.length === result.length) break; // Nothing was dropped (safety)
    result = dropped;
    dropIterations++;
  }

  if (dropIterations > 0) {
    console.warn(
      `[StoryIQ Enforcer] Dropped ${dropIterations} segment(s) to meet total duration target`,
    );
  }

  // --- UNDER TARGET: add segments in gaps ---
  const MAX_ADD_ITERATIONS = 20; // Safety valve
  let addIterations = 0;
  while (addIterations < MAX_ADD_ITERATIONS) {
    const total = result.reduce((sum, s) => sum + (s.endTime - s.startTime), 0);
    if (total >= targetDuration * 0.85) break; // Within 15% tolerance

    const added = addOneSegment(result, transcript, videoDuration);
    if (added.length === result.length) break; // No gap large enough
    result = added;
    addIterations++;
  }

  if (addIterations > 0) {
    console.warn(
      `[StoryIQ Enforcer] Added ${addIterations} segment(s) to meet total duration target`,
    );
  }

  return result;
}

/**
 * Drop one segment from the list (deterministic).
 * Rules:
 * - Never drop first or last (unless <= 3 segments)
 * - Always drop the shortest eligible middle segment
 *   (deterministic — same input always produces same output)
 */
function dropOneSegment(segments: ProposedSegment[]): ProposedSegment[] {
  if (segments.length <= 1) return segments;

  // Determine eligible indices
  let eligible: number[] = [];
  if (segments.length <= 3) {
    // Small set: all segments are eligible
    eligible = segments.map((_, i) => i);
  } else {
    // Skip first and last
    eligible = segments
      .map((_, i) => i)
      .filter((i) => i > 0 && i < segments.length - 1);
  }

  if (eligible.length === 0) return segments;

  // Sort eligible by duration (shortest first) — deterministic tiebreaker by index
  eligible.sort((a, b) => {
    const durA = segments[a].endTime - segments[a].startTime;
    const durB = segments[b].endTime - segments[b].startTime;
    if (Math.abs(durA - durB) < 0.01) return a - b; // stable tiebreaker
    return durA - durB;
  });

  // Always drop the shortest eligible segment (deterministic)
  const dropIdx = eligible[0];

  console.log(
    `[StoryIQ Enforcer] Dropping segment ${dropIdx + 1}: "${segments[dropIdx].title}" (${Math.round(segments[dropIdx].endTime - segments[dropIdx].startTime)}s)`,
  );

  return segments.filter((_, i) => i !== dropIdx);
}

/**
 * Add one segment in the largest gap (including before first and after last segment).
 * Uses transcript to get a title from the first sentence in the gap.
 *
 * @param videoDuration - Total video length to detect gap after last segment
 */
function addOneSegment(
  segments: ProposedSegment[],
  transcript: TranscriptSegment[],
  videoDuration: number,
): ProposedSegment[] {
  // Sort segments by start time
  const sorted = [...segments].sort((a, b) => a.startTime - b.startTime);

  // Find ALL gaps: before first, between segments, and after last
  const gaps: { start: number; end: number; size: number }[] = [];

  // Gap before first segment (0 → first.startTime)
  if (sorted.length === 0) {
    // No segments at all — entire video is a gap
    if (videoDuration >= 60) {
      gaps.push({ start: 0, end: videoDuration, size: videoDuration });
    }
  } else {
    // Gap before first segment
    if (sorted[0].startTime >= 60) {
      gaps.push({
        start: 0,
        end: sorted[0].startTime,
        size: sorted[0].startTime,
      });
    }

    // Gaps between segments
    for (let i = 1; i < sorted.length; i++) {
      const gapStart = sorted[i - 1].endTime;
      const gapEnd = sorted[i].startTime;
      if (gapEnd - gapStart >= 60) {
        gaps.push({ start: gapStart, end: gapEnd, size: gapEnd - gapStart });
      }
    }

    // Gap after last segment (last.endTime → videoDuration)
    const lastEnd = sorted[sorted.length - 1].endTime;
    if (videoDuration - lastEnd >= 60) {
      gaps.push({
        start: lastEnd,
        end: videoDuration,
        size: videoDuration - lastEnd,
      });
    }
  }

  if (gaps.length === 0) {
    console.log("[StoryIQ Enforcer] No gaps >= 60s found, cannot add segments");
    return segments; // No valid gaps
  }

  // Pick the largest gap
  gaps.sort((a, b) => b.size - a.size);
  const gap = gaps[0];

  // Create segment: fill the gap (max 120s, from gap start)
  const segDuration = Math.min(120, gap.size);
  const segStart = gap.start;
  const segEnd = Math.min(gap.end, gap.start + segDuration);

  // Try to get a title from transcript
  const title = getFirstSentenceInRange(transcript, segStart, segEnd);

  const newSegment: ProposedSegment = {
    startTime: segStart,
    endTime: segEnd,
    title: title || `Scene at ${formatTime(segStart)}`,
    reasoning: "Added by enforcer to meet target duration",
    expectedContent: "Content from this time range",
  };

  console.log(
    `[StoryIQ Enforcer] Adding segment: "${newSegment.title}" (${Math.round(segStart)}s - ${Math.round(segEnd)}s, ${Math.round(segDuration)}s)`,
  );

  // Insert in sorted order
  const result = [...segments, newSegment].sort(
    (a, b) => a.startTime - b.startTime,
  );
  return result;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get the first sentence from transcript within a time range for use as a title.
 */
function getFirstSentenceInRange(
  transcript: TranscriptSegment[],
  start: number,
  end: number,
): string | null {
  const words: string[] = [];

  for (const seg of transcript) {
    if (seg.startTime >= start && seg.startTime < end) {
      const text = seg.text.trim();
      if (text) {
        words.push(text);
        // Stop at first sentence-ending punctuation
        if (text.match(/[.?!]$/)) break;
        // Limit to ~10 words for a title
        if (words.length >= 10) break;
      }
    }
  }

  if (words.length === 0) return null;

  const sentence = words.join(" ");
  // Truncate to reasonable title length
  return sentence.length > 60 ? sentence.substring(0, 57) + "..." : sentence;
}

/**
 * Simple time formatter for titles: M:SS
 */
function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
