/**
 * OpenAI-compatible client for SporeLabs (`https://sporelabs.dev/v1`).
 *
 * Every model call goes here, pinned to the same models we already used —
 * not Auto/starter:
 *   - Sonnet 4.5          IQ agent, Jockey brief, export-metadata enrich
 *   - Haiku               Pegasus title classifier
 *   - gpt-4o-mini         caption translation
 *   - whisper-large-v3    transcription
 *   - gemini-2.5-pro      framing analysis
 */

import { languageLabel, type CaptionWord } from "../utils/transcript-format";

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const secretsClient = new SecretsManagerClient({});

export const SPORELABS_BASE_URL =
  process.env.SPORELABS_BASE_URL?.replace(/\/$/, "") || "https://sporelabs.dev/v1";

/** Same model as `claude-sonnet-4-5-20250929` / Bedrock inference profile. */
export const SPORELABS_SONNET_MODEL =
  process.env.SPORELABS_SONNET_MODEL || "anthropic/claude-sonnet-4.5";

/** Same model as `anthropic.claude-3-haiku-20240307-v1:0`. */
export const SPORELABS_HAIKU_MODEL =
  process.env.SPORELABS_HAIKU_MODEL || "anthropic/claude-3-haiku";

/** Same model as the OpenRouter translation default. */
export const SPORELABS_TRANSLATE_MODEL =
  process.env.SPORELABS_TRANSLATE_MODEL || "openai/gpt-4o-mini";

/** Same model as production Whisper. Do not silently swap to turbo/distilled. */
export const SPORELABS_WHISPER_MODEL =
  process.env.SPORELABS_WHISPER_MODEL || "openai/whisper-large-v3";

/** Same model as `gemini-2.5-pro` on the Google File API path. */
export const SPORELABS_GEMINI_MODEL =
  process.env.SPORELABS_GEMINI_MODEL || "google/gemini-2.5-pro";

export const WHISPER_MODEL = SPORELABS_WHISPER_MODEL;
export const TRANSLATE_MODEL = SPORELABS_TRANSLATE_MODEL;

export const STT_TIMEOUT_MS = 55_000;
export const STT_RETRIES = 3;
const FRAMING_TIMEOUT_MS = 180_000;

let cachedApiKey: string | null = null;

export async function getSporeLabsApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const secretArn = process.env.SPORELABS_SECRET_ARN;
  if (!secretArn) {
    throw new Error("SPORELABS_SECRET_ARN is not set");
  }
  const result = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  const key = result.SecretString?.trim();
  if (!key || key.startsWith("REPLACE_ME")) {
    throw new Error("SporeLabs API key is missing in Secrets Manager");
  }
  cachedApiKey = key;
  return key;
}

export type SporeLabsChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | SporeLabsContentPart[] | null;
  tool_calls?: SporeLabsToolCall[];
  tool_call_id?: string;
};

export type SporeLabsContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "video_url"; video_url: { url: string } };

export type SporeLabsToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type SporeLabsTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type SporeLabsToolChoice =
  | "auto"
  | "required"
  | "none"
  | { type: "function"; function: { name: string } };

export type SporeLabsChatResult = {
  content: string | null;
  toolCalls: SporeLabsToolCall[];
  finishReason: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
};

export class SporeLabsError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = "SporeLabsError";
  }
}

