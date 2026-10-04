/**
 * OpenAI-compatible client for SporeLabs (`https://sporelabs.dev/v1`).
 *
 * Every model call goes here, pinned to the same models we already used —
 * not Auto/starter:
 *   - Sonnet 5.5          IQ agent, Jockey brief, export-metadata enrich
 *   - Haiku               Pegasus title classifier
 *   - gpt-4o-mini         caption translation
 *   - gemini-2.5-pro      framing analysis (legacy FRAMING_ENGINE=gemini)
 *
 * Sampling parameters are passed through only when the caller sets them, so
 * each call keeps the provider defaults it had before the move — except where
 * the model rejects them (see `rejectsSamplingAndForcedTools`). Whisper
 * transcription is not here yet: it still runs through ./openrouter.
 */

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const secretsClient = new SecretsManagerClient({});

export const SPORELABS_BASE_URL =
  process.env.SPORELABS_BASE_URL?.replace(/\/$/, "") || "https://sporelabs.dev/v1";

/**
 * Claude Sonnet 5.5 (`claude-sonnet-5-5` on the Anthropic API,
 * `anthropic.claude-sonnet-5-5` on Bedrock), via OpenRouter. Setting the env
 * var to `anthropic/claude-sonnet-4.5` rolls back.
 */
export const SPORELABS_SONNET_MODEL =
  process.env.SPORELABS_SONNET_MODEL || "anthropic/claude-sonnet-5.5";

/**
 * Sonnet 5.5 answers a 400 to a non-default temperature and to a forced
 * tool_choice ("required" or a named function), both of which Sonnet 4.5
 * accepted. Keyed on the model id rather than applied to every call, so an env
 * rollback to 4.5 keeps the sampling and forcing the agent was tuned with.
 */
export function rejectsSamplingAndForcedTools(model: string): boolean {
  return /^anthropic\/claude-sonnet-5\.5(?![\d])/.test(model);
}

/** Same model as `anthropic.claude-3-haiku-20240307-v1:0`. */
export const SPORELABS_HAIKU_MODEL =
  process.env.SPORELABS_HAIKU_MODEL || "anthropic/claude-3-haiku";

/** Same model as the OpenRouter translation default. */
export const SPORELABS_TRANSLATE_MODEL =
  process.env.SPORELABS_TRANSLATE_MODEL || "openai/gpt-4o-mini";

/** Same model as `gemini-2.5-pro` on the Google File API path. */
export const SPORELABS_GEMINI_MODEL =
  process.env.SPORELABS_GEMINI_MODEL || "google/gemini-2.5-pro";

/** Caption translation itself lives in ./translate-captions. */
export const TRANSLATE_MODEL = SPORELABS_TRANSLATE_MODEL;

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

/** Anthropic prompt-cache breakpoint; SporeLabs forwards it to Claude. */
type CacheControl = { cache_control?: { type: "ephemeral" } };

export type SporeLabsContentPart =
  | ({ type: "text"; text: string } & CacheControl)
  | ({ type: "image_url"; image_url: { url: string } } & CacheControl)
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
    /** Includes cachedTokens and cacheWriteTokens (OpenAI convention). */
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
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
  maxTokens?: number;
  temperature?: number;
  responseFormat?: { type: "json_object" };
  /** Per attempt. */
  timeoutMs?: number;
  /**
   * Total tries on a transient gateway error (408/429/5xx, upstream
   * unavailable). Timeouts are not retried: the caller's budget is spent.
   */
  attempts?: number;
}): Promise<SporeLabsChatResult> {
  const attempts = Math.max(1, params.attempts ?? 1);
  for (let attempt = 1; ; attempt++) {
    try {
      return await chatCompletionsOnce(params);
    } catch (err) {
      if (
        attempt >= attempts ||
        !(err instanceof SporeLabsError) ||
        !isRetryableStatus(err.status)
      ) {
        throw err;
      }
      console.warn(
        `[SporeLabs] ${params.model} ${err.status} (attempt ${attempt}/${attempts}), retrying`,
      );
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
}

async function chatCompletionsOnce(params: {
  model: string;
  messages: SporeLabsChatMessage[];
  tools?: SporeLabsTool[];
  toolChoice?: SporeLabsToolChoice;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: { type: "json_object" };
  timeoutMs?: number;
}): Promise<SporeLabsChatResult> {
  const apiKey = await getSporeLabsApiKey();
  const payload: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
  };
  const strict = rejectsSamplingAndForcedTools(params.model);
  if (params.maxTokens !== undefined) payload.max_tokens = params.maxTokens;
  if (params.temperature !== undefined && !strict) {
    payload.temperature = params.temperature;
  }
  if (params.tools && params.tools.length > 0) {
    payload.tools = params.tools;
    if (params.toolChoice) {
      // Callers that force a tool already check that the call came back.
      const forced = params.toolChoice === "required" || typeof params.toolChoice === "object";
      payload.tool_choice = strict && forced ? "auto" : params.toolChoice;
    }
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
        prompt_tokens_details?: {
          cached_tokens?: number;
          cache_write_tokens?: number;
        };
      };
      error?: { message?: string; code?: string | number };
    };

    if (parsed.error?.message) {
      // An error body on a 200 is an upstream failure the gateway relayed.
      const code = String(parsed.error.code ?? "");
      const status = /^\d{3}$/.test(code)
        ? Number(code)
        : /unavailable|overloaded|timeout/i.test(code)
          ? 503
          : /rate/i.test(code)
            ? 429
            : 502;
      throw new SporeLabsError(status, parsed.error.message, raw);
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
        cachedTokens: parsed.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens:
          parsed.usage?.prompt_tokens_details?.cache_write_tokens ?? 0,
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
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  json?: boolean;
  /** Defaults to 2, standing in for the old Bedrock -> Anthropic fallback. */
  attempts?: number;
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
    attempts: params.attempts ?? 2,
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
// Gemini video (framing)
// ---------------------------------------------------------------------------

export async function sporelabsAnalyzeVideo(params: {
  prompt: string;
  videoUrl: string;
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
    timeoutMs: params.timeoutMs ?? FRAMING_TIMEOUT_MS,
    attempts: 2,
  });
  const text = result.content?.trim() ?? "";
  if (!text) {
    throw new Error("SporeLabs Gemini returned an empty completion");
  }
  return text;
}
