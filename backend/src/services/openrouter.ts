import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { languageLabel, type CaptionWord } from "../utils/transcript-format";

const secretsClient = new SecretsManagerClient({});

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
// Accuracy is the product requirement. Do not make this environment-selectable:
// a silent switch to a distilled/turbo model changes transcript timing/content.
export const WHISPER_MODEL = "openai/whisper-large-v3" as const;
export const TRANSLATE_MODEL =
  process.env.OPENROUTER_TRANSLATE_MODEL || "openai/gpt-4o-mini";

/** verbose_json + word timestamps only work on OpenAI-compatible STT providers. */
const STT_PROVIDER = {
  order: ["groq", "openai", "together"],
  allow_fallbacks: true,
  require_parameters: true,
};

export const STT_TIMEOUT_MS = 55_000;
export const STT_RETRIES = 3;

let cachedApiKey: string | null = null;

export async function getOpenRouterApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const secretArn = process.env.OPENROUTER_SECRET_ARN;
  if (!secretArn) {
    throw new Error("OPENROUTER_SECRET_ARN is not set");
  }
  const result = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  const key = result.SecretString?.trim();
  if (!key || key.startsWith("REPLACE_ME")) {
    throw new Error("OpenRouter API key is missing in Secrets Manager");
  }
  cachedApiKey = key;
  return key;
}

function openRouterHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "HTTP-Referer": "https://qlio.app",
    "X-Title": "Qlio",
  };
}

export type WhisperTranscription = {
  text: string;
  language?: string;
  duration?: number;
  words: CaptionWord[];
};

type WhisperWord = {
  word?: string;
  text?: string;
  start?: number;
  end?: number;
};

type WhisperSegment = {
  start?: number;
  end?: number;
  text?: string;
  words?: WhisperWord[];
};

type WhisperResponse = {
  text?: string;
  language?: string;
  duration?: number;
  words?: WhisperWord[];
  segments?: WhisperSegment[];
  error?: { message?: string };
  message?: string;
};

function mapWhisperWords(
  words: WhisperWord[] | undefined,
  offsetSec: number,
): CaptionWord[] {
  if (!words?.length) return [];
  const out: CaptionWord[] = [];
  for (const w of words) {
    const value = String(w.word ?? w.text ?? "").trim();
    if (!value) continue;
    const start = (typeof w.start === "number" ? w.start : 0) + offsetSec;
    const end = (typeof w.end === "number" ? w.end : start) + offsetSec;
    out.push({ start, end: Math.max(end, start), value });
  }
  return out;
}

