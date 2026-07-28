/**
 * TwelveLabs transcription normalization.
 *
 * TwelveLabs sometimes concatenates two tracks in one `transcription` array,
 * separated by a large backward time jump:
 *   pass A: often a highly repetitive / looped track
 *   pass B: usually the real dialogue, sometimes on a stretched clock
 *           (last timestamp >> real video duration)
 *
 * We do NOT arbitrarily trim dialogue. When TL returns duplicate tracks, we
 * keep the higher-uniqueness track (the real one) and discard the other
 * concatenated copy. If that track's clock is stretched past known media
 * duration, we scale it onto [0, duration].
 *
 * Asset duration must NEVER be derived from transcript timestamps — read it
 * from TwelveLabs/system media metadata (snake_case or camelCase) instead.
 */

/** Split passes when time jumps backward by more than this (seconds). */
export const TRANSCRIPT_BACKJUMP_SEC = 5;

/** Allow words slightly past known duration for float/rounding slack. */
export const TRANSCRIPT_DURATION_SLACK_SEC = 2;

/**
 * If a pass's last timestamp exceeds known duration by this factor, scale
 * that pass down onto [0, duration].
 */
export const TRANSCRIPT_STRETCH_SCALE_TRIGGER = 1.15;

export type TranscriptionWord = {
  start: number;
  end: number;
  value?: string;
  text?: string;
  [key: string]: unknown;
};

export type NormalizeTranscriptionResult = {
  words: TranscriptionWord[];
  /** Words belonging to discarded duplicate TL track(s), if any. */
  discardedDuplicateWords: number;
  droppedPastDuration: number;
  originalCount: number;
  selectedPass: "single" | "first" | "second";
  scaledBy: number;
};

/** @deprecated Use NormalizeTranscriptionResult */
export type SanitizeTranscriptionResult = NormalizeTranscriptionResult & {
  droppedForBackjump: number;
};

function asPositiveNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/**
 * Read duration from a TwelveLabs video metadata object.
 * Prefer snake_case and camelCase system metadata, then other known fields.
 */
export function extractTwelveLabsDuration(video: unknown): number {
  const v = video as Record<string, any> | null | undefined;
  if (!v || typeof v !== "object") return 0;

  const candidates = [
    v.system_metadata?.duration,
    v.systemMetadata?.duration,
    v.metadata?.duration,
    v.hls?.duration,
    v.duration,
  ];

  for (const c of candidates) {
    const n = asPositiveNumber(c);
    if (n > 0) return n;
  }
  return 0;
}

function wordStart(word: TranscriptionWord): number {
  const s = word.start ?? (word as any).startTime;
  return typeof s === "number" && Number.isFinite(s) ? s : 0;
}

function wordEnd(word: TranscriptionWord): number {
  const e = word.end ?? (word as any).endTime;
  return typeof e === "number" && Number.isFinite(e) ? e : wordStart(word);
}

function wordText(word: TranscriptionWord): string {
  const v = word.value ?? word.text ?? "";
  return String(v).toLowerCase();
}

/** Fraction of unique overlapping 8-grams — low means a looped/repeated track. */
export function transcriptUniquenessRatio(words: TranscriptionWord[]): number {
  const toks = words.map(wordText).filter(Boolean);
  if (toks.length < 8) return 1;
  const grams: string[] = [];
  for (let i = 0; i < toks.length - 8; i += 4) {
    grams.push(toks.slice(i, i + 8).join(" "));
  }
  if (grams.length === 0) return 1;
  return new Set(grams).size / grams.length;
}

function normalizePass(raw: unknown[]): TranscriptionWord[] {
  const out: TranscriptionWord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const word = item as TranscriptionWord;
    const start = wordStart(word);
    const end = Math.max(wordEnd(word), start);
    out.push({ ...word, start, end });
  }
  return out;
}

/** Split raw TL array into passes at each large backward time jump. */
export function splitTranscriptionPasses(
  raw: unknown[],
): TranscriptionWord[][] {
  const words = normalizePass(raw);
  if (words.length === 0) return [];

  const passes: TranscriptionWord[][] = [];
  let cur: TranscriptionWord[] = [words[0]];
  let prevStart = words[0].start;

  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w.start < prevStart - TRANSCRIPT_BACKJUMP_SEC) {
      passes.push(cur);
      cur = [w];
    } else {
      cur.push(w);
    }
    prevStart = w.start;
  }
  passes.push(cur);
  return passes;
}

