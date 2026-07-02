import type { ProposedSegment } from "../types";
import { Purpose } from "../types";

export interface CoverageResult {
  passed: boolean;
  issues: string[];
}

function segmentMidpoints(segments: ProposedSegment[]): number[] {
  return segments.map((s) => (s.startTime + s.endTime) / 2);
}

/**
 * Timeline distribution validator — fails when compact output clusters in latter half.
 */
export function checkTimelineCoverage(
  segments: ProposedSegment[],
  durationSec: number,
  purpose: Purpose.COMPACT_VIDEO | Purpose.EPISODE_RECAP,
): CoverageResult {
  const issues: string[] = [];

  if (segments.length === 0) {
    return { passed: false, issues: ["No segments produced"] };
  }

  const midpoints = segmentMidpoints(segments);
  const half = durationSec / 2;
  const firstQuartileEnd = durationSec / 4;

  const inLatterHalf = midpoints.filter((m) => m >= half).length;
  const latterHalfRatio = inLatterHalf / midpoints.length;
  if (purpose === Purpose.COMPACT_VIDEO && latterHalfRatio > 0.7) {
    issues.push(
      `${Math.round(latterHalfRatio * 100)}% of segment midpoints fall in latter 50% of video`,
    );
  }

  const hasFirstQuartile = midpoints.some((m) => m <= firstQuartileEnd);
  if (purpose === Purpose.COMPACT_VIDEO && !hasFirstQuartile) {
    issues.push("No segment midpoint in first quartile [0, duration/4]");
  }

  if (
    purpose === Purpose.COMPACT_VIDEO &&
    durationSec > 45 * 60 &&
    segments.length < 3
  ) {
    issues.push(
      `Compact on ${Math.round(durationSec / 60)}min source produced only ${segments.length} segment(s)`,
    );
  }

  return { passed: issues.length === 0, issues };
}

/**
 * If keep-filter drops all segments in a timeline quartile, add the best
 * candidate from that quartile so long-form compacts cover the full video.
 */
export function backfillQuartileCoverage(
  candidates: ProposedSegment[],
  kept: ProposedSegment[],
  durationSec: number,
): ProposedSegment[] {
  if (candidates.length === 0 || kept.length === 0) return kept;

  const q = durationSec / 4;
  const quartileEnd = [q, q * 2, q * 3, durationSec];
  const midpoint = (s: ProposedSegment) => (s.startTime + s.endTime) / 2;

  const result = [...kept];
  const resultKeys = new Set(
    kept.map((s) => `${s.startTime.toFixed(2)}-${s.endTime.toFixed(2)}`),
  );

  for (let qi = 0; qi < 4; qi++) {
    const qStart = qi === 0 ? 0 : quartileEnd[qi - 1];
    const qEnd = quartileEnd[qi];
    const hasRep = result.some((s) => {
      const m = midpoint(s);
      return m >= qStart && m < qEnd;
    });
    if (hasRep) continue;

    const inQuartile = candidates
      .filter((s) => {
        const m = midpoint(s);
        return m >= qStart && m < qEnd;
      })
      .sort((a, b) => b.endTime - b.startTime - (a.endTime - a.startTime));

    for (const seg of inQuartile) {
      const key = `${seg.startTime.toFixed(2)}-${seg.endTime.toFixed(2)}`;
      if (!resultKeys.has(key)) {
        result.push(seg);
        resultKeys.add(key);
        break;
      }
    }
  }

  result.sort((a, b) => a.startTime - b.startTime);
  return result;
}

/**
 * Shrink recap beat windows to hit ~60–90s without dropping below 4 beats.
 */
export function narrowRecapBeatWindows(
  segments: ProposedSegment[],
  targetSeconds: number,
  durationSec: number,
): ProposedSegment[] {
  if (segments.length === 0) return segments;

  const targetTotal = Math.min(90, Math.max(60, targetSeconds));
  const halfWidth = Math.min(
    12,
    Math.max(6, Math.floor(targetTotal / segments.length / 2)),
  );

  return segments.map((seg) => {
    const center = (seg.startTime + seg.endTime) / 2;
    return {
      ...seg,
      startTime: Math.max(0, center - halfWidth),
      endTime: Math.min(durationSec, center + halfWidth),
    };
  });
}

export interface AcceptanceResult {
  passed: boolean;
  issues: string[];
}

/**
 * Acceptance criteria checks for eval script and integration tests.
 */
export function assertAcceptanceCriteria(
  segments: ProposedSegment[],
  durationSec: number,
  purpose: Purpose.COMPACT_VIDEO | Purpose.EPISODE_RECAP,
): AcceptanceResult {
  const issues: string[] = [];

  const coverage = checkTimelineCoverage(segments, durationSec, purpose);
  issues.push(...coverage.issues);

  if (purpose === Purpose.EPISODE_RECAP) {
    const totalDuration = segments.reduce(
      (sum, s) => sum + (s.endTime - s.startTime),
      0,
    );
    if (segments.length < 4 || segments.length > 6) {
      issues.push(`Recap beat count ${segments.length} not in [4, 6]`);
    }
    if (totalDuration < 50 || totalDuration > 120) {
      issues.push(
        `Recap total duration ${Math.round(totalDuration)}s not in ~60–90s band`,
      );
    }
  }

  return { passed: issues.length === 0, issues };
}
