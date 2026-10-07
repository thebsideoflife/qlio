import type { CaptionLine, CaptionWord } from "@/remotion/types";

export const TRANSLATE_TARGETS = ["en", "es"] as const;
export type TranslateTarget = (typeof TRANSLATE_TARGETS)[number];
export const ORIGINAL_CAPTION_LANGUAGE = "original";

const LABELS: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  und: "Unknown",
};

const ALIASES: Record<string, string> = {
  english: "en",
  spanish: "es",
  castellano: "es",
  french: "fr",
  german: "de",
  portuguese: "pt",
  italian: "it",
  japanese: "ja",
  korean: "ko",
  chinese: "zh",
  mandarin: "zh",
};

export function normalizeLanguageCode(raw: string | null | undefined): string {
  const value = (raw || "").trim().toLowerCase();
  if (!value) return "und";
  if (ALIASES[value]) return ALIASES[value];
  const primary = value.replace("_", "-").split("-")[0];
  return primary.slice(0, 3) || "und";
}

export function languageLabel(code: string | null | undefined): string {
  if (!code || code === ORIGINAL_CAPTION_LANGUAGE || code === "und") {
    return code === "und" ? "Unknown" : "Original";
  }
  return LABELS[code] || code.toUpperCase();
}

export function isOriginalCaptionLanguage(
  activeLanguage: string | null | undefined,
  originalLanguage: string | null | undefined,
): boolean {
  if (!activeLanguage) return true;
  if (activeLanguage === ORIGINAL_CAPTION_LANGUAGE) return true;
  if (!originalLanguage) return false;
  const active = normalizeLanguageCode(activeLanguage);
  const original = normalizeLanguageCode(originalLanguage);
  if (active === "und" || original === "und") return false;
  return active === original;
}

/** ISO code when Whisper actually detected a language; otherwise null. */
export function detectedOriginalLanguage(
  originalLanguage: string | null | undefined,
): string | null {
  if (
    !originalLanguage ||
    originalLanguage === ORIGINAL_CAPTION_LANGUAGE ||
    originalLanguage === "und"
  ) {
    return null;
  }
  return originalLanguage;
}

/**
 * Preserve the backend's canonical original-source order while supporting
 * older API responses that only expose transcriptionUrl.
 */
export function orderedOriginalTranscriptUrls(params: {
  transcriptionCandidates?: string[];
  transcriptionUrl?: string;
}): string[] {
  return [
    ...(Array.isArray(params.transcriptionCandidates)
      ? params.transcriptionCandidates
      : []),
    params.transcriptionUrl,
  ].filter(
    (url, index, urls): url is string =>
      typeof url === "string" &&
      url.length > 0 &&
      urls.indexOf(url) === index,
  );
}

export interface TranscriptWordCard<W extends CaptionWord = CaptionWord> {
  startTime: number;
  endTime: number;
  words: W[];
}

export interface TranscriptLineCard {
  startTime: number;
  endTime: number;
  lines: CaptionLine[];
}

export interface TranscriptGroupingOptions {
  targetDuration?: number;
  fallbackMaxDuration?: number;
  fallbackMaxItems?: number;
  longPause?: number;
}

