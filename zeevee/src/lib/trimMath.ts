/**
 * Frame math for precise trimming. Pure functions so the timeline, the trim
 * lens and the tests share one definition of "which frame is the cut".
 *
 * A segment [start, end) covers source frames round(start*fps) through
 * round(end*fps) - 1, the same rule segmentFrameBounds uses for export.
 */
import { frameIndex, frameToTime, snapTimeToFrame } from "@/remotion/framingInterpolation";
import { formatTimecode, parseTimecode } from "@/lib/timecode";

export type TrimEdge = "start" | "end";

/** Matches MIN_SEGMENT_DURATION in editorSlice (segments shorter are dropped). */
export const MIN_TRIM_DURATION = 0.1;

/** Shortest legal clip, rounded up to whole frames so a nudge never drops it. */
export function minTrimDuration(fps: number | null): number {
  if (!fps || !(fps > 0)) return MIN_TRIM_DURATION;
  return Math.ceil(MIN_TRIM_DURATION * fps - 1e-9) / fps;
}

/**
 * Frames either side of the cut.
 * start edge: outside = last frame before the clip, inside = first frame of it.
 * end edge:   inside = last frame of the clip, outside = first frame after it.
 */
export function edgeFrames(
  seg: { startTime: number; endTime: number },
  edge: TrimEdge,
  fps: number,
): { inside: number; outside: number } {
  if (edge === "start") {
    const inside = frameIndex(seg.startTime, fps);
    return { inside, outside: inside - 1 };
  }
  const outside = frameIndex(seg.endTime, fps);
  return { inside: outside - 1, outside };
}

/** Seek target that displays `frame` (mid-frame avoids boundary rounding). */
export function frameDisplayTime(frame: number, fps: number): number {
  return (Math.max(0, frame) + 0.5) / fps;
}

/** Where the playhead goes so the viewer shows the inside frame of an edge. */
export function edgeDisplayTime(
  seg: { startTime: number; endTime: number },
  edge: TrimEdge,
  fps: number | null,
): number {
  if (!fps || !(fps > 0)) {
    return edge === "start" ? seg.startTime : Math.max(seg.startTime, seg.endTime - 0.001);
  }
  return frameDisplayTime(edgeFrames(seg, edge, fps).inside, fps);
}

/**
 * Move one edge to `time` (snapped to the frame grid), keeping the clip at
 * least minTrimDuration long and inside [0, total].
 */
export function setEdgeTime(
  seg: { startTime: number; endTime: number },
  edge: TrimEdge,
  time: number,
  fps: number | null,
  total: number,
): { start: number; end: number } {
  const minDur = minTrimDuration(fps);
  const snap = (t: number) => snapTimeToFrame(t, fps);
  const start = snap(seg.startTime);
  const end = snap(seg.endTime);
  if (edge === "start") {
    const max = end - minDur;
    const next = Math.max(0, Math.min(max, snap(time)));
    return { start: next, end };
  }
  const min = start + minDur;
  const next = Math.min(Math.max(min, snap(time)), total);
  return { start, end: Math.max(min, next) };
}

/** Nudge an edge by whole frames (seconds when fps is unknown: 1 "frame" = 1/30 s). */
export function nudgeEdge(
  seg: { startTime: number; endTime: number },
  edge: TrimEdge,
  frames: number,
  fps: number | null,
  total: number,
): { start: number; end: number } {
  const step = fps && fps > 0 ? 1 / fps : 1 / 30;
  const from = edge === "start" ? seg.startTime : seg.endTime;
  const base = fps && fps > 0 ? frameToTime(frameIndex(from, fps), fps) : from;
  return setEdgeTime(seg, edge, base + frames * step, fps, total);
}

const pad = (n: number) => n.toString().padStart(2, "0");

/**
 * "HH:MM:SS:FF" on the real-time clock. For fractional rates (29.97) the
 * number of frames in a second varies by one, so FF counts from the first
 * frame that starts inside that second; parseFrameTimecode inverts it exactly.
 */
export function formatFrameTimecode(seconds: number, fps: number | null): string {
  if (!fps || !(fps > 0)) return formatTimecode(seconds);
  const frame = Math.max(0, frameIndex(seconds, fps));
  const whole = Math.floor((frame + 1e-6) / fps);
  const ff = frame - Math.ceil(whole * fps - 1e-6);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(ff)}`;
}

/**
 * Read "HH:MM:SS:FF" (or anything parseTimecode accepts) into a frame-snapped
 * time. Returns null for malformed input or a frame number past the second.
 */
export function parseFrameTimecode(text: string, fps: number | null): number | null {
  const parts = text.trim().split(":");
  if (parts.length === 4) {
    if (!fps || !(fps > 0)) return null;
    if (!parts.every((p) => /^\d+$/.test(p))) return null;
    const [h, m, s, ff] = parts.map(Number);
    if (m >= 60 || s >= 60) return null;
    const whole = h * 3600 + m * 60 + s;
    const first = Math.ceil(whole * fps - 1e-6);
    const nextFirst = Math.ceil((whole + 1) * fps - 1e-6);
    if (first + ff >= nextFirst) return null;
    return frameToTime(first + ff, fps);
  }
  const t = parseTimecode(text);
  return t == null ? null : snapTimeToFrame(t, fps);
}

/** Start of a lens window of `span` seconds centred on `center`, kept inside the video. */
export function lensWindowStart(center: number, span: number, total: number): number {
  const maxStart = Math.max(0, total - span);
  return Math.max(0, Math.min(maxStart, center - span / 2));
}

/**
 * Edge time that makes the frame on screen at `playhead` the first frame of
 * the clip (in point) or its last frame (out point), as in other editors.
 */
export function edgeTimeAtPlayhead(
  playhead: number,
  edge: TrimEdge,
  fps: number | null,
): number {
  if (!fps || !(fps > 0)) return playhead;
  const shown = Math.floor(playhead * fps + 1e-6);
  return frameToTime(edge === "start" ? shown : shown + 1, fps);
}

interface TimedWord {
  start: number;
  end: number;
}

/**
 * Edge time that cuts on a word: the In point lands on the frame where the
 * word begins, the Out point on the first frame after it ends (rounded
 * outward so the word is never clipped).
 */
export function wordEdgeTime(
  word: TimedWord,
  edge: TrimEdge,
  fps: number | null,
): number {
  if (!fps || !(fps > 0)) return edge === "start" ? word.start : word.end;
  return edge === "start"
    ? frameToTime(Math.floor(word.start * fps + 1e-6), fps)
    : frameToTime(Math.ceil(word.end * fps - 1e-6), fps);
}

/**
 * Magnet for edge drags: if `time` is within `threshold` seconds of a word
 * boundary, return that boundary's cut time (see wordEdgeTime); else `time`.
 * In points stick to word starts, Out points to word ends.
 */
export function snapToWord(
  time: number,
  words: TimedWord[],
  edge: TrimEdge,
  fps: number | null,
  threshold: number,
): number {
  let best = time;
  let bestDist = threshold;
  for (const w of words) {
    const cut = wordEdgeTime(w, edge, fps);
    const dist = Math.abs(cut - time);
    if (dist <= bestDist) {
      bestDist = dist;
      best = cut;
    }
  }
  return best;
}
