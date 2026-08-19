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

export const LEGACY_TRANSCRIPTION_VERSION = "legacy-v1";

export function originalTranscriptKey(
  assetId: string,
  transcriptionVersion: string,
): string {
  return `transcriptions/${assetId}/versions/${encodeURIComponent(transcriptionVersion)}/original.json`;
}

export function translationTranscriptKey(
  assetId: string,
  transcriptionVersion: string,
  targetLanguage: string,
): string {
  return `transcriptions/${assetId}/versions/${encodeURIComponent(transcriptionVersion)}/translations/${normalizeLanguageCode(targetLanguage)}.json`;
}

export function whisperChunkKey(
  assetId: string,
  transcriptionVersion: string,
  index: number,
): string {
  return `transcriptions/${assetId}/versions/${encodeURIComponent(transcriptionVersion)}/chunks/${index}.json`;
}

export function isLegacyTranscriptKey(
  assetId: string,
  transcriptionUrl: string | null | undefined,
): boolean {
  if (!transcriptionUrl) return false;
  const withoutQuery = transcriptionUrl.split("?")[0];
  const key = withoutQuery.startsWith("s3://")
    ? withoutQuery.replace(/^s3:\/\/[^/]+\//, "")
    : withoutQuery.replace(/^\/+/, "");
  return key === `transcriptions/${assetId}.json`;
}

export function inferOriginalTranscriptLanguage(params: {
  assetId: string;
  originalLanguage?: unknown;
  transcriptionUrl?: string | null;
  parsedLanguage?: string | null;
}): string | undefined {
  if (
    typeof params.originalLanguage === "string" &&
    params.originalLanguage.trim()
  ) {
    const normalized = normalizeLanguageCode(params.originalLanguage);
    if (normalized !== "und") return normalized;
  }
  if (params.parsedLanguage) {
    const normalized = normalizeLanguageCode(params.parsedLanguage);
    if (normalized !== "und") return normalized;
  }
  return isLegacyTranscriptKey(params.assetId, params.transcriptionUrl)
    ? "en"
    : undefined;
}

export function transcriptVersionMatches(
  current: unknown,
  expected: string,
): boolean {
  return typeof current === "string" && current === expected;
}

export function selectSupersededTranscriptKeys(params: {
  assetId: string;
  listedKeys: string[];
  keepKeys: string[];
}): string[] {
  const keep = new Set(params.keepKeys);
  const prefix = `transcriptions/${params.assetId}/`;
  const legacy = `transcriptions/${params.assetId}.json`;
  return [...new Set(params.listedKeys)]
    .filter((key) => (key === legacy || key.startsWith(prefix)) && !keep.has(key))
    .sort();
}

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
    return {
      kind: "original",
      language: "en",
      words: wordsFromUnknownArray(data),
    };
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
  return captionsFromParsedTranscript(parsed);
}

export function bucketFromS3Uri(uri: string | null | undefined): string | null {
  if (!uri || !uri.startsWith("s3://")) return null;
  const bucket = uri.slice(5).split("/")[0];
  return bucket || null;
}

export function pickTranslationUri(
  translations: Record<string, string> | null | undefined,
  language: string,
): string | undefined {
  if (!translations) return undefined;
  const wanted = normalizeLanguageCode(language);
  const direct = translations[wanted];
  if (typeof direct === "string" && direct) return direct;
  for (const [key, uri] of Object.entries(translations)) {
    if (normalizeLanguageCode(key) === wanted && typeof uri === "string" && uri) {
      return uri;
    }
  }
  return undefined;
}

export function translationUriMatchesVersion(
  uri: string,
  assetId: string,
  transcriptionVersion: string,
  language: string,
): boolean {
  const expected = translationTranscriptKey(
    assetId,
    transcriptionVersion,
    language,
  );
  const withoutQuery = uri.split("?")[0];
  const key = withoutQuery.startsWith("s3://")
    ? withoutQuery.replace(/^s3:\/\/[^/]+\//, "")
    : withoutQuery.replace(/^\/+/, "");
  return key === expected || key.endsWith(`/${expected}`);
}

export function applyWordEditsToWords(
  words: CaptionWord[],
  wordEdits?: Record<string, string> | null,
): CaptionWord[] {
  if (!wordEdits || Object.keys(wordEdits).length === 0) return words;
  return words.map((word) => {
    const key = `${word.start}-${word.end}`;
    return key in wordEdits ? { ...word, value: wordEdits[key] } : word;
  });
}

export function captionsFromParsedTranscript(
  parsed: ParsedTranscriptFile,
  wordEdits?: Record<string, string> | null,
): CaptionLine[] {
  if (parsed.kind === "translation") return parsed.lines;
  return groupWordsIntoCaptions(applyWordEditsToWords(parsed.words, wordEdits));
}

/** Same overlap rule as the editor overlay: any line that is on screen in-range. */
export function captionsOverlappingRange(
  captions: CaptionLine[],
  startTime: number,
  endTime: number,
): CaptionLine[] {
  return captions.filter((c) => c.endTime > startTime && c.startTime < endTime);
}

export function shiftCaptionsBy(
  captions: CaptionLine[],
  offset: number,
): CaptionLine[] {
  return captions.map((c) => ({
    ...c,
    startTime: c.startTime + offset,
    endTime: c.endTime + offset,
    words: (c.words ?? []).map((w) => ({
      ...w,
      start: w.start + offset,
      end: w.end + offset,
    })),
  }));
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
