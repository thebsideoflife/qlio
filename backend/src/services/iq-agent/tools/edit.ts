/**
 * edit_segments — the only mutation tool.
 *
 * Guardrails here enforce structural integrity only: clamping, overlap
 * rejection, chronological ordering, and partial application. They never
 * second-guess an editorial choice. A segment that runs past the producer's
 * per-segment maximum is applied and reported as a violation in the ledger —
 * it is not rejected, because deciding that is the agent's job, not the code's.
 *
 * Pure and unit-testable: no I/O, no clock, no randomness.
 */

import type { AgentSegment } from "../types";
import { fmtTimecode } from "../ledger";

/** Anything shorter than this is a mis-typed timestamp, not a segment. */
export const MIN_SEGMENT_SEC = 0.5;

export interface EditOp {
  op: "add" | "remove" | "update";
  segmentId?: string;
  start?: number;
  end?: number;
  title?: string;
  description?: string;
}

export interface AppliedOp {
  op: EditOp["op"];
  segmentId: string;
  start: number;
  end: number;
  title: string;
  notes: string[];
}

export interface RejectedOp {
  /** Echoed back exactly as sent, so an unknown op is not renamed to a real one. */
  op: string;
  segmentId?: string;
  reason: string;
  conflictsWith?: string;
}

export interface EditOutcome {
  segments: AgentSegment[];
  applied: AppliedOp[];
  rejected: RejectedOp[];
  /** Segments whose timing changed — drives diff-based reframing. */
  changedIds: string[];
}

export function nextSegmentId(existing: AgentSegment[]): string {
  let highest = 0;
  for (const seg of existing) {
    const match = /^s(\d+)$/.exec(seg.id);
    if (match) highest = Math.max(highest, Number.parseInt(match[1], 10));
  }
  return `s${highest + 1}`;
}

function blankSegment(id: string): AgentSegment {
  return {
    id,
    startTime: 0,
    endTime: 0,
    title: "",
    description: "",
    characters: [],
    sceneTags: [],
    keyDialogue: "",
    confidence: 0.9,
  };
}

