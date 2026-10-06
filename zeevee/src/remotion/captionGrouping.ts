/**
 * Caption grouping shared by the editor and the server render.
 *
 * This file is copied byte-for-byte to backend/src/utils/caption-grouping.ts
 * (a backend test enforces that). Keep it free of imports so both copies stay
 * identical; the types below are structural and match the CaptionWord /
 * CaptionLine types on either side.
 *
 * Rules, in order:
 *   1. A pause longer than `minPauseBetweenLines` is a caption boundary.
 *   2. Within each continuous phrase, choose the lowest-cost set of captions:
 *      prefer sentence and clause endings, balanced groups, and no lone word.
 *      Each group is limited by `maxWords`, `maxDuration`, and the estimated
 *      `maxLines` / `maxCharsPerLine` caption box fit.
 *   3. A caption stays on screen after its last word ends for `holdSeconds`,
 *      or until the next caption's first word starts, whichever comes first.
 *      `speechEndTime` records when the last word actually ended.
 *
 * Deleted words (empty text) are dropped and never count toward any limit.
 */

export const CAPTION_HOLD_SECONDS = 3.5;
export const CAPTION_MAX_LINES = 2;
export const CAPTION_MAX_WORDS = 8;
export const CAPTION_MAX_DURATION = 3;
export const CAPTION_MIN_PAUSE = 0.3;
/** Average glyph advance (incl. spaces) for the caption fonts, in em. */
const AVG_CHAR_EM = 0.55;
/** CaptionText pads the box 0.6em on each side. */
const BOX_PADDING_EM = 1.2;
const MIN_CHARS_PER_LINE = 8;

export interface GroupableWord {
  start: number;
  end: number;
  value: string;
}

export interface GroupedCaption<W extends GroupableWord = GroupableWord> {
  id: string;
  startTime: number;
  endTime: number;
  /** When the last word ended; `endTime` may extend past it by the hold. */
  speechEndTime?: number;
  text: string;
  words?: W[];
}

export interface CaptionGroupingOptions {
  maxWords?: number;
  maxDuration?: number;
  minPauseBetweenLines?: number;
  /** Characters that fit on one on-screen line. Omit for no width limit. */
  maxCharsPerLine?: number;
  maxLines?: number;
  holdSeconds?: number;
}

/** The word as shown on screen; discard legacy manual line-break markers. */
export function captionWordText(value: string | null | undefined): string {
  return String(value ?? "").replace(/\n+$/, "").trim();
}

/** A word edit whose visible text is empty is a deletion. */
export function isDeletedCaptionWord(value: string | null | undefined): boolean {
  return captionWordText(value) === "";
}

/**
 * A saved word edit, keyed by the word's original transcript timing
 * (`wordEditKey`). A string replaces the text (empty = deleted); an object
 * also moves the word to corrected `start` / `end` seconds. `estimated` marks
 * timing that was guessed (an even split of typed-in words) and still needs
 * a person to check it.
 */
export type WordEdit =
  | string
  | { value: string; start: number; end: number; estimated?: boolean };

export function wordEditKey(word: { start: number; end: number }): string {
  return `${word.start}-${word.end}`;
}

/** The word with its edit applied. A text-only edit keeps the original timing. */
export function editedWord(word: GroupableWord, edit: WordEdit | undefined): GroupableWord {
  if (edit === undefined || edit === null) {
    return { start: word.start, end: word.end, value: word.value };
  }
  if (typeof edit === "string") return { start: word.start, end: word.end, value: edit };
  return { start: edit.start, end: edit.end, value: edit.value };
}

/**
 * An edit that typed several words into one ("the big") becomes one word each,
 * splitting its time evenly. That is how a missing word is added: type it next
 * to a neighbour, then fix the timing if needed.
 */
export function splitEditedWord(word: GroupableWord): GroupableWord[] {
  const parts = captionWordText(word.value).split(/\s+/).filter(Boolean);
  if (parts.length < 2) return [{ start: word.start, end: word.end, value: word.value }];
  const step = (word.end - word.start) / parts.length;
  return parts.map((value, i) => ({
    start: word.start + step * i,
    end: i === parts.length - 1 ? word.end : word.start + step * (i + 1),
    value,
  }));
}

/**
 * Words the user added (not in the transcript) are saved in wordEdits under
 * keys starting with "+", always as { value, start, end }.
 */
export function isAddedWordKey(key: string): boolean {
  return key.startsWith("+");
}

/** The added words in `wordEdits`, each with its key. */
export function addedWords(
  wordEdits?: Record<string, WordEdit> | null,
): Array<GroupableWord & { key: string; estimated?: boolean }> {
  const out: Array<GroupableWord & { key: string; estimated?: boolean }> = [];
  for (const [key, edit] of Object.entries(wordEdits ?? {})) {
    if (!isAddedWordKey(key) || !edit || typeof edit !== "object") continue;
    out.push({
      key,
      start: edit.start,
      end: edit.end,
      value: edit.value,
      ...(edit.estimated ? { estimated: true } : {}),
    });
  }
  return out;
}

