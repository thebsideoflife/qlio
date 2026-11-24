/**
 * Where a clip's cuts fall in the script. Pure, so the script panel and the
 * tests agree on which word carries the In / Out marker.
 */
import { minTrimDuration, wordEdgeTime } from "@/lib/trimMath";

interface Word {
  key: string;
  start: number;
  end: number;
}

interface Clip {
  startTime: number;
  endTime: number;
}

export interface ScriptClipMarks {
  /** Word the In marker sits before (first word heard in the clip). */
  inKey: string | null;
  /** Word the Out marker sits after (last word heard in the clip). */
  outKey: string | null;
  /** The cut falls part-way through that word. */
  inSplitsWord: boolean;
  outSplitsWord: boolean;
  /** Words heard (at least partly) inside the clip. */
  inClip: Set<string>;
}

/** Overlap needed for a word to count as heard in the clip (seconds). */
const HEARD = 0.02;

export function scriptClipMarks(
  words: Word[],
  clip: Clip | null,
  fps: number | null,
): ScriptClipMarks {
  const empty: ScriptClipMarks = {
    inKey: null,
    outKey: null,
    inSplitsWord: false,
    outSplitsWord: false,
    inClip: new Set(),
  };
  if (!clip) return empty;
  const tolerance = fps && fps > 0 ? 1 / fps : 0.04;
  let first: Word | null = null;
  let last: Word | null = null;
  for (const w of words) {
    const overlap = Math.min(w.end, clip.endTime) - Math.max(w.start, clip.startTime);
    if (overlap < HEARD) continue;
    empty.inClip.add(w.key);
    if (!first || w.start < first.start) first = w;
    if (!last || w.end > last.end) last = w;
  }
  if (!first || !last) return empty;
  return {
    ...empty,
    inKey: first.key,
    outKey: last.key,
    inSplitsWord: first.start < clip.startTime - tolerance,
    outSplitsWord: last.end > clip.endTime + tolerance,
  };
}

/** Set of word keys heard inside any of the clips. */
export function wordsInAnyClip(words: Word[], clips: Clip[]): Set<string> {
  const out = new Set<string>();
  for (const w of words) {
    if (
      clips.some(
        (c) => Math.min(w.end, c.endTime) - Math.max(w.start, c.startTime) >= HEARD,
      )
    ) {
      out.add(w.key);
    }
  }
  return out;
}

/** Clip bounds that start on `first` and end after `last`, frame-aligned. */
export function clipFromWords(
  first: { start: number; end: number },
  last: { start: number; end: number },
  fps: number | null,
  total: number,
): { start: number; end: number } {
  const start = Math.max(0, wordEdgeTime(first, "start", fps));
  const end = Math.min(total, Math.max(wordEdgeTime(last, "end", fps), start + minTrimDuration(fps)));
  return { start, end };
}
