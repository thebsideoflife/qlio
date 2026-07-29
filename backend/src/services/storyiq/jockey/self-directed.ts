/**
 * Jockey v3 — self-directed cutting (SPEC-jockey-v3-self-directed-cuts.md).
 *
 * Deterministic code in this module is limited to what §4 of the spec allows:
 *   - clamp times to [0, videoDuration]
 *   - de-duplicate identical returned rows
 *   - validate the result with typed issues (for the re-ask loop)
 *   - map Jockey output → ProposedSegment[]
 *
 * It must NEVER split, trim, backfill, or snap cut points. Cut placement is
 * Jockey's job; on validation failure the pipeline re-asks Jockey with the
 * issues produced here.
 */

import { z } from "zod";
import type { ProposedSegment } from "../types";

// ============================================================================
// Constants (acceptance criteria — SPEC §6)
// ============================================================================

/** Max distance between a cut edge and a Jockey-reported scene change. */
export const SCENE_EDGE_TOLERANCE_SEC = 2;

/** Compact total must land within target × [0.9, 1.1] → 45–55% at the default 50% target. */
export const COMPACT_BAND_LOWER_MULT = 0.9;
export const COMPACT_BAND_UPPER_MULT = 1.1;

export const RECAP_MIN_TOTAL_SEC = 60;
export const RECAP_MAX_TOTAL_SEC = 90;
export const RECAP_MIN_BEATS = 4;
export const RECAP_MAX_BEATS = 6;

/** Quartile spread is required on sources longer than this (compact only). */
export const QUARTILE_SPREAD_MIN_SOURCE_SEC = 45 * 60;

/** Distance under which a cut edge counts as sitting on an internal seam. */
export const SEAM_TOLERANCE_SEC = 1;

// ============================================================================
// Jockey response contract
// ============================================================================

export const SelfDirectedCutSchema = z.object({
  startTime: z.number(),
  endTime: z.number(),
  title: z.string().min(1),
  description: z.string(),
  narrativeRole: z.string().nullish(),
  /**
   * Why these exact in/out points — forces edge-level deliberation so cuts
   * are timed on rich moments instead of rounded zone spans.
   */
  edgeReason: z.string().nullish(),
});

export type SelfDirectedCut = z.infer<typeof SelfDirectedCutSchema>;

export const SelfDirectedCutsSchema = z.object({
  segments: z.array(SelfDirectedCutSchema),
  /**
   * Scene-change timestamps (seconds, source timeline) Jockey identified while
   * exploring. Every cut edge must land on one of these within tolerance.
   */
  sceneBoundaries: z.array(z.number()),
  logline: z.string().nullish(),
  editorNotes: z.string().nullish(),
});

export type SelfDirectedCuts = z.infer<typeof SelfDirectedCutsSchema>;

/** JSON schema handed to the Agents API structured-output endpoint. */
export const SELF_DIRECTED_CUTS_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          startTime: { type: "number" },
          endTime: { type: "number" },
          title: { type: "string" },
          description: { type: "string" },
          narrativeRole: { type: "string" },
          edgeReason: { type: "string" },
        },
        required: ["startTime", "endTime", "title", "description"],
      },
    },
    sceneBoundaries: { type: "array", items: { type: "number" } },
    logline: { type: "string" },
    editorNotes: { type: "string" },
  },
  required: ["segments", "sceneBoundaries"],
};

// ============================================================================
// Typed validation issues
// ============================================================================

export type V3IssueCode =
  | "no_segments"
  | "invalid_response"
  | "cut_artifact"
  | "overlap"
  | "duration_band"
  | "beat_count"
  | "quartile_coverage"
  | "missing_scene_boundaries"
  | "edge_off_scene_boundary"
  | "seam_cut"
  | "segment_duration"
  | "title_artifact";

export interface V3Issue {
  code: V3IssueCode;
  message: string;
}

/**
 * Structural failures that make a pass unshippable. Everything else is
 * editorial feedback: it drives the re-ask loop, but if Jockey never produces
 * a perfectly clean pass, the best structurally-valid pass still ships
 * (with the outstanding issues recorded in notes).
 */
const BLOCKING_ISSUE_CODES: ReadonlySet<V3IssueCode> = new Set([
  "no_segments",
  "invalid_response",
  "cut_artifact",
  "overlap",
]);

export function isBlockingIssue(issue: V3Issue): boolean {
  return BLOCKING_ISSUE_CODES.has(issue.code);
}

export type JockeyV3PurposeKey = "compact_video" | "episode_recap";

// ============================================================================
// Safety clamps (allowed deterministic operations only)
// ============================================================================

export interface ClampResult {
  segments: SelfDirectedCut[];
  notes: string[];
}

/**
 * Clamp cut times to [0, videoDuration], drop exact duplicate rows, and sort
 * chronologically. This is the ONLY reshaping code is allowed to do — no
 * splitting, trimming to target, or boundary snapping.
 */
