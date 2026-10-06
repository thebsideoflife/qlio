/**
 * Transcript JSON on S3 is either:
 *   - legacy: CaptionWord[]  ({ start, end, value }[])
 *   - original: { language, words: CaptionWord[] }
 *   - translation: { language, sourceLanguage, lines: CaptionLine[] }
 */
import {
  applyWordEdits,
  groupWordsIntoCaptions as groupCaptions,
  holdCaptions,
  type CaptionGroupingOptions,
  type WordEdit,
} from "./caption-grouping";


export type CaptionWord = {
  start: number;
  end: number;
  value: string;
};

export type CaptionLine = {
  id: string;
  startTime: number;
  endTime: number;
  /** When the last word ended; `endTime` may extend past it by the hold. */
  speechEndTime?: number;
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

/** Pre-versioned Whisper original (`transcriptions/{id}/en.json`). */
export function languageNamedTranscriptKey(
  assetId: string,
  language: string,
): string {
  return `transcriptions/${assetId}/${normalizeLanguageCode(language)}.json`;
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

/** Raw SporeLabs job response for a run. Kept forever: cleanup never deletes it. */
export const SPORELABS_RAW_RESPONSE_FILE = "sporelabs-transcription.json";

export function sporelabsRawResponseKey(
  assetId: string,
  transcriptionVersion: string,
): string {
  return `transcriptions/${assetId}/versions/${encodeURIComponent(transcriptionVersion)}/${SPORELABS_RAW_RESPONSE_FILE}`;
}

/** In-flight SporeLabs job for a run, so a continuation polls instead of resubmitting. */
export function sporelabsJobStateKey(
  assetId: string,
  transcriptionVersion: string,
): string {
  return `transcriptions/${assetId}/versions/${encodeURIComponent(transcriptionVersion)}/sporelabs-job.json`;
}

/**
 * Exact SporeLabs submit request for a run, written before the first POST. A
 * crash between the POST and the job-state write resubmits this same body with
 * the same Idempotency-Key, so SporeLabs returns the original job. Holds a
 * presigned audio URL; removed with the other per-run files at commit.
 */
export function sporelabsSubmitIntentKey(
  assetId: string,
  transcriptionVersion: string,
): string {
  return `transcriptions/${assetId}/versions/${encodeURIComponent(transcriptionVersion)}/sporelabs-submit.json`;
}

/** The 16 kHz WAV handed to SporeLabs. Outside transcriptions/ so it never mixes with transcripts. */
export function transcriptionAudioKey(
  assetId: string,
  transcriptionVersion: string,
): string {
  return `transcription-audio/${assetId}/${encodeURIComponent(transcriptionVersion)}.wav`;
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
    .filter((key) => !key.endsWith(`/${SPORELABS_RAW_RESPONSE_FILE}`))
    .sort();
}

export type TranslationCarryOver = {
  language: string;
  fromUri: string;
  toKey: string;
};

/**
 * Translations to carry onto a replacement transcript. Retranscribing must never
 * drop an asset's other-language captions: each linked translation is copied to
 * the new version's key (caption lines are timed on the video clock, so they stay
 * aligned). A translation into the new transcript's own language is skipped.
 */
export function planTranslationCarryOver(params: {
  assetId: string;
  translations: unknown;
  newTranscriptionVersion: string;
  newOriginalLanguage: string;
}): TranslationCarryOver[] {
  if (!params.translations || typeof params.translations !== "object") return [];
  const original = normalizeLanguageCode(params.newOriginalLanguage);
  const plan: TranslationCarryOver[] = [];
  for (const [rawLanguage, uri] of Object.entries(
    params.translations as Record<string, unknown>,
  )) {
    if (typeof uri !== "string" || !uri.startsWith("s3://")) continue;
    const language = normalizeLanguageCode(rawLanguage);
    if (language === "und" || language === original) continue;
    plan.push({
      language,
      fromUri: uri,
      toKey: translationTranscriptKey(
        params.assetId,
        params.newTranscriptionVersion,
        language,
      ),
    });
  }
  return plan.sort((a, b) => a.language.localeCompare(b.language));
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
  wordEdits?: Record<string, WordEdit> | null,
): CaptionWord[] {
  if (!wordEdits || Object.keys(wordEdits).length === 0) return words;
  return applyWordEdits(words, wordEdits);
}

export function captionsFromParsedTranscript(
  parsed: ParsedTranscriptFile,
  wordEdits?: Record<string, WordEdit> | null,
  options: CaptionGroupingOptions = {},
): CaptionLine[] {
  // Translation lines were grouped when translated; only the hold applies.
  if (parsed.kind === "translation") return holdCaptions(parsed.lines);
  return groupWordsIntoCaptions(
    applyWordEditsToWords(parsed.words, wordEdits),
    options,
  );
}

/**
 * Same rule as the editor: a line is in range when its spoken words overlap it.
 * The hold (`endTime` past `speechEndTime`) never pulls a line into a later
 * segment, so a held caption does not carry over a cut.
 */
export function captionsOverlappingRange(
  captions: CaptionLine[],
  startTime: number,
  endTime: number,
): CaptionLine[] {
  return captions.filter(
    (c) => (c.speechEndTime ?? c.endTime) > startTime && c.startTime < endTime,
  );
}

export function shiftCaptionsBy(
  captions: CaptionLine[],
  offset: number,
): CaptionLine[] {
  return captions.map((c) => ({
    ...c,
    startTime: c.startTime + offset,
    endTime: c.endTime + offset,
    ...(c.speechEndTime != null
      ? { speechEndTime: c.speechEndTime + offset }
      : {}),
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
 * Same grouping as the editor: backend/src/utils/caption-grouping.ts is a
 * byte-for-byte copy of zeevee/src/remotion/captionGrouping.ts.
 */
export function groupWordsIntoCaptions(
  words: CaptionWord[],
  options: CaptionGroupingOptions = {},
): CaptionLine[] {
  return groupCaptions(words, options);
}
