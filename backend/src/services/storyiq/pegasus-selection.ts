/**
 * Pegasus Segment Selection
 *
 * Scored selection of segments toward a target duration.
 * Sports uses replay detection; this is for serialized_scifi and generic.
 */

import type { ContentType, ProposedSegment } from "./types";
import { Purpose } from "./types";

export interface SelectionOptions {
  targetDuration: number;
  contentType: ContentType;
  purpose?: Purpose;
  lowerBoundMultiplier?: number;
  upperBoundMultiplier?: number;
}

export interface ScoredSegment extends ProposedSegment {
  /** Computed selection score (0–1) */
  selectionScore: number;
  /** Raw metadata from Pegasus (profile-specific fields) */
  pegasusMetadata?: Record<string, unknown>;
}

export interface SelectionResult {
  /** Selected segments in chronological order */
  selected: ProposedSegment[];
  /** Segments that were not selected */
  dropped: ProposedSegment[];
  /** Total duration of selected segments */
  totalDuration: number;
  /** Whether the selection hit the target band */
  hitTargetBand: boolean;
  /** Scoring details for debugging */
  scoringNotes: string[];
}

// ============================================================================
// Scoring Functions (Profile-Specific)
// ============================================================================

/**
 * Score a segment for qlio_microseries (compact) metadata.
 */
