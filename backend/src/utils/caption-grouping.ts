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
 *   3. A caption stays on screen for `holdSeconds` after its last word ends,
 *      and at least long enough to read (CAPTION_MIN_DISPLAY seconds, and
 *      CAPTION_READING_CPS characters a second), never past the next caption.
 *      A gap shorter than CAPTION_BRIDGE_GAP is closed so captions don't flicker.
 *      `speechEndTime` records when the last word actually ended.
 *   4. Two-line captions break at a phrase boundary, not mid-phrase: never
 *      after an article, preposition, auxiliary or subject pronoun, never
 *      between two capitalised names, preferring punctuation and balanced
 *      lines (Qlio Caption Runbook, step 4). `lineBreakBefore` is the start
 *      time of the first word on the second line.
 *
 * Deleted words (empty text) are dropped and never count toward any limit.
 */

/** Linger after the last word is spoken (runbook: don't stay up long after speech). */
export const CAPTION_HOLD_SECONDS = 0.5;
/** Shortest time a caption is shown, when the next caption leaves room. */
export const CAPTION_MIN_DISPLAY = 0.8;
/** Reading speed used to give longer captions more time on screen. */
export const CAPTION_READING_CPS = 17;
/** Above this many characters a second a caption is too fast to read. */
export const CAPTION_MAX_CPS = 20;
/** Gaps shorter than this between captions are closed to avoid flicker. */
export const CAPTION_BRIDGE_GAP = 0.5;
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
  /** Start time of the first word on the second line, for two-line captions. */
  lineBreakBefore?: number;
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

