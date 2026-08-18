/**
 * The budget ledger — the answer to the duration problem.
 *
 * Pure, deterministic, no I/O. Recomputed after every mutation and attached to
 * `edit_segments`, `check_budget`, and every `state.updated` event, so the model
 * and the producer are always reading the same arithmetic.
 *
 * This governs arithmetic and structure only. It never constrains which moments
 * the agent picks or where it places a boundary.
 */

import { blindSpotFloor, findBlindSpots, findUnverifiedEdges, mergeIntervals, totalSeconds } from "./examined";
import type {
  AgentSegment,
  Brief,
  Interval,
  Ledger,
  LedgerOverlap,
  SegmentBoundViolation,
  TargetStatus,
} from "./types";

/** Overlaps below this are floating-point noise, not editorial mistakes. */
const OVERLAP_EPSILON_SEC = 0.05;

/** Per-segment bound breaches below this are rounding, not violations. */
const BOUND_EPSILON_SEC = 0.25;

export interface FormatTargetDefault {
  seconds: number;
  band: [number, number];
}

/**
 * Only formats with a genuinely conventional length get a default. Everything
 * else reports `no_target` rather than inventing a number to miss.
 */
export const FORMAT_TARGET_DEFAULTS: Record<string, FormatTargetDefault> = {
  episode_recap: { seconds: 90, band: [60, 120] },
};

export function resolveTarget(
  brief: Brief | undefined,
  videoDuration: number,
): { seconds: number | null; band: [number, number] | null; source: Ledger["target"]["source"] } {
  if (brief?.targetSeconds != null && brief.targetSeconds > 0) {
    return {
      seconds: brief.targetSeconds,
      band: bandFor(brief.targetSeconds),
      source: "explicit_seconds",
    };
  }

  if (
    brief?.targetPercent != null &&
    brief.targetPercent > 0 &&
    brief.targetPercent <= 100 &&
    videoDuration > 0
  ) {
    const seconds = (videoDuration * brief.targetPercent) / 100;
    return { seconds, band: bandFor(seconds), source: "target_percent" };
  }

  const preset = brief?.format ? FORMAT_TARGET_DEFAULTS[brief.format] : undefined;
  if (preset) {
    return { seconds: preset.seconds, band: preset.band, source: "format_default" };
  }

  return { seconds: null, band: null, source: "none" };
}

/** ±5% of target, floored at ±10s so short targets stay achievable. */
function bandFor(target: number): [number, number] {
  const halfWidth = Math.min(Math.max(target * 0.05, 10), 120);
  return [Math.max(0, target - halfWidth), target + halfWidth];
}

export function segmentDuration(seg: Pick<AgentSegment, "startTime" | "endTime">): number {
  return Math.max(0, seg.endTime - seg.startTime);
}

export interface CoverageInput {
  /** Everything the agent has looked at this session. */
  examined: Interval[];
  /** Stretches verified with a visual tool (view_frames / watch_clip). */
  visualExamined?: Interval[];
  /** Drives how strict the blind-spot floor is; examining is dear without one. */
  hasTranscript: boolean;
}