function scalePassToDuration(
  words: TranscriptionWord[],
  durationSec: number,
): { words: TranscriptionWord[]; scaledBy: number } {
  if (words.length === 0 || durationSec <= 0) {
    return { words, scaledBy: 1 };
  }
  const maxEnd = Math.max(...words.map((w) => w.end));
  if (maxEnd <= durationSec * TRANSCRIPT_STRETCH_SCALE_TRIGGER) {
    return { words, scaledBy: 1 };
  }

  const scaledBy = durationSec / maxEnd;
  console.warn(
    `[transcription] Scaling pass onto duration: maxEnd=${maxEnd.toFixed(1)}s → ${durationSec.toFixed(1)}s (×${scaledBy.toFixed(4)})`,
  );

  const scaled = words.map((w) => {
    const start = w.start * scaledBy;
    const end = Math.min(w.end * scaledBy, durationSec);
    return { ...w, start, end: Math.max(end, start) };
  });
  return { words: scaled, scaledBy };
}

function clampToDuration(
  words: TranscriptionWord[],
  durationSec: number,
): { words: TranscriptionWord[]; droppedPastDuration: number } {
  if (durationSec <= 0) {
    return { words, droppedPastDuration: 0 };
  }
  const maxStart = durationSec + TRANSCRIPT_DURATION_SLACK_SEC;
  const kept: TranscriptionWord[] = [];
  let droppedPastDuration = 0;
  for (const w of words) {
    if (w.start > maxStart) {
      droppedPastDuration += 1;
      continue;
    }
    kept.push({
      ...w,
      end: Math.min(w.end, durationSec + TRANSCRIPT_DURATION_SLACK_SEC),
    });
  }
  return { words: kept, droppedPastDuration };
}

/**
 * Normalize a raw TwelveLabs word-level transcription array.
 *
 * When TL concatenates a duplicate/looped track with the real dialogue track,
 * keep the higher-uniqueness track and discard the duplicate copy. Scale a
 * stretched clock onto known media duration when needed.
 */
export function normalizeTwelveLabsTranscription(
  raw: unknown,
  options: { durationSec?: number } = {},
): NormalizeTranscriptionResult {
  const original = Array.isArray(raw) ? raw : [];
  const durationSec =
    typeof options.durationSec === "number" && options.durationSec > 0
      ? options.durationSec
      : 0;

  const passes = splitTranscriptionPasses(original);
  if (passes.length === 0) {
    return {
      words: [],
      discardedDuplicateWords: 0,
      droppedPastDuration: 0,
      originalCount: original.length,
      selectedPass: "single",
      scaledBy: 1,
    };
  }

  let selected = passes[0];
  let selectedPass: NormalizeTranscriptionResult["selectedPass"] = "single";
  let discardedDuplicateWords = 0;

  if (passes.length >= 2) {
    const scored = passes.map((p, idx) => ({
      idx,
      words: p,
      uniq: transcriptUniquenessRatio(p),
      n: p.length,
    }));
    scored.sort((a, b) => b.uniq - a.uniq || b.n - a.n);
    const best = scored[0];
    selected = best.words;
    selectedPass = best.idx === 0 ? "first" : "second";
    discardedDuplicateWords = original.length - selected.length;

    console.warn(
      `[transcription] TwelveLabs returned ${passes.length} concatenated tracks; ` +
        `keeping pass#${best.idx + 1} (uniq=${best.uniq.toFixed(3)}, n=${best.n}) ` +
        `and discarding duplicate track(s): ` +
        scored
          .slice(1)
          .map((s) => `pass#${s.idx + 1}(uniq=${s.uniq.toFixed(3)},n=${s.n})`)
          .join(", "),
    );
  }

  const scaled = scalePassToDuration(selected, durationSec);
  const clamped = clampToDuration(scaled.words, durationSec);

  if (clamped.droppedPastDuration > 0) {
    console.warn(
      `[transcription] Dropped ${clamped.droppedPastDuration} word(s) past duration ${durationSec}s`,
    );
  }

  return {
    words: clamped.words,
    discardedDuplicateWords,
    droppedPastDuration: clamped.droppedPastDuration,
    originalCount: original.length,
    selectedPass,
    scaledBy: scaled.scaledBy,
  };
}

/** @deprecated Prefer normalizeTwelveLabsTranscription */
export function sanitizeTranscription(
  raw: unknown,
  options: { durationSec?: number } = {},
): SanitizeTranscriptionResult {
  const result = normalizeTwelveLabsTranscription(raw, options);
  return {
    ...result,
    droppedForBackjump: result.discardedDuplicateWords,
  };
}

/**
 * Max end timestamp of a transcript array.
 * Do NOT use this to set asset.duration — TL timestamps can be stretched.
 */
export function estimateDurationFromTranscript(
  words: TranscriptionWord[],
): number {
  let maxEnd = 0;
  for (const w of words) {
    const end = wordEnd(w);
    if (end > maxEnd) maxEnd = end;
  }
  return maxEnd;
}