/** A free key for a word added after the word saved under `afterKey`. */
export function nextAddedWordKey(
  wordEdits: Record<string, WordEdit>,
  afterKey: string,
): string {
  const base = `+${afterKey.replace(/^\+/, "")}`;
  let n = 1;
  while (`${base}.${n}` in wordEdits) n++;
  return `${base}.${n}`;
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
    for (let i = 1; i < parts.length; i++) {
      out[nextAddedWordKey(out, key)] = {
        value: parts[i],
        start: edge(i),
        end: edge(i + 1),
        estimated: true,
      };
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
      // A lone word is very expensive, except a sentence-ending word after a
      // beat: that is a reveal, held until it is spoken.
      const gapBefore = start > 0 ? words[start].start - words[start - 1].end : 0;
      const isBeat =
        size === 1 && start > 0 && gapBefore >= 0.2 && boundaryScore(words[start].value) === -10;
      const orphanCost = isBeat ? -10 : size === 1 && words.length > 1 ? 40 : size === 2 ? 5 : 0;
      // A short pause inside the phrase is a natural place to change caption.
      const gapAfter = end < words.length ? words[end].start - words[end - 1].end : 0;
      const pauseCost = gapAfter >= 0.12 ? -Math.min(6, gapAfter * 30) : 0;
      // Too many characters for the time the caption is up reads too fast.
      const shownUntil = end < words.length ? words[end].start : group[group.length - 1].end + CAPTION_HOLD_SECONDS;
      const cps = captionTextFromWords(group).length / Math.max(0.1, shownUntil - group[0].start);
      const rateCost = cps > CAPTION_MAX_CPS ? (cps - CAPTION_MAX_CPS) * 2 : 0;
      const shortCost = size < 4 && !isBeat ? 4 - size : 0;
      const balanceCost = isBeat ? 0 : Math.pow(Math.max(0, Math.min(maxWords, 8) - size), 2) / 4;
      const endsPhrase = end === words.length;
      const punctuation = endsPhrase ? 0 : boundaryScore(words[end - 1].value);
      const crossesSentence = group.slice(0, -1).some(
        (word) => boundaryScore(word.value) === -10,
      ) ? 20 : 0;
      const cost = 12 + orphanCost + shortCost + balanceCost + punctuation + crossesSentence +
        pauseCost + rateCost + best[end];
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

/** Seconds a caption of this text needs on screen to be read. */
export function captionReadingTime(text: string): number {
  const chars = String(text ?? "").replace(/\s+/g, " ").trim().length;
  return Math.max(CAPTION_MIN_DISPLAY, chars / CAPTION_READING_CPS);
}

/**
 * Set how long each caption stays up: `holdSeconds` past its last word, at
 * least its reading time, never into the next caption, and up to the next
 * caption when the gap is under CAPTION_BRIDGE_GAP. Idempotent: re-applying
 * to held captions is a no-op.
 */
export function holdCaptions<C extends GroupedCaption>(
  captions: readonly C[],
  holdSeconds: number = CAPTION_HOLD_SECONDS,
): C[] {
  return captions.map((caption, index) => {
    const speechEndTime = caption.speechEndTime ?? caption.endTime;
    const next = captions[index + 1];
    let endTime = Math.max(
      speechEndTime + Math.max(0, holdSeconds),
      caption.startTime + captionReadingTime(caption.text),
    );
    if (next) {
      if (next.startTime - endTime < CAPTION_BRIDGE_GAP) endTime = next.startTime;
      endTime = Math.min(endTime, next.startTime);
    }
    return { ...caption, speechEndTime, endTime: Math.max(speechEndTime, endTime) };
  });
}

/* ---- Line breaks ------------------------------------------------------- */

// Words that bind to the word after them: a line should not end on one.
const BINDS_FORWARD = new Set([
  // articles and determiners
  "a", "an", "the", "this", "that", "these", "those", "my", "your", "his", "her",
  "its", "our", "their", "some", "any", "no", "every", "each", "another", "such",
  // prepositions
  "in", "on", "at", "to", "of", "for", "with", "from", "by", "about", "into",
  "onto", "over", "under", "after", "before", "through", "between", "without",
  "around", "against", "during", "toward", "towards", "upon", "within", "like",
  // auxiliaries and modals
  "am", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "can", "could", "should", "may", "might",
  "must", "shall", "i'm", "you're", "we're", "they're", "he's", "she's", "it's",
  "i've", "you've", "we've", "they've", "i'll", "you'll", "we'll", "they'll",
  "i'd", "you'd", "we'd", "they'd", "don't", "doesn't", "didn't", "can't",
  "won't", "wouldn't", "couldn't", "shouldn't", "isn't", "aren't", "wasn't",
  "weren't", "haven't", "hasn't", "hadn't",
  // subject pronouns and negation
  "i", "you", "he", "she", "we", "they", "it", "not", "never",
  // conjunctions belong with the phrase they introduce
  "and", "but", "or", "nor", "so", "yet", "because", "if", "when", "while",
  "although", "though", "unless", "until", "since", "than", "whether",
  "who", "whom", "whose", "which", "where", "what", "how", "why",
]);

const DETERMINERS = new Set([
  "a", "an", "the", "this", "that", "these", "those", "my", "your", "his", "her",
  "its", "our", "their", "some", "any", "no", "every", "each", "another", "such",
]);

// Words that make a good start for a second line.
const STARTS_LINE = new Set([
  "and", "but", "or", "so", "because", "if", "when", "while", "that", "which",
  "who", "where", "what", "how", "why", "to", "in", "on", "at", "with", "for",
  "from", "about",
]);

function bareWord(value: string): string {
  return captionWordText(value).toLowerCase().replace(/[^a-z'’]/g, "").replace(/’/g, "'");
}

function isCapitalised(value: string): boolean {
  return /^["'(]*[A-Z][a-z]/.test(captionWordText(value));
}

function lineLength(words: readonly GroupableWord[]): number {
  return captionTextFromWords(words).length;
}

/**
 * Where to break a caption onto two lines: the index of the first word on
 * the second line, or null when it fits on one line or cannot be split.
 */
export function chooseLineBreak(
  words: readonly GroupableWord[],
  maxCharsPerLine: number,
): number | null {
  const visible = words.filter((word) => !isDeletedCaptionWord(word.value));
  if (visible.length < 2) return null;
  if (!Number.isFinite(maxCharsPerLine) || lineLength(visible) <= maxCharsPerLine) return null;

  let bestIndex: number | null = null;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let k = 1; k < visible.length; k++) {
    const top = visible.slice(0, k);
    const bottom = visible.slice(k);
    const topLen = lineLength(top);
    const bottomLen = lineLength(bottom);
    const overflow =
      Math.max(0, topLen - maxCharsPerLine) + Math.max(0, bottomLen - maxCharsPerLine);

    const last = top[top.length - 1].value;
    const first = bottom[0].value;
    let cost = overflow * 100;
    // Balanced lines; a slightly longer second line reads more naturally.
    cost += (Math.abs(topLen - bottomLen) / Math.max(1, maxCharsPerLine)) * 12;
    if (topLen > bottomLen) cost += 1;
    // Punctuation is the best place to break.
    const punct = boundaryScore(last);
    if (punct === -10) cost -= 12;
    else if (punct === -4) cost -= 7;
    else if (BINDS_FORWARD.has(bareWord(last))) cost += 10;
    // "the biggest / problem": a determiner then one word is usually an
    // adjective waiting for its noun.
    else if (top.length >= 2 && DETERMINERS.has(bareWord(top[top.length - 2].value))) cost += 8;
    // Keep first + last names together.
    if (punct === 0 && k > 1 && isCapitalised(last) && isCapitalised(first) && bareWord(last) !== "i") cost += 10;
    if (STARTS_LINE.has(bareWord(first))) cost -= 2;
    // No stranded word on either line.
    if (top.length === 1 || bottom.length === 1) cost += 8;

    if (cost < bestCost) {
      bestCost = cost;
      bestIndex = k;
    }
  }
  if (bestIndex == null) return null;
  // Translate back to an index in `words` (deleted words keep their places).
  const target = visible[bestIndex];
  const index = words.indexOf(target);
  return index > 0 ? index : null;
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
      const breakAt = maxLines >= 2 ? chooseLineBreak(current, maxCharsPerLine) : null;
      captions.push({
        id: `caption-${captions.length}`,
        startTime: current[0].start,
        endTime: last.end,
        speechEndTime: last.end,
        text: captionTextFromWords(current),
        words: [...current],
        ...(breakAt != null ? { lineBreakBefore: current[breakAt].start } : {}),
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

/* ---- Automatic checks (Qlio Caption Runbook, step 8) ------------------- */

export type CaptionIssue =
  | "too_fast" // over CAPTION_MAX_CPS characters a second
  | "too_brief" // shown for less than CAPTION_MIN_DISPLAY seconds
  | "too_many_lines" // more than two lines
  | "too_many_words" // more than 14 words
  | "stranded_word" // one word alone on a line beside a longer one
  | "unbalanced"; // one line under 40% of the other's length

export interface CaptionCheck {
  id: string;
  startTime: number;
  issues: CaptionIssue[];
}

/**
 * The runbook's code-checkable questions for each caption: reading rate,
 * minimum duration, line count, words per caption and line shape. Captions
 * without word timing (translations) are checked on rate and duration only.
 */
export function checkCaptions(
  captions: readonly GroupedCaption[],
  maxCharsPerLine: number = Number.POSITIVE_INFINITY,
): CaptionCheck[] {
  const out: CaptionCheck[] = [];
  for (const caption of captions) {
    const issues: CaptionIssue[] = [];
    const shown = caption.endTime - caption.startTime;
    const chars = String(caption.text ?? "").replace(/\s+/g, " ").trim().length;
    if (chars / Math.max(0.05, shown) > CAPTION_MAX_CPS + 1e-9) issues.push("too_fast");
    if (shown < CAPTION_MIN_DISPLAY - 1e-9) issues.push("too_brief");
    const words = (caption.words ?? []).filter((word) => !isDeletedCaptionWord(word.value));
    if (words.length > 14) issues.push("too_many_words");
    if (words.length > 0) {
      const breakIndex = caption.lineBreakBefore == null
        ? -1
        : words.findIndex((word) => Math.abs(word.start - caption.lineBreakBefore!) < 1e-6);
      if (breakIndex > 0) {
        const top = words.slice(0, breakIndex);
        const bottom = words.slice(breakIndex);
        const overflow =
          captionLineCount(top, maxCharsPerLine) + captionLineCount(bottom, maxCharsPerLine) > 2;
        if (overflow) issues.push("too_many_lines");
        if ((top.length === 1 && bottom.length >= 3) || (bottom.length === 1 && top.length >= 3)) {
          issues.push("stranded_word");
        }
        const a = lineLength(top);
        const b = lineLength(bottom);
        if (Math.min(a, b) < 0.4 * Math.max(a, b)) issues.push("unbalanced");
      } else if (captionLineCount(words, maxCharsPerLine) > 2) {
        issues.push("too_many_lines");
      }
    }
    if (issues.length > 0) out.push({ id: caption.id, startTime: caption.startTime, issues });
  }
  return out;
}
