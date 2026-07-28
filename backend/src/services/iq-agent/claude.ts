/**
 * Claude via Bedrock `InvokeModel`, with the direct Anthropic API as a fallback
 * on throttling — the same dual-path pattern `export-metadata-enrich.ts` uses.
 *
 * Non-streaming on purpose: `bedrock:InvokeModelWithResponseStream` is a
 * distinct IAM action that is not granted, and the event log already gives the
 * UI per-block updates. Switching to streaming later would not change the
 * client, the transport, or the infrastructure.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  ANTHROPIC_API_MODEL,
  BEDROCK_MODEL,
  MODEL_MAX_ATTEMPTS,
  MODEL_TIMEOUT_MS,
} from "./config";
import type { ToolSchema } from "./tools";

const bedrockClient = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || "us-west-2",
});
const secretsClient = new SecretsManagerClient({});

let cachedAnthropicKey: string | null | undefined;

/**
 * Whether this container's Bedrock endpoint accepts `cache_control`. Discovered
 * once on the first rejection rather than re-learned on every iteration.
 */
let promptCacheSupported = process.env.IQ_AGENT_PROMPT_CACHE !== "false";

/** Least time worth spending on another model attempt. */
const MIN_MODEL_ATTEMPT_MS = 20_000;

export interface ClaudeTextBlock {
  type: "text";
  text: string;
}

export interface ClaudeToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeToolUseBlock
  | Record<string, unknown>;

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: ClaudeContentBlock[];
}

export interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ClaudeResponse {
  blocks: ClaudeContentBlock[];
  stopReason: string;
  usage: ClaudeUsage;
  source: "bedrock" | "anthropic_api";
}

export class ModelError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export type ClaudeToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string };