/** The transcript timing a word-edit key was made from ("start-end"). */
function timingFromKey(key: string): { start: number; end: number } | null {
  const parts = key.split("-");
  if (parts.length !== 2) return null;
  const start = Number(parts[0]);
  const end = Number(parts[1]);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}

const roundMs = (seconds: number) => Math.round(seconds * 1000) / 1000;

/**
 * Give every word typed into one word its own entry, so each can be timed and
 * edited on its own. The first word stays on its key; the rest become added
 * words. Their time is split evenly, exactly as the captions already showed
 * them, and every one is marked `estimated` until a person checks it.
 * Returns `wordEdits` itself when there is nothing to separate.
 */
export function separateTypedWords(
  wordEdits: Record<string, WordEdit>,
): Record<string, WordEdit> {
  let out: Record<string, WordEdit> | null = null;
  for (const [key, edit] of Object.entries(wordEdits)) {
    const text = typeof edit === "string" ? edit : edit?.value;
    const parts = captionWordText(text).split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const timing = typeof edit === "string" ? timingFromKey(key) : edit;
    if (!timing || !(timing.end > timing.start)) continue;

    out ??= { ...wordEdits };
    const step = (timing.end - timing.start) / parts.length;
    const edge = (i: number) =>
      i === 0 ? timing.start : i === parts.length ? timing.end : roundMs(timing.start + step * i);
    out[key] = { value: parts[0], start: edge(0), end: edge(1), estimated: true };
    const base = `+${key.replace(/^\+/, "")}`;
    let n = 1;
    for (let i = 1; i < parts.length; i++) {
      while (`${base}.${n}` in out) n++;
      out[`${base}.${n}`] = { value: parts[i], start: edge(i), end: edge(i + 1), estimated: true };
    }
  }
  return out ?? wordEdits;
}

/** Transcript words with every edit applied (added words included), in time order. */
export function applyWordEdits(
  words: readonly GroupableWord[],
  wordEdits?: Record<string, WordEdit> | null,
): GroupableWord[] {
  const edits = wordEdits ?? {};
  return [
    ...words.map((word) => {
      const key = wordEditKey(word);
      const edit = Object.prototype.hasOwnProperty.call(edits, key) ? edits[key] : undefined;
      return editedWord(word, edit);
    }),
    ...addedWords(edits).map(({ start, end, value }) => ({ start, end, value })),
  ]
    // Edits saved before words were separated still split evenly.
    .flatMap(splitEditedWord)
    .sort((a, b) => a.start - b.start);
}

/** Output frame for a project aspect ratio (matches the Remotion compositions). */
export function outputFrameForAspect(aspectRatio: string | null | undefined): {
  width: number;
  height: number;
} {
  switch (aspectRatio) {
    case "9:16":
      return { width: 1080, height: 1920 };
    case "1:1":
      return { width: 1080, height: 1080 };
    default:
      return { width: 1920, height: 1080 };
  }
}

/**
 * How many characters fit on one caption line for this style and frame.
 * fontSize is a % of frame height, maxWidth a % of frame width (see CaptionStyle).
 */
export function captionCharsPerLine(
  style: { fontSize: number; maxWidth: number },
  frame: { width: number; height: number },
): number {
  const fontPx = (style.fontSize / 100) * frame.height;
  if (!(fontPx > 0)) return Number.POSITIVE_INFINITY;
  const boxPx = (style.maxWidth / 100) * frame.width - BOX_PADDING_EM * fontPx;
  return Math.max(MIN_CHARS_PER_LINE, Math.floor(boxPx / (fontPx * AVG_CHAR_EM)));
}

/** Grouping options for a project's caption style and output aspect. */
export function captionGroupingOptions(
  style: { fontSize: number; maxWidth: number } | null | undefined,
  aspectRatio: string | null | undefined,
): CaptionGroupingOptions {
  if (!style) return {};
  return {
    maxCharsPerLine: captionCharsPerLine(style, outputFrameForAspect(aspectRatio)),
  };
}

/** On-screen lines needed to show these words, wrapping at `maxCharsPerLine`. */
export function captionLineCount(
  words: readonly GroupableWord[],
  maxCharsPerLine: number,
): number {
  let lines = 0;
  let lineChars = 0;
  for (const word of words) {
    const text = captionWordText(word.value);
    if (text === "") continue;
    if (lines === 0) {
      lines = 1;
      lineChars = text.length;
    } else if (lineChars + 1 + text.length > maxCharsPerLine) {
      lines += 1;
      lineChars = text.length;
    } else {
      lineChars += 1 + text.length;
    }
  }
  return lines;
}