function scoreMicroseriesSegment(meta: Record<string, unknown>): number {
  let score = 0.5;

  const role = String(meta.narrative_role || "").toLowerCase();
  if (role === "main_story") score += 0.25;
  else if (role === "secondary_story") score += 0.12;
  else if (role === "subplot") score -= 0.15;
  else if (role === "filler" || role === "transition") score -= 0.25;

  if (String(meta.microseries_keep || "").toLowerCase() === "yes") score += 0.08;

  // primary_storyline: A > B > multiple > C (C-plots deprioritized for compact)
  const storyline = String(meta.primary_storyline || "").toUpperCase();
  if (storyline === "A") score += 0.2;
  else if (storyline === "B") score += 0.1;
  else if (storyline === "MULTIPLE") score += 0.05;
  else if (storyline === "C") score -= 0.2;

  const clipFit = String(meta.clip_fit || "").toLowerCase();
  if (clipFit === "strong") score += 0.15;
  else if (clipFit === "weak") score -= 0.1;

  if (meta.vertical_hook_potential && String(meta.vertical_hook_potential).length > 10) {
    score += 0.1;
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Score a segment for episode recap metadata.
 * New schema: story_function (setup | escalation | pivot | payoff)
 * Legacy schema: recap_importance (essential | helpful | skip)
 */
function scoreRecapSegment(meta: Record<string, unknown>): number {
  let score = 0.5;

  // New schema: story_function
  const storyFunction = String(meta.story_function || "").toLowerCase();
  if (storyFunction === "payoff") score += 0.3;
  else if (storyFunction === "pivot") score += 0.25;
  else if (storyFunction === "escalation") score += 0.15;
  else if (storyFunction === "setup") score += 0.05;
  // Legacy schema: recap_importance (backward compat for existing data)
  else {
    const importance = String(meta.recap_importance || "").toLowerCase();
    if (importance === "essential") score += 0.35;
    else if (importance === "helpful") score += 0.12;
    else if (importance === "skip") score -= 0.35;
  }

  if (String(meta.recap_keep || "").toLowerCase() === "yes") score += 0.1;

  return Math.max(0, Math.min(1, score));
}

/**
 * Score a segment for generic content (legacy clip_fit fields).
 */
function scoreGenericSegment(meta: Record<string, unknown>): number {
  let score = 0.5;

  const clipFit = String(meta.clip_fit || "").toLowerCase();
  if (clipFit === "strong") score += 0.3;
  else if (clipFit === "moderate") score += 0.1;
  else if (clipFit === "weak") score -= 0.1;

  if (meta.vertical_hook_potential && String(meta.vertical_hook_potential).length > 10) {
    score += 0.1;
  }

  const storyline = String(meta.primary_storyline || "").toUpperCase();
  if (storyline === "A") score += 0.1;
  else if (storyline === "C") score -= 0.15;

  return Math.max(0, Math.min(1, score));
}

/**
 * Score a segment for serialized sci-fi (Trek-style) content.
 * Uses: primary_storyline, plot_function, clip_fit, vertical_hook_potential
 */
function scoreTrekSegment(meta: Record<string, unknown>): number {
  let score = 0.5; // Base score

  // primary_storyline: A > B > multiple > C
  const storyline = String(meta.primary_storyline || "").toUpperCase();
  if (storyline === "A") score += 0.2;
  else if (storyline === "B") score += 0.1;
  else if (storyline === "MULTIPLE") score += 0.05;
  else if (storyline === "C") score -= 0.2; // C-plots deprioritized for compact

  // plot_function: climax and conflict score higher
  const plotFunction = String(meta.plot_function || "").toLowerCase();
  if (plotFunction === "climax") score += 0.2;
  else if (plotFunction === "conflict") score += 0.15;
  else if (plotFunction === "resolution") score += 0.1;
  else if (plotFunction === "transition") score -= 0.1;

  // clip_fit: same as generic
  const clipFit = String(meta.clip_fit || "").toLowerCase();
  if (clipFit === "strong") score += 0.15;
  else if (clipFit === "weak") score -= 0.15;

  // vertical_hook_potential: presence is a positive signal
  if (meta.vertical_hook_potential && String(meta.vertical_hook_potential).length > 10) {
    score += 0.1;
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Score a segment based on content type.
 */
export function scoreSegment(
  segment: ProposedSegment,
  contentType: ContentType,
  metadata?: Record<string, unknown>,
  purpose?: Purpose,
): number {
  const meta = metadata || {};

  if (purpose === Purpose.EPISODE_RECAP || meta.story_function != null || meta.recap_importance != null) {
    return scoreRecapSegment(meta);
  }

  if (meta.narrative_role != null || meta.microseries_keep != null) {
    return scoreMicroseriesSegment(meta);
  }

  switch (contentType) {
    case "serialized_scifi":
      return scoreTrekSegment(meta);
    default:
      return scoreGenericSegment(meta);
  }
}

// ============================================================================
// Selection Algorithm
// ============================================================================

/**
 * Select segments chronologically toward a target duration band.
 *
 * Algorithm:
 * 1. Score all segments
 * 2. Sort by chronological order (preserve narrative)
 * 3. Use a greedy approach: include segments that maximize score while staying in band
 * 4. For HIGHLIGHTS/COMPACT: prioritize high-scoring segments
 * 5. For FULL_VIDEO: include all (selection not applicable)
 */
export function selectSegmentsForTarget(
  candidates: ProposedSegment[],
  options: SelectionOptions,
  pegasusMetadata?: Map<number, Record<string, unknown>>,
): SelectionResult {
  const {
    targetDuration,
    contentType,
    purpose,
    lowerBoundMultiplier = 0.85,
    upperBoundMultiplier = 1.15,
  } = options;

  const lowerBound = targetDuration * lowerBoundMultiplier;
  const upperBound = targetDuration * upperBoundMultiplier;

  const scoringNotes: string[] = [
    `Target: ${Math.round(targetDuration)}s (band: ${Math.round(lowerBound)}–${Math.round(upperBound)}s)`,
    `ContentType: ${contentType}`,
  ];

  // Edge case: no candidates
  if (candidates.length === 0) {
    return {
      selected: [],
      dropped: [],
      totalDuration: 0,
      hitTargetBand: false,
      scoringNotes: [...scoringNotes, "No candidates provided"],
    };
  }

  // Score all segments
  const scored: ScoredSegment[] = candidates.map((seg, idx) => {
    const meta = pegasusMetadata?.get(idx) || {};
    const selectionScore = scoreSegment(seg, contentType, meta, purpose);
    return { ...seg, selectionScore, pegasusMetadata: meta };
  });

  // Sort chronologically (by startTime)
  scored.sort((a, b) => a.startTime - b.startTime);

  // Calculate total available duration
  const totalAvailable = scored.reduce(
    (sum, s) => sum + (s.endTime - s.startTime),
    0,
  );
  scoringNotes.push(`Total available: ${Math.round(totalAvailable)}s from ${scored.length} segments`);

  // If total available is less than lower bound, include everything
  if (totalAvailable <= lowerBound) {
    scoringNotes.push("Including all segments (total < lower bound)");
    return {
      selected: scored.map(stripScore),
      dropped: [],
      totalDuration: totalAvailable,
      hitTargetBand: totalAvailable >= lowerBound,
      scoringNotes,
    };
  }

  // Greedy selection: prefer high-scoring segments while maintaining chronological order
  // Strategy: mark segments as "must include" vs "optional" based on score threshold,
  // then fill toward target

  const scoreThresholdHigh = 0.6; // Must-include threshold
  const scoreThresholdLow = 0.3; // Drop threshold

  const mustInclude = scored.filter((s) => s.selectionScore >= scoreThresholdHigh);
  const optional = scored.filter(
    (s) => s.selectionScore >= scoreThresholdLow && s.selectionScore < scoreThresholdHigh,
  );
  const lowPriority = scored.filter((s) => s.selectionScore < scoreThresholdLow);

  let selected: ScoredSegment[] = [];
  let currentDuration = 0;

  // Phase 1: Include all must-include segments
  for (const seg of mustInclude) {
    selected.push(seg);
    currentDuration += seg.endTime - seg.startTime;
  }
  scoringNotes.push(`Must-include: ${mustInclude.length} segments (${Math.round(currentDuration)}s)`);

  // Phase 2: Add optional segments until we approach upper bound
  const optionalSortedByScore = [...optional].sort(
    (a, b) => b.selectionScore - a.selectionScore,
  );

  for (const seg of optionalSortedByScore) {
    const segDuration = seg.endTime - seg.startTime;
    if (currentDuration + segDuration <= upperBound) {
      selected.push(seg);
      currentDuration += segDuration;
    }
  }
  scoringNotes.push(`After optional: ${selected.length} segments (${Math.round(currentDuration)}s)`);

  // Phase 3: If still under lower bound, add low-priority segments
  if (currentDuration < lowerBound) {
    const lowSortedByScore = [...lowPriority].sort(
      (a, b) => b.selectionScore - a.selectionScore,
    );
    for (const seg of lowSortedByScore) {
      const segDuration = seg.endTime - seg.startTime;
      if (currentDuration + segDuration <= upperBound) {
        selected.push(seg);
        currentDuration += segDuration;
      }
      if (currentDuration >= lowerBound) break;
    }
    scoringNotes.push(`After low-priority fill: ${selected.length} segments (${Math.round(currentDuration)}s)`);
  }

  // Phase 4: If over upper bound, trim from lowest-scoring included segments
  if (currentDuration > upperBound) {
    // Sort selected by score ascending (lowest first)
    const sortedByScoreAsc = [...selected].sort(
      (a, b) => a.selectionScore - b.selectionScore,
    );

    const toKeep = new Set<ScoredSegment>();
    let keepDuration = 0;

    // Build from highest-scoring segments down
    for (let i = sortedByScoreAsc.length - 1; i >= 0; i--) {
      const seg = sortedByScoreAsc[i];
      const segDuration = seg.endTime - seg.startTime;
      if (keepDuration + segDuration <= upperBound) {
        toKeep.add(seg);
        keepDuration += segDuration;
      }
    }

    selected = selected.filter((s) => toKeep.has(s));
    currentDuration = keepDuration;
    scoringNotes.push(`After trimming: ${selected.length} segments (${Math.round(currentDuration)}s)`);
  }

  // Re-sort selected chronologically
  selected.sort((a, b) => a.startTime - b.startTime);

  // Determine dropped segments
  const selectedSet = new Set(selected);
  const dropped = scored.filter((s) => !selectedSet.has(s));

  const hitTargetBand = currentDuration >= lowerBound && currentDuration <= upperBound;
  scoringNotes.push(`Hit target band: ${hitTargetBand}`);

  return {
    selected: selected.map(stripScore),
    dropped: dropped.map(stripScore),
    totalDuration: currentDuration,
    hitTargetBand,
    scoringNotes,
  };
}

/**
 * Strip internal scoring fields from a segment before returning.
 */
function stripScore(seg: ScoredSegment): ProposedSegment {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { selectionScore, pegasusMetadata, ...rest } = seg;
  return rest;
}

// ============================================================================
// Utility: Attach Pegasus Metadata to Segments
// ============================================================================

/**
 * Create a metadata map from Pegasus rows, indexed by segment index.
 * Used to pass profile-specific fields to the scorer.
 */
export function buildPegasusMetadataMap(
  rows: Array<{ start_time: number; end_time: number; metadata: Record<string, unknown> }>,
): Map<number, Record<string, unknown>> {
  const map = new Map<number, Record<string, unknown>>();
  rows.forEach((row, idx) => {
    map.set(idx, row.metadata);
  });
  return map;
}