export function applySafetyClamps(
  cuts: SelfDirectedCut[],
  videoDurationSec: number,
): ClampResult {
  const notes: string[] = [];
  const seen = new Set<string>();
  const result: SelfDirectedCut[] = [];

  for (const cut of cuts) {
    const startTime = Math.min(Math.max(cut.startTime, 0), videoDurationSec);
    const endTime = Math.min(Math.max(cut.endTime, 0), videoDurationSec);
    if (startTime !== cut.startTime || endTime !== cut.endTime) {
      notes.push(
        `Clamped "${cut.title}" ${cut.startTime.toFixed(1)}–${cut.endTime.toFixed(1)}s → ${startTime.toFixed(1)}–${endTime.toFixed(1)}s`,
      );
    }

    const key = `${startTime.toFixed(2)}-${endTime.toFixed(2)}`;
    if (seen.has(key)) {
      notes.push(`Dropped duplicate row ${key} ("${cut.title}")`);
      continue;
    }
    seen.add(key);
    result.push({ ...cut, startTime, endTime });
  }

  result.sort((a, b) => a.startTime - b.startTime);
  return { segments: result, notes };
}

// ============================================================================
// Deterministic validation gates (validate, don't repair — SPEC §4.4)
// ============================================================================

export interface ValidateSelfDirectedOptions {
  purpose: JockeyV3PurposeKey;
  videoDurationSec: number;
  /** Requested compact total in seconds (band = ×0.9–×1.1). */
  targetSeconds: number;
  /** Producer-requested per-segment bounds (compact only). Enforced per segment. */
  minSegmentDurationSec?: number;
  maxSegmentDurationSec?: number;
  /** Known internal chunk/window seams, if any. Empty for single-pass uploads. */
  seamTimestampsSec?: number[];
}

const TITLE_ARTIFACT_PATTERNS = [/\(part\s*\d+\)/i, /\(\d+\)\s*$/];

function nearestDistance(value: number, candidates: number[]): number {
  let best = Infinity;
  for (const c of candidates) {
    const d = Math.abs(value - c);
    if (d < best) best = d;
  }
  return best;
}