/** Caption text with deleted words dropped. */
export function captionTextFromWords(words: readonly GroupableWord[]): string {
  return words.map((word) => captionWordText(word.value)).filter(Boolean).join(" ");
}

/** Sentence punctuation has priority; commas and similar marks are softer cues. */
function boundaryScore(value: string): number {
  const text = captionWordText(value);
  if (/[.!?]["'’”)]*$/.test(text)) return -10;
  if (/[,;:]["'’”)]*$/.test(text)) return -4;
  return 0;
}

/** Choose phrase boundaries globally so a full caption does not strand one word. */
function groupPhrase<W extends GroupableWord>(
  words: readonly W[],
  maxWords: number,
  maxDuration: number,
  maxCharsPerLine: number,
  maxLines: number,
): W[][] {
  const best = Array<number>(words.length + 1).fill(Number.POSITIVE_INFINITY);
  const next = Array<number>(words.length).fill(words.length);
  best[words.length] = 0;

  for (let start = words.length - 1; start >= 0; start--) {
    const limit = Math.min(words.length, start + Math.max(1, maxWords));
    for (let end = start + 1; end <= limit; end++) {
      const group = words.slice(start, end);
      if (end > start + 1 && (
        group[group.length - 1].end - group[0].start > maxDuration ||
        captionLineCount(group, maxCharsPerLine) > maxLines
      )) break;

      const size = end - start;
      // Make a singleton very expensive, even at a sentence boundary.
      const orphanCost = size === 1 && words.length > 1 ? 40 : size === 2 ? 5 : 0;
      const shortCost = size < 4 ? 4 - size : 0;
      const balanceCost = Math.pow(Math.max(0, Math.min(maxWords, 8) - size), 2) / 4;
      const endsPhrase = end === words.length;
      const punctuation = endsPhrase ? 0 : boundaryScore(words[end - 1].value);
      const crossesSentence = group.slice(0, -1).some(
        (word) => boundaryScore(word.value) === -10,
      ) ? 20 : 0;
      const cost = 12 + orphanCost + shortCost + balanceCost + punctuation + crossesSentence + best[end];
      // Stable tie-break: prefer the earlier boundary.
      if (cost < best[start]) {
        best[start] = cost;
        next[start] = end;
      }
    }
  }

  const groups: W[][] = [];
  for (let start = 0; start < words.length; start = next[start]) {
    groups.push(words.slice(start, next[start]));
  }
  return groups;
}

/**
 * Keep each caption on screen after its last word for `holdSeconds`, or until
 * the next caption starts. Idempotent: re-applying to held captions is a no-op.
 */
export function holdCaptions<C extends GroupedCaption>(
  captions: readonly C[],
  holdSeconds: number = CAPTION_HOLD_SECONDS,
): C[] {
  return captions.map((caption, index) => {
    const speechEndTime = caption.speechEndTime ?? caption.endTime;
    const next = captions[index + 1];
    const heldEnd = speechEndTime + Math.max(0, holdSeconds);
    const endTime = Math.max(
      speechEndTime,
      next ? Math.min(heldEnd, next.startTime) : heldEnd,
    );
    return { ...caption, speechEndTime, endTime };
  });
}

/**
 * Groups word-level transcript data into caption lines. See the file comment
 * for the rules. Returns captions with the hold already applied.
 */
export function groupWordsIntoCaptions<W extends GroupableWord>(
  words: readonly W[],
  options: CaptionGroupingOptions = {},
): GroupedCaption<W>[] {
  const {
    maxWords = CAPTION_MAX_WORDS,
    maxDuration = CAPTION_MAX_DURATION,
    minPauseBetweenLines = CAPTION_MIN_PAUSE,
    maxCharsPerLine = Number.POSITIVE_INFINITY,
    maxLines = CAPTION_MAX_LINES,
    holdSeconds = CAPTION_HOLD_SECONDS,
  } = options;

  const captions: GroupedCaption<W>[] = [];
  let phrase: W[] = [];

  const flush = () => {
    for (const current of groupPhrase(phrase, maxWords, maxDuration, maxCharsPerLine, maxLines)) {
      const last = current[current.length - 1];
      captions.push({
        id: `caption-${captions.length}`,
        startTime: current[0].start,
        endTime: last.end,
        speechEndTime: last.end,
        text: captionTextFromWords(current),
        words: [...current],
      });
    }
    phrase = [];
  };

  for (const word of words) {
    if (isDeletedCaptionWord(word.value)) continue;
    const prev = phrase[phrase.length - 1];
    if (prev && word.start - prev.end > minPauseBetweenLines) flush();
    phrase.push(word);
  }
  flush();

  return holdCaptions(captions, holdSeconds);
}
