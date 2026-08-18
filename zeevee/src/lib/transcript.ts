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
  return activeLanguage === originalLanguage;
}

export function parseTranscriptPayload(data: unknown): {
  language?: string;
  words: CaptionWord[];
  lines: CaptionLine[];
} {
  if (Array.isArray(data)) {
    return { words: data as CaptionWord[], lines: [] };
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