export function computeLedger(
  segments: AgentSegment[],
  brief: Brief | undefined,
  videoDuration: number,
  coverage?: CoverageInput,
): Ledger {
  const sorted = [...segments].sort((a, b) => a.startTime - b.startTime);
  const totalDuration = sorted.reduce((sum, s) => sum + segmentDuration(s), 0);

  const target = resolveTarget(brief, videoDuration);
  let status: TargetStatus = "no_target";
  let delta = 0;
  let deltaPercent = 0;

  if (target.seconds != null && target.band != null) {
    delta = totalDuration - target.seconds;
    deltaPercent = target.seconds > 0 ? (delta / target.seconds) * 100 : 0;
    if (totalDuration < target.band[0]) status = "under";
    else if (totalDuration > target.band[1]) status = "over";
    else status = "within";
  }

  const min = normalizeBound(brief?.minSegmentDuration);
  const max = normalizeBound(brief?.maxSegmentDuration);
  const violations: SegmentBoundViolation[] = [];

  for (const seg of sorted) {
    const dur = segmentDuration(seg);
    if (min != null && dur < min - BOUND_EPSILON_SEC) {
      violations.push({
        segmentId: seg.id,
        title: seg.title || "(untitled)",
        duration: round(dur),
        bound: "min",
        limit: min,
        delta: round(min - dur),
      });
    }
    if (max != null && dur > max + BOUND_EPSILON_SEC) {
      violations.push({
        segmentId: seg.id,
        title: seg.title || "(untitled)",
        duration: round(dur),
        bound: "max",
        limit: max,
        delta: round(dur - max),
      });
    }
  }

  const overlaps = findOverlaps(sorted);
  const coverageReport = computeCoverage(sorted, videoDuration, coverage);
  const unverifiedEdges =
    coverage?.visualExamined != null
      ? findUnverifiedEdges(sorted, coverage.visualExamined, videoDuration)
      : [];

  const blocking: string[] = [];
  const warnings: string[] = [];

  if (sorted.length === 0) {
    blocking.push("The cut is empty — no segments have been added yet.");
  }

  if (status === "over") {
    blocking.push(
      `Total runtime ${fmt(totalDuration)} is ${fmt(Math.abs(delta))} over the ${fmt(
        target.seconds!,
      )} target (band ${fmt(target.band![0])}–${fmt(target.band![1])}). Trim or drop segments.`,
    );
  } else if (status === "under") {
    blocking.push(
      `Total runtime ${fmt(totalDuration)} is ${fmt(Math.abs(delta))} under the ${fmt(
        target.seconds!,
      )} target (band ${fmt(target.band![0])}–${fmt(target.band![1])}). Add or extend segments.`,
    );
  }

  for (const v of violations) {
    blocking.push(
      v.bound === "max"
        ? `"${v.title}" runs ${fmt(v.duration)} — ${fmt(v.delta)} over the ${fmt(v.limit)} per-segment max.`
        : `"${v.title}" runs ${fmt(v.duration)} — ${fmt(v.delta)} under the ${fmt(v.limit)} per-segment min.`,
    );
  }

  for (const o of overlaps) {
    blocking.push(`Segments ${o.a} and ${o.b} overlap by ${fmt(o.seconds)}.`);
  }

  for (const e of unverifiedEdges) {
    blocking.push(
      `The ${e.edge} of "${e.title}" at ${fmtTimecode(e.time)} was never verified visually — ` +
        `view_frames at that timestamp (or watch_clip across it) to confirm the cut lands on a real boundary, ` +
        `then re-time it to where the moment actually starts or ends.`,
    );
  }

  if (coverageReport.spreadWarning) warnings.push(coverageReport.spreadWarning);

  if (status === "no_target" && sorted.length > 0) {
    warnings.push(
      "No total-duration target is set, so runtime is your editorial call. State the runtime you are aiming for.",
    );
  }

  return {
    videoDuration: round(videoDuration),
    segmentCount: sorted.length,
    totalDuration: round(totalDuration),
    target: {
      seconds: target.seconds == null ? null : round(target.seconds),
      band: target.band ? [round(target.band[0]), round(target.band[1])] : null,
      status,
      delta: round(delta),
      deltaPercent: round(deltaPercent),
      source: target.source,
    },
    perSegment: { min, max, violations },
    overlaps,
    coverage: coverageReport,
    unverifiedEdges,
    blocking,
    warnings,
  };
}

function normalizeBound(value: number | undefined | null): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

export function findOverlaps(sortedSegments: AgentSegment[]): LedgerOverlap[] {
  const overlaps: LedgerOverlap[] = [];
  for (let i = 1; i < sortedSegments.length; i++) {
    const prev = sortedSegments[i - 1];
    const cur = sortedSegments[i];
    const seconds = prev.endTime - cur.startTime;
    if (seconds > OVERLAP_EPSILON_SEC) {
      overlaps.push({ a: prev.id, b: cur.id, seconds: round(seconds) });
    }
  }
  return overlaps;
}

function computeCoverage(
  sorted: AgentSegment[],
  videoDuration: number,
  input?: CoverageInput,
): Ledger["coverage"] {
  const quartiles: [number, number, number, number] = [0, 0, 0, 0];

  if (videoDuration > 0) {
    for (const seg of sorted) {
      const mid = (seg.startTime + seg.endTime) / 2;
      const idx = Math.min(3, Math.max(0, Math.floor((mid / videoDuration) * 4)));
      quartiles[idx] += 1;
    }
  }

  let largestGap: Ledger["coverage"]["largestGap"] = null;
  if (videoDuration > 0) {
    let cursor = 0;
    for (const seg of sorted) {
      const gap = seg.startTime - cursor;
      if (gap > (largestGap?.seconds ?? 0)) {
        largestGap = { start: round(cursor), end: round(seg.startTime), seconds: round(gap) };
      }
      cursor = Math.max(cursor, seg.endTime);
    }
    const tail = videoDuration - cursor;
    if (tail > (largestGap?.seconds ?? 0)) {
      largestGap = { start: round(cursor), end: round(videoDuration), seconds: round(tail) };
    }
  }

  let spreadWarning: string | null = null;
  if (sorted.length >= 4 && videoDuration > 0) {
    const empty = quartiles
      .map((count, i) => ({ count, i }))
      .filter((q) => q.count === 0)
      .map((q) => ordinal(q.i + 1));
    if (empty.length > 0) {
      spreadWarning = `No segments in the ${empty.join(" or ")} quarter of the source.`;
    }
  }

  const examined = mergeIntervals(input?.examined ?? []);
  const examinedSeconds = totalSeconds(examined);
  const blindSpots = input
    ? findBlindSpots({
        examined,
        segments: sorted,
        videoDuration,
        floorSec: blindSpotFloor(videoDuration, input.hasTranscript),
      })
    : [];

  return {
    quartiles,
    largestGap,
    spreadWarning,
    blindSpots,
    examinedSeconds: round(examinedSeconds),
    examinedPercent:
      videoDuration > 0 ? round((examinedSeconds / videoDuration) * 100) : 0,
  };
}

