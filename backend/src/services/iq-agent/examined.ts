/**
 * What the editor has actually looked at, as intervals on the source timeline.
 *
 * This exists to answer one question at finish time: is there a stretch of the
 * video the agent never examined and also never cut from? That is a blind spot,
 * and it is the difference between "I considered this and left it out" and "I
 * never knew it was there".
 *
 * Deliberately measured from tool calls rather than from content. A keyword scan
 * of the transcript would miss a scene with no dialogue and would go blind
 * entirely when ASR is broken — which is exactly when the agent needs the check
 * most. `read_transcript`, `watch_clip` and `view_frames` all count the same,
 * so a wordless visual scene is satisfied by watching it.
 */

import {
  BLIND_SPOT_FLOOR_LONG_SEC,
  BLIND_SPOT_FLOOR_SEC,
  BLIND_SPOT_FLOOR_UNAIDED_SEC,
  BLIND_SPOT_LONG_FRACTION,
  BLIND_SPOT_UNAIDED_FRACTION,
} from "./config";
import type { AgentSegment, Interval } from "./types";

/** Touching or overlapping intervals are joined; anything shorter is dropped. */
const JOIN_TOLERANCE_SEC = 0.5;

export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
    .map((i) => ({ start: i.start, end: i.end }))
    .sort((a, b) => a.start - b.start);

  const merged: Interval[] = [];
  for (const cur of sorted) {
    const last = merged[merged.length - 1];
    if (last && cur.start <= last.end + JOIN_TOLERANCE_SEC) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

/** Add a look at [start, end], clamped to the timeline. Returns a new list. */
export function recordExamined(
  examined: Interval[],
  start: number,
  end: number,
  videoDuration: number,
): Interval[] {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return examined;
  const lo = Math.max(0, Math.min(start, end));
  const hi = Math.min(videoDuration > 0 ? videoDuration : Math.max(start, end), Math.max(start, end));
  if (hi <= lo) return examined;
  return mergeIntervals([...examined, { start: lo, end: hi }]);
}

export function totalSeconds(intervals: Interval[]): number {
  return intervals.reduce((sum, i) => sum + (i.end - i.start), 0);
}

/**
 * The shortest unexamined stretch worth objecting to.
 *
 * Scaled by duration so the gate stays satisfiable in a bounded number of tool
 * calls on a three-hour source, and relaxed a long way when there is no
 * transcript — examining blind then costs Pegasus minutes rather than a free
 * read, and a gate nobody can afford to clear is just a broken run.
 */
export function blindSpotFloor(videoDuration: number, hasTranscript: boolean): number {
  if (!hasTranscript) {
    return Math.max(
      BLIND_SPOT_FLOOR_UNAIDED_SEC,
      videoDuration * BLIND_SPOT_UNAIDED_FRACTION,
    );
  }
  return Math.min(
    BLIND_SPOT_FLOOR_LONG_SEC,
    Math.max(BLIND_SPOT_FLOOR_SEC, videoDuration * BLIND_SPOT_LONG_FRACTION),
  );
}

/**
 * Stretches that are neither inside a segment nor examined. A segment counts as
 * accounted-for on its own: choosing to include a moment is a decision about it,
 * and rule 2 already governs whether that choice was grounded.
 */
export function findBlindSpots(params: {
  examined: Interval[];
  segments: AgentSegment[];
  videoDuration: number;
  floorSec: number;
}): Array<{ start: number; end: number; seconds: number }> {
  const { videoDuration, floorSec } = params;
  if (videoDuration <= 0) return [];

  const accounted = mergeIntervals([
    ...params.examined,
    ...params.segments.map((s) => ({ start: s.startTime, end: s.endTime })),
  ]);

  const spots: Array<{ start: number; end: number; seconds: number }> = [];
  let cursor = 0;
  for (const interval of accounted) {
    if (interval.start - cursor > floorSec) {
      spots.push(round({ start: cursor, end: interval.start }));
    }
    cursor = Math.max(cursor, interval.end);
  }
  if (videoDuration - cursor > floorSec) {
    spots.push(round({ start: cursor, end: videoDuration }));
  }
  return spots;
}

function round(i: Interval): { start: number; end: number; seconds: number } {
  const r = (n: number) => Math.round(n * 100) / 100;
  return { start: r(i.start), end: r(i.end), seconds: r(i.end - i.start) };
}

/** Whether a time range has already been looked at, for search-yield scoring. */
export function isCovered(accounted: Interval[], start: number, end: number): boolean {
  const mid = (start + end) / 2;
  return accounted.some((i) => mid >= i.start && mid <= i.end);
}

/** How far outside a visual-examination interval an edge may sit and still count as seen. */
export const EDGE_VERIFY_TOLERANCE_SEC = 2;

/**
 * Segment edges the agent never verified visually. An edge counts as verified
 * when a view_frames or watch_clip window covers it (within tolerance). Edges
 * at the very start or end of the source are exempt — there is no boundary
 * to find there.
 */
export function findUnverifiedEdges(
  segments: AgentSegment[],
  visualExamined: Interval[],
  videoDuration: number,
): Array<{ segmentId: string; title: string; edge: "start" | "end"; time: number }> {
  const seen = (t: number) =>
    visualExamined.some(
      (i) => t >= i.start - EDGE_VERIFY_TOLERANCE_SEC && t <= i.end + EDGE_VERIFY_TOLERANCE_SEC,
    );
  const out: Array<{ segmentId: string; title: string; edge: "start" | "end"; time: number }> = [];
  for (const s of segments) {
    if (s.startTime > EDGE_VERIFY_TOLERANCE_SEC && !seen(s.startTime)) {
      out.push({ segmentId: s.id, title: s.title || "(untitled)", edge: "start", time: s.startTime });
    }
    if (
      videoDuration > 0 &&
      s.endTime < videoDuration - EDGE_VERIFY_TOLERANCE_SEC &&
      !seen(s.endTime)
    ) {
      out.push({ segmentId: s.id, title: s.title || "(untitled)", edge: "end", time: s.endTime });
    }
  }
  return out;
}