export function applyEdits(
  current: AgentSegment[],
  ops: EditOp[],
  videoDuration: number,
  bounds: { min?: number | null; max?: number | null } = {},
): EditOutcome {
  const working = current.map((s) => ({ ...s }));
  const applied: AppliedOp[] = [];
  const rejected: RejectedOp[] = [];
  const changed = new Set<string>();

  for (const raw of ops) {
    const op = raw?.op;

    if (op !== "add" && op !== "remove" && op !== "update") {
      rejected.push({
        op: String(op ?? "(missing)"),
        reason: `Unknown operation "${String(op)}". Use add, remove, or update.`,
      });
      continue;
    }

    if (op === "remove") {
      if (!raw.segmentId) {
        rejected.push({ op, reason: "remove requires segmentId." });
        continue;
      }
      const index = working.findIndex((s) => s.id === raw.segmentId);
      if (index === -1) {
        rejected.push({
          op,
          segmentId: raw.segmentId,
          reason: `No segment with id ${raw.segmentId}.`,
        });
        continue;
      }
      const [removed] = working.splice(index, 1);
      changed.add(removed.id);
      applied.push({
        op,
        segmentId: removed.id,
        start: removed.startTime,
        end: removed.endTime,
        title: removed.title,
        notes: [],
      });
      continue;
    }

    let target: AgentSegment;
    let existingIndex = -1;

    if (op === "update") {
      if (!raw.segmentId) {
        rejected.push({ op, reason: "update requires segmentId." });
        continue;
      }
      existingIndex = working.findIndex((s) => s.id === raw.segmentId);
      if (existingIndex === -1) {
        rejected.push({
          op,
          segmentId: raw.segmentId,
          reason: `No segment with id ${raw.segmentId}.`,
        });
        continue;
      }
      target = { ...working[existingIndex] };
    } else {
      // `working` already holds anything added earlier in this batch, so it is
      // the whole basis for the next id — no offset, or the sequence skips.
      target = blankSegment(nextSegmentId(working));
    }

    const rawStart = raw.start ?? (op === "update" ? target.startTime : undefined);
    const rawEnd = raw.end ?? (op === "update" ? target.endTime : undefined);

    if (typeof rawStart !== "number" || typeof rawEnd !== "number") {
      rejected.push({
        op,
        segmentId: raw.segmentId,
        reason: "add requires numeric start and end (update requires at least one).",
      });
      continue;
    }
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
      rejected.push({
        op,
        segmentId: raw.segmentId,
        reason: "start and end must be finite numbers of seconds.",
      });
      continue;
    }

    const notes: string[] = [];
    const upperBound = videoDuration > 0 ? videoDuration : Math.max(rawEnd, rawStart);
    // Ordered before clamping so a reversed pair is not also reported as
    // clamped when nothing was actually moved.
    const orderedStart = Math.min(rawStart, rawEnd);
    const orderedEnd = Math.max(rawStart, rawEnd);
    if (rawEnd < rawStart) {
      notes.push("start and end were swapped — they arrived reversed.");
    }

    const start = Math.min(Math.max(orderedStart, 0), upperBound);
    const end = Math.min(Math.max(orderedEnd, 0), upperBound);

    if (
      Math.abs(start - orderedStart) > 0.01 ||
      Math.abs(end - orderedEnd) > 0.01
    ) {
      notes.push(
        `Clamped to the source timeline (0–${fmtTimecode(upperBound)}).`,
      );
    }

    if (end - start < MIN_SEGMENT_SEC) {
      rejected.push({
        op,
        segmentId: raw.segmentId,
        reason: `Segment would be ${(end - start).toFixed(2)}s long, which is not a usable clip. Check the timestamps.`,
      });
      continue;
    }

    const conflict = working.find(
      (s) =>
        s.id !== target.id &&
        (op !== "update" || s.id !== raw.segmentId) &&
        start < s.endTime - 0.05 &&
        end > s.startTime + 0.05,
    );
    if (conflict) {
      rejected.push({
        op,
        segmentId: raw.segmentId,
        reason: `Would overlap "${conflict.title || conflict.id}" (${fmtTimecode(
          conflict.startTime,
        )}–${fmtTimecode(conflict.endTime)}).`,
        conflictsWith: conflict.id,
      });
      continue;
    }

    const timingChanged =
      op === "add" ||
      Math.abs(target.startTime - start) > 0.01 ||
      Math.abs(target.endTime - end) > 0.01;

    target.startTime = start;
    target.endTime = end;
    if (typeof raw.title === "string" && raw.title.trim()) {
      target.title = raw.title.trim();
    }
    if (typeof raw.description === "string" && raw.description.trim()) {
      target.description = raw.description.trim();
    }
    if (!target.title) target.title = "Untitled moment";

    const duration = end - start;
    if (bounds.max != null && duration > bounds.max + 0.25) {
      notes.push(
        `Runs ${(duration - bounds.max).toFixed(1)}s over the ${bounds.max}s per-segment max — this is now a ledger violation.`,
      );
    }
    if (bounds.min != null && duration < bounds.min - 0.25) {
      notes.push(
        `Runs ${(bounds.min - duration).toFixed(1)}s under the ${bounds.min}s per-segment min — this is now a ledger violation.`,
      );
    }

    if (op === "update") {
      working[existingIndex] = target;
    } else {
      working.push(target);
    }
    if (timingChanged) changed.add(target.id);

    applied.push({
      op,
      segmentId: target.id,
      start,
      end,
      title: target.title,
      notes,
    });
  }

  working.sort((a, b) => a.startTime - b.startTime);

  return {
    segments: working,
    applied,
    rejected,
    changedIds: Array.from(changed),
  };
}

export function renderEditOutcome(outcome: EditOutcome): string {
  const lines: string[] = [];

  if (outcome.applied.length > 0) {
    lines.push(`Applied ${outcome.applied.length} operation(s):`);
    for (const a of outcome.applied) {
      const verb =
        a.op === "add" ? "added" : a.op === "remove" ? "removed" : "updated";
      lines.push(
        `  - ${verb} ${a.segmentId} ${fmtTimecode(a.start)}–${fmtTimecode(a.end)} (${(
          a.end - a.start
        ).toFixed(1)}s) "${a.title}"`,
      );
      for (const note of a.notes) lines.push(`      note: ${note}`);
    }
  } else {
    lines.push("No operations were applied.");
  }

  if (outcome.rejected.length > 0) {
    lines.push("", `Rejected ${outcome.rejected.length} operation(s):`);
    for (const r of outcome.rejected) {
      lines.push(
        `  - ${r.op}${r.segmentId ? ` ${r.segmentId}` : ""}: ${r.reason}`,
      );
    }
  }

  return lines.join("\n");
}
