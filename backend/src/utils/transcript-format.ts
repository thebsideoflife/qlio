/**
 * Transcript JSON on S3 is either:
 *   - legacy: CaptionWord[]  ({ start, end, value }[])
 *   - original: { language, words: CaptionWord[] }
 *   - translation: { language, sourceLanguage, lines: CaptionLine[] }
 */

export type CaptionWord = {
  start: number;
  end: number;
  value: string;
};

export type CaptionLine = {
  id: string;
  startTime: number;
  endTime: number;
  text: string;
  words: CaptionWord[];
};

export type OriginalTranscriptFile = {
  kind: "original";
  language?: string;
  words: CaptionWord[];
};

export type TranslationTranscriptFile = {
  kind: "translation";
  language?: string;
  sourceLanguage?: string;
  lines: CaptionLine[];
};

export type ParsedTranscriptFile =
  | OriginalTranscriptFile
  | TranslationTranscriptFile;

function asFiniteNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeWord(entry: unknown): CaptionWord | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const start = asFiniteNumber(e.start ?? e.startTime);
  const end = Math.max(asFiniteNumber(e.end ?? e.endTime, start), start);
  const value = String(e.value ?? e.word ?? e.text ?? "").trim();
  if (!value) return null;
  return { start, end, value };
}

function normalizeLine(entry: unknown, index: number): CaptionLine | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const text = String(e.text ?? "").trim();
  const startTime = asFiniteNumber(e.startTime ?? e.start);
  const endTime = Math.max(
    asFiniteNumber(e.endTime ?? e.end, startTime),
    startTime,
  );
  if (!text) return null;
  const rawWords = Array.isArray(e.words) ? e.words : [];
  const words = rawWords
    .map(normalizeWord)
    .filter((w): w is CaptionWord => w !== null);
  return {
    id: String(e.id ?? `caption-${index}`),
    startTime,
    endTime,
    text,
    words,
  };
}

function wordsFromUnknownArray(raw: unknown[]): CaptionWord[] {
  return raw
    .map(normalizeWord)
    .filter((w): w is CaptionWord => w !== null)
    .sort((a, b) => a.start - b.start);
}

export function parseTranscriptJson(data: unknown): ParsedTranscriptFile {
  if (Array.isArray(data)) {
    return { kind: "original", words: wordsFromUnknownArray(data) };
  }

  if (!data || typeof data !== "object") {
    return { kind: "original", words: [] };
  }

  const obj = data as Record<string, unknown>;
  const language =
    typeof obj.language === "string" && obj.language.trim()
      ? normalizeLanguageCode(obj.language)
      : undefined;
  const sourceLanguage =
    typeof obj.sourceLanguage === "string" && obj.sourceLanguage.trim()
      ? normalizeLanguageCode(obj.sourceLanguage)
      : undefined;

  if (Array.isArray(obj.lines)) {
    const lines = obj.lines
      .map(normalizeLine)
      .filter((l): l is CaptionLine => l !== null);
    return { kind: "translation", language, sourceLanguage, lines };
  }

  const wordSource = Array.isArray(obj.words)
    ? obj.words
    : Array.isArray(obj.data)
      ? obj.data
      : Array.isArray(obj.transcription)
        ? obj.transcription
        : [];

  return {
    kind: "original",
    language,
    words: wordsFromUnknownArray(wordSource),
  };
}

export function transcriptWordsFromJson(data: unknown): CaptionWord[] {
  const parsed = parseTranscriptJson(data);
  return parsed.kind === "original" ? parsed.words : [];
}

export function transcriptLinesFromJson(data: unknown): CaptionLine[] {
  const parsed = parseTranscriptJson(data);
  if (parsed.kind === "translation") return parsed.lines;
  return groupWordsIntoCaptions(parsed.words);
}

/** ISO-639-1, lowercased. Whisper sometimes returns "spanish" / "en-US". */
export function normalizeLanguageCode(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value) return "und";
  const aliases: Record<string, string> = {
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
  if (aliases[value]) return aliases[value];
  const primary = value.replace("_", "-").split("-")[0];
  return primary.slice(0, 3) || "und";
}

export function languageLabel(code: string): string {
  const labels: Record<string, string> = {
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
  return labels[code] || code.toUpperCase();
}

/**
 * Same break rules as the editor (`groupWordsIntoCaptions`):
 * max 8 words, max 3s, or a pause > 0.3s.
 */
export function groupWordsIntoCaptions(
  words: CaptionWord[],
  options: {
    maxWords?: number;
    maxDuration?: number;
    minPauseBetweenLines?: number;
  } = {},
): CaptionLine[] {
  const { maxWords = 8, maxDuration = 3, minPauseBetweenLines = 0.3 } =
    options;

  if (words.length === 0) return [];

  const captions: CaptionLine[] = [];
  let currentWords: CaptionWord[] = [];
  let lineStartTime = words[0].start;

  const flush = () => {
    if (currentWords.length === 0) return;
    captions.push({
      id: `caption-${captions.length}`,
      startTime: lineStartTime,
      endTime: currentWords[currentWords.length - 1].end,
      text: currentWords.map((w) => w.value).join(" "),
      words: [...currentWords],
    });
    currentWords = [];
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const prevWord = i > 0 ? words[i - 1] : null;
    const shouldBreak =
      currentWords.length >= maxWords ||
      (currentWords.length > 0 && word.end - lineStartTime > maxDuration) ||
      (prevWord != null && word.start - prevWord.end > minPauseBetweenLines);

    if (shouldBreak && currentWords.length > 0) {
      flush();
      lineStartTime = word.start;
    }
    currentWords.push(word);
  }
  flush();
  return captions;
}