export async function sporelabsChatCompletions(params: {
  model: string;
  messages: SporeLabsChatMessage[];
  tools?: SporeLabsTool[];
  toolChoice?: SporeLabsToolChoice;
  maxTokens: number;
  temperature?: number;
  responseFormat?: { type: "json_object" };
  timeoutMs?: number;
}): Promise<SporeLabsChatResult> {
  const apiKey = await getSporeLabsApiKey();
  const payload: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
    max_tokens: params.maxTokens,
    temperature: params.temperature ?? 0,
  };
  if (params.tools && params.tools.length > 0) {
    payload.tools = params.tools;
    if (params.toolChoice) payload.tool_choice = params.toolChoice;
  }
  if (params.responseFormat) {
    payload.response_format = params.responseFormat;
  }

  const controller = new AbortController();
  const timer =
    params.timeoutMs !== undefined
      ? setTimeout(() => controller.abort(), params.timeoutMs)
      : undefined;

  try {
    const response = await fetch(`${SPORELABS_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new SporeLabsError(
        response.status,
        `SporeLabs chat ${response.status}: ${raw.slice(0, 400)}`,
        raw,
      );
    }

    const parsed = JSON.parse(raw) as {
      choices?: Array<{
        finish_reason?: string;
        message?: {
          content?: string | SporeLabsContentPart[] | null;
          tool_calls?: SporeLabsToolCall[];
        };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
      };
      error?: { message?: string };
    };

    if (parsed.error?.message) {
      throw new SporeLabsError(200, parsed.error.message, raw);
    }

    const choice = parsed.choices?.[0];
    const message = choice?.message;
    if (!message) {
      throw new SporeLabsError(200, "SporeLabs returned no choices", raw);
    }

    return {
      content: flattenContent(message.content),
      toolCalls: message.tool_calls ?? [],
      finishReason: choice.finish_reason ?? "stop",
      usage: {
        promptTokens: parsed.usage?.prompt_tokens ?? 0,
        completionTokens: parsed.usage?.completion_tokens ?? 0,
      },
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function sporelabsChatText(params: {
  model: string;
  system?: string;
  user: string;
  maxTokens: number;
  temperature?: number;
  timeoutMs?: number;
  json?: boolean;
}): Promise<string> {
  const messages: SporeLabsChatMessage[] = [];
  if (params.system) {
    messages.push({ role: "system", content: params.system });
  }
  messages.push({ role: "user", content: params.user });

  const result = await sporelabsChatCompletions({
    model: params.model,
    messages,
    maxTokens: params.maxTokens,
    temperature: params.temperature,
    timeoutMs: params.timeoutMs,
    responseFormat: params.json ? { type: "json_object" } : undefined,
  });

  const text = result.content?.trim() ?? "";
  if (!text) {
    throw new Error("SporeLabs returned an empty completion");
  }
  return text;
}

function flattenContent(
  content: string | SporeLabsContentPart[] | null | undefined,
): string | null {
  if (content == null) return null;
  if (typeof content === "string") return content;
  const text = content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
  return text.length > 0 ? text : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

// ---------------------------------------------------------------------------
// Whisper STT
// ---------------------------------------------------------------------------

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

export async function transcribeAudioChunk(params: {
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
  const apiKey = await getSporeLabsApiKey();

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const payload = {
        model: SPORELABS_WHISPER_MODEL,
        response_format: "verbose_json",
        timestamp_granularities: ["word"],
        input_audio: {
          data: params.audio.toString("base64"),
          format,
        },
      };

      const response = await fetch(`${SPORELABS_BASE_URL}/audio/transcriptions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
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
          `SporeLabs STT returned non-JSON (${response.status}): ${text.slice(0, 300)}`,
        );
      }

      if (!response.ok) {
        const msg =
          data.error?.message ||
          data.message ||
          text.slice(0, 300) ||
          response.statusText;
        const err = new Error(`SporeLabs STT ${response.status}: ${msg}`);
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
  throw lastError || new Error("SporeLabs STT failed");
}

// ---------------------------------------------------------------------------
// Caption translation
// ---------------------------------------------------------------------------

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
    let lastError: Error | null = null;
    let translated: string[] | null = null;
    for (let attempt = 1; attempt <= STT_RETRIES; attempt++) {
      try {
        const content = await sporelabsChatText({
          model: SPORELABS_TRANSLATE_MODEL,
          system,
          user: JSON.stringify({ lines: batch }),
          maxTokens: 4096,
          temperature: 0.2,
          timeoutMs: STT_TIMEOUT_MS,
          json: true,
        });

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
        if (!translated) {
          throw new Error("SporeLabs translation returned no lines");
        }
        if (translated.length !== batch.length) {
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
          (lastError instanceof SporeLabsError &&
            isRetryableStatus(lastError.status));
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

// ---------------------------------------------------------------------------
// Gemini video (framing)
// ---------------------------------------------------------------------------

export async function sporelabsAnalyzeVideo(params: {
  prompt: string;
  videoUrl: string;
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<string> {
  const result = await sporelabsChatCompletions({
    model: SPORELABS_GEMINI_MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: params.prompt },
          { type: "video_url", video_url: { url: params.videoUrl } },
        ],
      },
    ],
    maxTokens: params.maxTokens ?? 2048,
    timeoutMs: params.timeoutMs ?? FRAMING_TIMEOUT_MS,
  });
  const text = result.content?.trim() ?? "";
  if (!text) {
    throw new Error("SporeLabs Gemini returned an empty completion");
  }
  return text;
}