export function validateSelfDirectedCuts(
  cuts: SelfDirectedCuts,
  options: ValidateSelfDirectedOptions,
): V3Issue[] {
  const { purpose, videoDurationSec, targetSeconds } = options;
  const issues: V3Issue[] = [];
  const segments = cuts.segments;

  if (segments.length === 0) {
    return [{ code: "no_segments", message: "No segments returned" }];
  }

  // --- Cut artifacts: zero/negative length ---
  for (const s of segments) {
    if (s.endTime - s.startTime <= 0) {
      issues.push({
        code: "cut_artifact",
        message: `"${s.title}" [${s.startTime.toFixed(1)}–${s.endTime.toFixed(1)}s] has zero or negative length`,
      });
    }
  }

  // --- Overlaps (segments assumed chronologically sorted by clamp step) ---
  const sorted = [...segments].sort((a, b) => a.startTime - b.startTime);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startTime < sorted[i - 1].endTime - 0.05) {
      issues.push({
        code: "overlap",
        message:
          `"${sorted[i - 1].title}" (ends ${sorted[i - 1].endTime.toFixed(1)}s) overlaps ` +
          `"${sorted[i].title}" (starts ${sorted[i].startTime.toFixed(1)}s)`,
      });
    }
  }

  // --- Duration band + beat count ---
  const total = segments.reduce((sum, s) => sum + (s.endTime - s.startTime), 0);
  if (purpose === "episode_recap") {
    if (segments.length < RECAP_MIN_BEATS || segments.length > RECAP_MAX_BEATS) {
      issues.push({
        code: "beat_count",
        message: `Recap has ${segments.length} beats — must be ${RECAP_MIN_BEATS}–${RECAP_MAX_BEATS}`,
      });
    }
    if (total < RECAP_MIN_TOTAL_SEC || total > RECAP_MAX_TOTAL_SEC) {
      issues.push({
        code: "duration_band",
        message: `Recap total ${Math.round(total)}s — must be ${RECAP_MIN_TOTAL_SEC}–${RECAP_MAX_TOTAL_SEC}s`,
      });
    }
  } else {
    const lower = targetSeconds * COMPACT_BAND_LOWER_MULT;
    const upper = targetSeconds * COMPACT_BAND_UPPER_MULT;
    if (total < lower || total > upper) {
      issues.push({
        code: "duration_band",
        message:
          `Compact total ${Math.round(total)}s outside ${Math.round(lower)}–${Math.round(upper)}s ` +
          `(target ~${Math.round(targetSeconds)}s). Adjust which scenes you keep — do not pad or clip mid-scene.`,
      });
    }

    // --- Per-segment duration bounds (producer's min/max, when provided) ---
    // Editorial gate: drives the re-ask loop. Catches the "find a zone, coast
    // to max length" failure mode — a segment at/over the max is presumed
    // padded unless Jockey re-times it tight.
    const minSeg = options.minSegmentDurationSec;
    const maxSeg = options.maxSegmentDurationSec;
    if (minSeg || maxSeg) {
      for (const s of segments) {
        const dur = s.endTime - s.startTime;
        if (maxSeg && dur > maxSeg + 0.5) {
          issues.push({
            code: "segment_duration",
            message:
              `"${s.title}" runs ${Math.round(dur)}s — over the ${Math.round(maxSeg)}s max. ` +
              `Tighten the out-point to where the moment lands instead of holding the zone.`,
          });
        }
        if (minSeg && dur < minSeg - 0.5) {
          issues.push({
            code: "segment_duration",
            message:
              `"${s.title}" runs ${Math.round(dur)}s — under the ${Math.round(minSeg)}s min. ` +
              `Open earlier on the build-up or fold it into a neighboring segment.`,
          });
        }
      }
    }

    // --- Quartile spread on long sources ---
    if (videoDurationSec > QUARTILE_SPREAD_MIN_SOURCE_SEC) {
      const q = videoDurationSec / 4;
      const emptyQuartiles: number[] = [];
      for (let qi = 0; qi < 4; qi++) {
        const qStart = q * qi;
        const qEnd = q * (qi + 1);
        const has = segments.some((s) => {
          const m = (s.startTime + s.endTime) / 2;
          return m >= qStart && m < qEnd;
        });
        if (!has) emptyQuartiles.push(qi + 1);
      }
      if (emptyQuartiles.length > 0) {
        issues.push({
          code: "quartile_coverage",
          message:
            `No segment in timeline quartile(s) ${emptyQuartiles.join(", ")} of 4 — ` +
            `selections must span the full ${Math.round(videoDurationSec)}s source`,
        });
      }
    }
  }

  // --- Cut edges must land on Jockey-reported scene changes ---
  if (cuts.sceneBoundaries.length === 0) {
    issues.push({
      code: "missing_scene_boundaries",
      message:
        "sceneBoundaries is empty — report the scene-change timestamps each cut opens and closes on",
    });
  } else {
    for (const s of segments) {
      const startDist = nearestDistance(s.startTime, cuts.sceneBoundaries);
      const endDist = nearestDistance(s.endTime, cuts.sceneBoundaries);
      if (startDist > SCENE_EDGE_TOLERANCE_SEC) {
        issues.push({
          code: "edge_off_scene_boundary",
          message: `"${s.title}" opens at ${s.startTime.toFixed(1)}s, ${startDist.toFixed(1)}s from the nearest reported scene change`,
        });
      }
      if (endDist > SCENE_EDGE_TOLERANCE_SEC) {
        issues.push({
          code: "edge_off_scene_boundary",
          message: `"${s.title}" closes at ${s.endTime.toFixed(1)}s, ${endDist.toFixed(1)}s from the nearest reported scene change`,
        });
      }
    }
  }

  // --- No cuts on internal chunk/window seams ---
  const seams = options.seamTimestampsSec ?? [];
  if (seams.length > 0) {
    for (const s of segments) {
      for (const edge of [s.startTime, s.endTime]) {
        if (nearestDistance(edge, seams) <= SEAM_TOLERANCE_SEC) {
          issues.push({
            code: "seam_cut",
            message: `"${s.title}" has a cut at ${edge.toFixed(1)}s which coincides with an internal window seam — cut on a real scene change instead`,
          });
        }
      }
    }
  }

  // --- Title artifacts ---
  for (const s of segments) {
    if (TITLE_ARTIFACT_PATTERNS.some((re) => re.test(s.title))) {
      issues.push({
        code: "title_artifact",
        message: `Title "${s.title}" contains a mechanical suffix — use a human-readable headline`,
      });
    }
  }

  return issues;
}

// ============================================================================
// Output mapping (contract unchanged — SPEC §4.6)
// ============================================================================

export function mapToProposedSegments(
  cuts: SelfDirectedCut[],
): ProposedSegment[] {
  return cuts.map((c) => ({
    startTime: c.startTime,
    endTime: c.endTime,
    title: c.title,
    reasoning: c.edgeReason
      ? `${c.description} (Edges: ${c.edgeReason})`
      : c.description,
    expectedContent: "",
    section: c.narrativeRole ? `role-${c.narrativeRole}` : "jockey-v3",
  }));
}

// ============================================================================
// Observability helpers
// ============================================================================

export function quartileCounts(
  segments: Array<{ startTime: number; endTime: number }>,
  videoDurationSec: number,
): [number, number, number, number] {
  const q = videoDurationSec / 4;
  const counts: [number, number, number, number] = [0, 0, 0, 0];
  for (const s of segments) {
    const m = (s.startTime + s.endTime) / 2;
    if (m <= q) counts[0]++;
    else if (m <= q * 2) counts[1]++;
    else if (m <= q * 3) counts[2]++;
    else counts[3]++;
  }
  return counts;
}