export async function callClaude(params: {
  system: SystemBlock[];
  messages: ClaudeMessage[];
  tools: ToolSchema[];
  maxTokens: number;
  temperature: number;
  /** Epoch-ms ceiling; attempts are trimmed to fit inside it. */
  deadlineAt?: number;
  /** Omitted means `auto`, which is what the main loop wants. */
  toolChoice?: ClaudeToolChoice;
}): Promise<ClaudeResponse> {
  const tools = params.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));

  const budget = () =>
    params.deadlineAt === undefined
      ? MODEL_TIMEOUT_MS
      : Math.min(MODEL_TIMEOUT_MS, params.deadlineAt - Date.now());

  let lastError: unknown;

  for (let attempt = 1; attempt <= MODEL_MAX_ATTEMPTS; attempt++) {
    const timeoutMs = budget();
    if (timeoutMs < MIN_MODEL_ATTEMPT_MS) {
      throw new ModelError(
        "model_deadline",
        "Ran out of time in this invocation before the model answered.",
        true,
        lastError ? errorText(lastError) : undefined,
      );
    }

    try {
      return await invokeBedrock({
        system: promptCacheSupported
          ? params.system
          : stripCacheControl(params.system),
        messages: promptCacheSupported
          ? params.messages
          : stripMessageCacheControl(params.messages),
        tools,
        toolChoice: params.toolChoice,
        maxTokens: params.maxTokens,
        temperature: params.temperature,
        timeoutMs,
      });
    } catch (err) {
      lastError = err;
      const classified = classifyModelError(err);

      // Some Bedrock regions/models reject cache_control. Drop it and retry
      // rather than failing a run over a caching optimization. Remembered for
      // the container so the next iteration does not rediscover it.
      if (classified.code === "cache_control_unsupported" && promptCacheSupported) {
        console.warn(
          "[IQAgent] Bedrock rejected prompt caching; disabling it for this container.",
        );
        promptCacheSupported = false;
        continue;
      }

      if (!classified.retryable || attempt === MODEL_MAX_ATTEMPTS) {
        break;
      }

      const delay = Math.min(1000 * 2 ** (attempt - 1), Math.max(0, budget() - MIN_MODEL_ATTEMPT_MS));
      console.warn(
        `[IQAgent] Bedrock ${classified.code} (attempt ${attempt}/${MODEL_MAX_ATTEMPTS}), retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }

  const bedrock = classifyModelError(lastError);

  // A malformed request or a denied model fails identically on the direct API.
  // Spending another full timeout on it only delays the error the user needs.
  if (bedrock.code === "model_invalid_request" || bedrock.code === "model_access_denied") {
    throw new ModelError(
      bedrock.code,
      bedrock.message,
      bedrock.retryable,
      errorText(lastError),
    );
  }

  const fallbackBudget = budget();
  if (fallbackBudget < MIN_MODEL_ATTEMPT_MS) {
    throw new ModelError(
      "model_deadline",
      "Ran out of time in this invocation before the model answered.",
      true,
      errorText(lastError),
    );
  }

  console.warn(
    `[IQAgent] Bedrock exhausted, trying the Anthropic API: ${errorText(lastError)}`,
  );

  try {
    return await invokeAnthropicApi({
      // Caching is decided inside, independently of `promptCacheSupported`:
      // that flag records what Bedrock rejected, which says nothing about what
      // the Anthropic API accepts.
      system: params.system,
      messages: params.messages,
      tools,
      toolChoice: params.toolChoice,
      maxTokens: params.maxTokens,
      temperature: params.temperature,
      timeoutMs: fallbackBudget,
    });
  } catch (fallbackErr) {
    const fallback = classifyModelError(fallbackErr);
    throw new ModelError(
      bedrock.code,
      `The model could not be reached. Bedrock: ${bedrock.message}. Anthropic API: ${fallback.message}`,
      bedrock.retryable || fallback.retryable,
      `${errorText(lastError)} | ${errorText(fallbackErr)}`,
    );
  }
}

async function invokeBedrock(params: {
  system: SystemBlock[];
  messages: ClaudeMessage[];
  tools: unknown[];
  toolChoice?: ClaudeToolChoice;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}): Promise<ClaudeResponse> {
  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: params.maxTokens,
    temperature: params.temperature,
    system: params.system,
    messages: params.messages,
    tools: params.tools,
    ...(params.toolChoice ? { tool_choice: params.toolChoice } : {}),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const response = await bedrockClient.send(
      new InvokeModelCommand({
        modelId: BEDROCK_MODEL,
        contentType: "application/json",
        accept: "application/json",
        body,
      }),
      { abortSignal: controller.signal },
    );

    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as {
      content?: ClaudeContentBlock[];
      stop_reason?: string;
      usage?: Record<string, number>;
    };

    // An empty array is as unusable as a missing one: the loop would record an
    // assistant turn with no content, which the next request rejects.
    if (!Array.isArray(parsed.content) || parsed.content.length === 0) {
      throw new ModelError(
        "malformed_response",
        "Bedrock returned a response with no content blocks.",
        true,
        JSON.stringify(parsed).slice(0, 400),
      );
    }

    return {
      blocks: parsed.content,
      stopReason: parsed.stop_reason ?? "end_turn",
      usage: {
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
        cacheReadTokens: parsed.usage?.cache_read_input_tokens ?? 0,
        cacheCreationTokens: parsed.usage?.cache_creation_input_tokens ?? 0,
      },
      source: "bedrock",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function invokeAnthropicApi(params: {
  system: SystemBlock[];
  messages: ClaudeMessage[];
  tools: unknown[];
  toolChoice?: ClaudeToolChoice;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}): Promise<ClaudeResponse> {
  const key = await getAnthropicApiKey();
  if (!key.value) {
    throw new ModelError(
      key.reason === "unset" ? "no_fallback_key" : "fallback_key_unavailable",
      key.reason === "unset"
        ? "ANTHROPIC_SECRET_ARN is not configured, so there is no fallback path."
        : `The Anthropic fallback key could not be read: ${key.detail}`,
      key.reason !== "unset",
    );
  }

  const client = new Anthropic({ apiKey: key.value, timeout: params.timeoutMs });

  interface ApiResponse {
    content: ClaudeContentBlock[];
    stop_reason?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  }

  const send = (cached: boolean) =>
    client.messages.create({
      model: ANTHROPIC_API_MODEL,
      max_tokens: params.maxTokens,
      temperature: params.temperature,
      system: (cached ? params.system : stripCacheControl(params.system)) as never,
      messages: (cached
        ? params.messages
        : stripMessageCacheControl(params.messages)) as never,
      tools: params.tools as never,
      ...(params.toolChoice ? { tool_choice: params.toolChoice as never } : {}),
    }) as unknown as Promise<ApiResponse>;

  // Cached on this path too. The fallback fires when Bedrock is throttled,
  // which is exactly when the request most needs to be cheap — and the two
  // providers keep separate caches, so a run that has flipped over benefits
  // from warming this one.
  let message: ApiResponse;
  try {
    message = await send(true);
  } catch (err) {
    // This is the last line of defence for the run. If caching is the thing the
    // API objects to, drop it and take the expensive answer over no answer.
    // `cache_control_unsupported` is the specific classification for that
    // complaint and is checked ahead of the generic 400, so it has to be listed
    // here too or the retry never fires for the case it was written for.
    const code = classifyModelError(err).code;
    if (code !== "model_invalid_request" && code !== "cache_control_unsupported") {
      throw err;
    }
    console.warn(
      `[IQAgent] Anthropic rejected the cached request, retrying uncached: ${errorText(err)}`,
    );
    message = await send(false);
  }

  if (!Array.isArray(message.content) || message.content.length === 0) {
    throw new ModelError(
      "malformed_response",
      "The Anthropic API returned a response with no content blocks.",
      true,
    );
  }

  return {
    blocks: message.content,
    stopReason: message.stop_reason ?? "end_turn",
    usage: {
      inputTokens: message.usage?.input_tokens ?? 0,
      outputTokens: message.usage?.output_tokens ?? 0,
      cacheReadTokens: message.usage?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: message.usage?.cache_creation_input_tokens ?? 0,
    },
    source: "anthropic_api",
  };
}

interface AnthropicKey {
  value: string | null;
  reason?: "unset" | "empty" | "fetch_failed";
  detail?: string;
}

async function getAnthropicApiKey(): Promise<AnthropicKey> {
  if (cachedAnthropicKey) return { value: cachedAnthropicKey };
  const secretArn = process.env.ANTHROPIC_SECRET_ARN;
  if (!secretArn) return { value: null, reason: "unset" };

  try {
    const secret = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    const value = secret.SecretString?.trim() || null;
    if (!value) return { value: null, reason: "empty" };
    cachedAnthropicKey = value;
    return { value };
  } catch (err) {
    // Deliberately not cached: a transient Secrets Manager blip must not
    // disable the fallback for the rest of the container's life.
    const detail = errorText(err);
    console.warn(`[IQAgent] Anthropic key unavailable: ${detail}`);
    return { value: null, reason: "fetch_failed", detail };
  }
}

export function classifyModelError(err: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (err instanceof ModelError) {
    return { code: err.code, message: err.message, retryable: err.retryable };
  }

  const name = (err as { name?: string })?.name ?? "";
  const status = (err as { status?: number })?.status;
  const message = errorText(err);

  // Checked before the generic status mapping: this arrives as a plain 400.
  if (/cache_control|cacheControl/i.test(message) && /valid|support|unexpected/i.test(message)) {
    return {
      code: "cache_control_unsupported",
      message,
      retryable: false,
    };
  }

  // HTTP status from the Anthropic SDK, which does not use AWS error names.
  if (status === 429) {
    return { code: "model_throttled", message, retryable: true };
  }
  if (status !== undefined && status >= 500) {
    return { code: "model_unavailable", message, retryable: true };
  }
  if (status === 401 || status === 403) {
    return { code: "model_access_denied", message, retryable: false };
  }
  if (status === 400) {
    return { code: "model_invalid_request", message, retryable: false };
  }

  if (name === "AbortError" || /aborted|timed out/i.test(message)) {
    return { code: "model_timeout", message: "The model call timed out.", retryable: true };
  }
  if (name === "ThrottlingException" || /throttl|too many requests|429/i.test(message)) {
    return { code: "model_throttled", message, retryable: true };
  }
  if (name === "ServiceUnavailableException" || name === "InternalServerException") {
    return { code: "model_unavailable", message, retryable: true };
  }
  if (name === "AccessDeniedException") {
    return {
      code: "model_access_denied",
      message: `Bedrock denied access to ${BEDROCK_MODEL}: ${message}`,
      retryable: false,
    };
  }
  if (name === "ValidationException") {
    return { code: "model_invalid_request", message, retryable: false };
  }
  return { code: "model_error", message, retryable: true };
}

function stripCacheControl(system: SystemBlock[]): SystemBlock[] {
  return system.map(({ type, text }) => ({ type, text }));
}

function stripMessageCacheControl(messages: ClaudeMessage[]): ClaudeMessage[] {
  return messages.map((message) => ({
    ...message,
    content: message.content.map((block) => {
      if (typeof block !== "object" || block === null) return block;
      if (!("cache_control" in block)) return block;
      const { cache_control: _dropped, ...rest } = block as Record<string, unknown>;
      return rest as ClaudeContentBlock;
    }),
  }));
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err).slice(0, 500);
  } catch {
    return String(err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