function ordinal(n: number): string {
  return ["first", "second", "third", "final"][n - 1] ?? `${n}th`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** m:ss for durations. Used in ledger prose so model and UI read alike. */
export function fmt(seconds: number): string {
  const total = Math.round(Math.abs(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const sign = seconds < 0 ? "-" : "";
  return m > 0 ? `${sign}${m}m ${s.toString().padStart(2, "0")}s` : `${sign}${s}s`;
}

/** [h:]mm:ss for absolute timeline positions. */
export function fmtTimecode(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? m.toString().padStart(2, "0") : String(m);
  return h > 0
    ? `${h}:${mm}:${s.toString().padStart(2, "0")}`
    : `${mm}:${s.toString().padStart(2, "0")}`;
}

/**
 * The ledger rendered for Claude. This is the text that makes the arithmetic
 * impossible to ignore — it is returned by every mutation and re-rendered fresh
 * in the live-state block on every iteration.
 */
export function renderLedger(ledger: Ledger): string {
  const lines: string[] = [];
  const t = ledger.target;

  lines.push(
    `Segments: ${ledger.segmentCount} · Total runtime: ${fmt(ledger.totalDuration)} (${ledger.totalDuration.toFixed(1)}s) · Source: ${fmt(ledger.videoDuration)}`,
  );

  if (t.seconds != null && t.band != null) {
    const verdict =
      t.status === "within"
        ? "INSIDE the target band"
        : t.status === "over"
          ? `OVER by ${fmt(Math.abs(t.delta))} (${t.deltaPercent.toFixed(1)}%)`
          : `UNDER by ${fmt(Math.abs(t.delta))} (${Math.abs(t.deltaPercent).toFixed(1)}%)`;
    lines.push(
      `Target: ${fmt(t.seconds)} (band ${fmt(t.band[0])}–${fmt(t.band[1])}) → ${verdict}`,
    );
  } else {
    lines.push("Target: none set — runtime is your editorial call.");
  }

  const bounds: string[] = [];
  if (ledger.perSegment.min != null) bounds.push(`min ${fmt(ledger.perSegment.min)}`);
  if (ledger.perSegment.max != null) bounds.push(`max ${fmt(ledger.perSegment.max)}`);
  if (bounds.length > 0) {
    lines.push(
      `Per-segment bounds: ${bounds.join(", ")} · ${ledger.perSegment.violations.length} violation(s)`,
    );
  }

  lines.push(
    `Coverage by quarter of source: [${ledger.coverage.quartiles.join(", ")}]` +
      (ledger.coverage.largestGap
        ? ` · largest untouched stretch ${fmt(ledger.coverage.largestGap.seconds)} at ${fmtTimecode(ledger.coverage.largestGap.start)}`
        : ""),
  );

  lines.push(
    `Examined so far: ${fmt(ledger.coverage.examinedSeconds)} of the source (${ledger.coverage.examinedPercent.toFixed(0)}%).`,
  );

  if (ledger.coverage.blindSpots.length > 0) {
    lines.push(
      "",
      "NOT YET LOOKED AT (you cannot finish while any of these remain):",
      renderBlindSpots(ledger.coverage.blindSpots),
    );
  }

  if (ledger.blocking.length > 0) {
    lines.push("", "BLOCKING (must be resolved before you finish):");
    for (const b of ledger.blocking) lines.push(`  - ${b}`);
  } else {
    lines.push("", "BLOCKING: none — the cut is arithmetically and structurally clean.");
  }

  if (ledger.warnings.length > 0) {
    lines.push("", "Notes:");
    for (const w of ledger.warnings) lines.push(`  - ${w}`);
  }

  return lines.join("\n");
}

export function renderBlindSpots(
  spots: Array<{ start: number; end: number; seconds: number }>,
): string {
  return spots
    .map(
      (s) =>
        `  - ${fmtTimecode(s.start)}–${fmtTimecode(s.end)} (${fmt(s.seconds)}) — never examined, nothing cut from it`,
    )
    .join("\n");
}

/** The segment table rendered for Claude. Regenerated fresh every iteration. */
export function renderSegmentTable(segments: AgentSegment[]): string {
  if (segments.length === 0) return "(no segments yet)";
  const sorted = [...segments].sort((a, b) => a.startTime - b.startTime);
  const rows = sorted.map((s, i) => {
    const dur = segmentDuration(s);
    return `${String(i + 1).padStart(2)}. ${s.id}  ${fmtTimecode(s.startTime)}–${fmtTimecode(
      s.endTime,
    )}  (${dur.toFixed(1)}s)  ${s.title || "(untitled)"}`;
  });
  return rows.join("\n");
}
