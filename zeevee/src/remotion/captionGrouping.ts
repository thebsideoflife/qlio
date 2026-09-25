/**
 * Caption grouping shared by the editor and the server render.
 *
 * This file is copied byte-for-byte to backend/src/utils/caption-grouping.ts
 * (a backend test enforces that). Keep it free of imports so both copies stay
 * identical; the types below are structural and match the CaptionWord /
 * CaptionLine types on either side.
 *
 * Rules, in order:
 *   1. A word whose value ends with CAPTION_LINE_BREAK wraps the on-screen line
 *      after it (a manual line break made in the transcript editor).
 *   2. A caption never needs more than `maxLines` on-screen lines of
 *      `maxCharsPerLine` characters, so the words that appear always fit the
 *      caption box for the output frame and font size.
 *   3. Max `maxWords` words, max `maxDuration` seconds, or a pause longer than
 *      `minPauseBetweenLines` starts a new caption (the original rules).
 *   4. A caption stays on screen after its last word ends for `holdSeconds`,
 *      or until the next caption's first word starts, whichever comes first.
 *      `speechEndTime` records when the last word actually ended.
 *
 * Deleted words (empty text) are dropped and never count toward any limit.
 */

export const CAPTION_LINE_BREAK = "\n";
export const CAPTION_HOLD_SECONDS = 5;
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

/** The word as shown on screen: without the line-break marker, trimmed. */
export function captionWordText(value: string | null | undefined): string {
  return String(value ?? "").replace(/\n+$/, "").trim();
}

export function hasCaptionLineBreak(value: string | null | undefined): boolean {
  return typeof value === "string" && value.endsWith(CAPTION_LINE_BREAK);
}

/** A word edit whose visible text is empty is a deletion. */
export function isDeletedCaptionWord(value: string | null | undefined): boolean {
  return captionWordText(value) === "";
}

/** Store a word's text with or without a trailing line break. */
export function withCaptionLineBreak(value: string, lineBreak: boolean): string {
  const text = captionWordText(value);
  if (text === "") return "";
  return lineBreak ? `${text}${CAPTION_LINE_BREAK}` : text;
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
  let pendingBreak = false;
  for (const word of words) {
    const text = captionWordText(word.value);
    if (text === "") continue;
    if (lines === 0) {
      lines = 1;
      lineChars = text.length;
    } else if (pendingBreak || lineChars + 1 + text.length > maxCharsPerLine) {
      lines += 1;
      lineChars = text.length;
    } else {
      lineChars += 1 + text.length;
    }
    pendingBreak = hasCaptionLineBreak(word.value);
  }
  return lines;
}

/** Caption text with manual breaks as newlines, deleted words dropped. */
export function captionTextFromWords(words: readonly GroupableWord[]): string {
  let text = "";
  let separator = "";
  for (const word of words) {
    const value = captionWordText(word.value);
    if (value === "") continue;
    text += separator + value;
    separator = hasCaptionLineBreak(word.value) ? CAPTION_LINE_BREAK : " ";
  }
  return text;
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
  let current: W[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const last = current[current.length - 1];
    captions.push({
      id: `caption-${captions.length}`,
      startTime: current[0].start,
      endTime: last.end,
      speechEndTime: last.end,
      text: captionTextFromWords(current),
      words: [...current],
    });
    current = [];
  };

  for (const word of words) {
    if (isDeletedCaptionWord(word.value)) continue;
    const prev = current.length > 0 ? current[current.length - 1] : null;
    const shouldBreak =
      prev != null &&
      (current.length >= maxWords ||
        word.end - current[0].start > maxDuration ||
        word.start - prev.end > minPauseBetweenLines ||
        captionLineCount([...current, word], maxCharsPerLine) > maxLines);
    if (shouldBreak) flush();
    current.push(word);
  }
  flush();

  return holdCaptions(captions, holdSeconds);
}