const SENTENCE_END = /[.!?…]+(?:["'”’)\]}]+)?$/u;

function endsSentence(text: string): boolean {
  return SENTENCE_END.test(text.trim());
}

function packGroups<T>(
  groups: Array<{ items: T[]; hardBreakAfter: boolean }>,
  start: (item: T) => number,
  end: (item: T) => number,
  targetDuration: number,
): Array<{ startTime: number; endTime: number; items: T[] }> {
  const cards: Array<{ startTime: number; endTime: number; items: T[] }> = [];
  let current: T[] = [];

  const flush = () => {
    if (current.length === 0) return;
    cards.push({
      startTime: start(current[0]),
      endTime: end(current[current.length - 1]),
      items: current,
    });
    current = [];
  };

  for (const group of groups) {
    if (group.items.length === 0) continue;
    const combinedStart =
      current.length > 0 ? start(current[0]) : start(group.items[0]);
    const combinedEnd = end(group.items[group.items.length - 1]);
    if (
      current.length > 0 &&
      combinedEnd - combinedStart > targetDuration
    ) {
      flush();
    }
    current.push(...group.items);
    if (group.hardBreakAfter) flush();
  }
  flush();
  return cards;
}

/**
 * Split at sentence punctuation, then use pause/size limits only for an
 * unfinished punctuation-free run. A completed long sentence stays intact.
 */
function sentenceGroups<T>(
  items: T[],
  text: (item: T) => string,
  start: (item: T) => number,
  end: (item: T) => number,
  options: Required<TranscriptGroupingOptions>,
): Array<{ items: T[]; hardBreakAfter: boolean }> {
  const groups: Array<{ items: T[]; hardBreakAfter: boolean }> = [];
  let sentence: T[] = [];

  const flush = (hardBreakAfter = false) => {
    if (sentence.length === 0) return;
    groups.push({ items: sentence, hardBreakAfter });
    sentence = [];
  };

  for (const item of items) {
    const previous = sentence[sentence.length - 1];
    const punctuationFreeFallback =
      previous != null &&
      !sentence.some((entry) => endsSentence(text(entry))) &&
      (start(item) - end(previous) >= options.longPause ||
        sentence.length >= options.fallbackMaxItems ||
        end(previous) - start(sentence[0]) >= options.fallbackMaxDuration);

    if (punctuationFreeFallback) flush(true);
    sentence.push(item);
    if (endsSentence(text(item))) flush();
  }
  flush();
  return groups;
}

function groupingOptions(
  options: TranscriptGroupingOptions,
): Required<TranscriptGroupingOptions> {
  return {
    targetDuration: options.targetDuration ?? 10,
    fallbackMaxDuration: options.fallbackMaxDuration ?? 20,
    fallbackMaxItems: options.fallbackMaxItems ?? 60,
    longPause: options.longPause ?? 2,
  };
}

export function groupWordsForTranscript<W extends CaptionWord>(
  words: W[],
  options: TranscriptGroupingOptions = {},
): TranscriptWordCard<W>[] {
  if (words.length === 0) return [];
  const resolved = groupingOptions(options);
  return packGroups(
    sentenceGroups(
      words,
      (word) => word.value,
      (word) => word.start,
      (word) => word.end,
      resolved,
    ),
    (word) => word.start,
    (word) => word.end,
    resolved.targetDuration,
  ).map(({ startTime, endTime, items }) => ({
    startTime,
    endTime,
    words: items,
  }));
}

/**
 * Display-only grouping for translated captions. Lines remain atomic so their
 * real timing can still drive highlighting and seeking.
 */
export function groupLinesForTranscript(
  lines: CaptionLine[],
  options: TranscriptGroupingOptions = {},
): TranscriptLineCard[] {
  if (lines.length === 0) return [];
  const resolved = groupingOptions(options);
  return packGroups(
    sentenceGroups(
      lines,
      (line) => line.text,
      (line) => line.startTime,
      (line) => line.endTime,
      resolved,
    ),
    (line) => line.startTime,
    (line) => line.endTime,
    resolved.targetDuration,
  ).map(({ startTime, endTime, items }) => ({
    startTime,
    endTime,
    lines: items,
  }));
}

export function parseTranscriptPayload(data: unknown): {
  language?: string;
  words: CaptionWord[];
  lines: CaptionLine[];
} {
  if (Array.isArray(data)) {
    return { language: "en", words: data as CaptionWord[], lines: [] };
  }
  if (!data || typeof data !== "object") {
    return { words: [], lines: [] };
  }
  const obj = data as Record<string, unknown>;
  const language =
    typeof obj.language === "string"
      ? normalizeLanguageCode(obj.language)
      : undefined;

  if (Array.isArray(obj.lines)) {
    const lines: CaptionLine[] = obj.lines.map((raw, i) => {
      const line = raw as Record<string, unknown>;
      const startTime = Number(line.startTime ?? line.start ?? 0);
      const endTime = Number(line.endTime ?? line.end ?? startTime);
      return {
        id: String(line.id ?? `caption-${i}`),
        startTime,
        endTime,
        text: String(line.text ?? ""),
        words: Array.isArray(line.words) ? (line.words as CaptionWord[]) : [],
      };
    });
    return { language, words: [], lines };
  }

  const wordSource = Array.isArray(obj.words)
    ? obj.words
    : Array.isArray(obj.data)
      ? obj.data
      : Array.isArray(obj.transcription)
        ? obj.transcription
        : [];
  return { language, words: wordSource as CaptionWord[], lines: [] };
}

/**
 * Words heard in the cut: any word that overlaps a segment, using the word's
 * current (possibly user-adjusted) timing. A word a segment edge cuts through
 * is still heard and captioned, so it stays, like captionsOverlappingRange
 * does for caption lines.
 */
export function wordsOverlappingSegments<W extends { start: number; end: number }>(
  words: readonly W[],
  segments: ReadonlyArray<{ startTime: number; endTime: number }>,
): W[] {
  return words.filter((word) =>
    segments.some((seg) => word.end > seg.startTime && word.start < seg.endTime),
  );
}