function nestedSegmentWords(
  segments: WhisperSegment[] | undefined,
): CaptionWord[] {
  if (!segments?.length) return [];
  return segments.flatMap((s) => mapWhisperWords(s.words, 0));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export async function transcribeAudioChunk(params: {
  apiKey: string;
  audio: Buffer;
  filename: string;
  format?: "wav" | "mp3" | "flac";
  maxAttempts?: number;
}): Promise<WhisperTranscription> {
  const format = params.format || "wav";
  const maxAttempts = Math.max(
    1,
    Math.min(STT_RETRIES, params.maxAttempts ?? STT_RETRIES),
  );
  const payload = {
    model: WHISPER_MODEL,
    response_format: "verbose_json",
    timestamp_granularities: ["word"],
    provider: STT_PROVIDER,
    input_audio: {
      data: params.audio.toString("base64"),
      format,
    },
  };

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(`${OPENROUTER_BASE}/audio/transcriptions`, {
        method: "POST",
        headers: {
          ...openRouterHeaders(params.apiKey),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(STT_TIMEOUT_MS),
      });

      const text = await response.text();
      let data: WhisperResponse;
      try {
        data = JSON.parse(text) as WhisperResponse;
      } catch {
        throw new Error(
          `OpenRouter STT returned non-JSON (${response.status}): ${text.slice(0, 300)}`,
        );
      }

      if (!response.ok) {
        const msg =
          data.error?.message ||
          data.message ||
          text.slice(0, 300) ||
          response.statusText;
        const err = new Error(`OpenRouter STT ${response.status}: ${msg}`);
        if (isRetryableStatus(response.status) && attempt < maxAttempts) {
          lastError = err;
          await sleep(1000 * 2 ** (attempt - 1));
          continue;
        }
        throw err;
      }

      const words =
        mapWhisperWords(data.words, 0).length > 0
          ? mapWhisperWords(data.words, 0)
          : nestedSegmentWords(data.segments);

      return {
        text: data.text || "",
        language: data.language,
        duration: data.duration,
        words,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const retryable =
        lastError.name === "TimeoutError" ||
        lastError.name === "AbortError" ||
        /STT 5\d\d|STT 429|STT 408/.test(lastError.message);
      if (retryable && attempt < maxAttempts) {
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError || new Error("OpenRouter STT failed");
}

function translationLanguageName(code: string): string {
  const normalized = (code || "").trim().toLowerCase();
  if (!normalized || normalized === "und") {
    return "the original spoken language";
  }
  return languageLabel(normalized);
}

function alignTranslationBatch(
  source: string[],
  translated: string[],
): string[] {
  if (translated.length === source.length) return translated;
  if (translated.length > source.length) return translated.slice(0, source.length);
  return [...translated, ...source.slice(translated.length)];
}

export async function translateCaptionLines(params: {
  apiKey: string;
  sourceLanguage: string;
  targetLanguage: string;
  lines: string[];
}): Promise<string[]> {
  if (params.lines.length === 0) return [];

  const sourceName = translationLanguageName(params.sourceLanguage);
  const targetName = translationLanguageName(params.targetLanguage);
  const system = `You translate burnt-in video captions. Translate each line from ${sourceName} to ${targetName}. Keep proper names, numbers, and on-screen terms. Do not merge or split lines. Return JSON: {"lines":["..."]} with the same number of strings, same order.`;

  const BATCH = 40;
  const out: string[] = [];

  for (let i = 0; i < params.lines.length; i += BATCH) {
    const batch = params.lines.slice(i, i + BATCH);
    const payload = {
      model: TRANSLATE_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: JSON.stringify({ lines: batch }),
        },
      ],
    };

    let lastError: Error | null = null;
    let translated: string[] | null = null;
    for (let attempt = 1; attempt <= STT_RETRIES; attempt++) {
      try {
        const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
          method: "POST",
          headers: {
            ...openRouterHeaders(params.apiKey),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(STT_TIMEOUT_MS),
        });

        const raw = await response.text();
        if (!response.ok) {
          const err = new Error(
            `OpenRouter chat ${response.status}: ${raw.slice(0, 400)}`,
          );
          if (isRetryableStatus(response.status) && attempt < STT_RETRIES) {
            lastError = err;
            await sleep(1000 * 2 ** (attempt - 1));
            continue;
          }
          throw err;
        }

        const parsed = JSON.parse(raw) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = parsed.choices?.[0]?.message?.content;
        if (!content) {
          throw new Error("OpenRouter translation returned empty content");
        }

        try {
          const json = JSON.parse(content) as { lines?: unknown };
          if (Array.isArray(json.lines)) {
            translated = json.lines.map((line) => String(line ?? ""));
          }
        } catch {
          throw new Error(
            `Could not parse translation JSON: ${content.slice(0, 200)}`,
          );
        }
        if (translated && translated.length !== batch.length) {
          if (attempt < STT_RETRIES) {
            lastError = new Error(
              `Translation length mismatch: got ${translated.length}, expected ${batch.length}`,
            );
            translated = null;
            await sleep(1000 * 2 ** (attempt - 1));
            continue;
          }
          console.warn(
            `[translate] length mismatch after ${STT_RETRIES} attempts; aligning ${translated.length} -> ${batch.length}`,
          );
          translated = alignTranslationBatch(batch, translated);
        }
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const retryable =
          lastError.name === "TimeoutError" ||
          lastError.name === "AbortError" ||
          /chat 5\d\d|chat 429/.test(lastError.message);
        if (retryable && attempt < STT_RETRIES) {
          await sleep(1000 * 2 ** (attempt - 1));
          continue;
        }
        throw lastError;
      }
    }

    if (!translated) {
      throw lastError || new Error("Translation batch failed");
    }
    if (translated.length !== batch.length) {
      console.warn(
        `[translate] aligning batch length ${translated.length} -> ${batch.length}`,
      );
      translated = alignTranslationBatch(batch, translated);
    }
    out.push(...translated);
  }

  return out;
}
