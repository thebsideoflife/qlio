/**
 * IQ-agent model calls via SporeLabs (OpenAI-compatible), keeping the Claude
 * message/tool shape the rest of the agent already speaks.
 *
 * Non-streaming on purpose: the event log already gives the UI per-block
 * updates. Switching to streaming later would not change the client, the
 * transport, or the infrastructure.
 */

import {
  MODEL_MAX_ATTEMPTS,
  MODEL_TIMEOUT_MS,
} from "./config";
import type { ToolSchema } from "./tools";
import {
  SPORELABS_SONNET_MODEL,
  SporeLabsError,
  sporelabsChatCompletions,
  type SporeLabsChatMessage,
  type SporeLabsContentPart,
  type SporeLabsTool,
  type SporeLabsToolCall,
  type SporeLabsToolChoice,
} from "../sporelabs";

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
  source: "sporelabs";
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
      return await invokeSporeLabs({
        system: params.system,
        messages: params.messages,
        tools: params.tools,
        toolChoice: params.toolChoice,
        maxTokens: params.maxTokens,
        temperature: params.temperature,
        timeoutMs,
      });
    } catch (err) {
      lastError = err;
      const classified = classifyModelError(err);
      if (!classified.retryable || attempt === MODEL_MAX_ATTEMPTS) {
        throw new ModelError(
          classified.code,
          classified.message,
          classified.retryable,
          errorText(err),
        );
      }

      const delay = Math.min(
        1000 * 2 ** (attempt - 1),
        Math.max(0, budget() - MIN_MODEL_ATTEMPT_MS),
      );
      console.warn(
        `[IQAgent] SporeLabs ${classified.code} (attempt ${attempt}/${MODEL_MAX_ATTEMPTS}), retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }

  throw new ModelError(
    "model_error",
    "The model could not be reached.",
    true,
    lastError ? errorText(lastError) : undefined,
  );
}

async function invokeSporeLabs(params: {
  system: SystemBlock[];
  messages: ClaudeMessage[];
  tools: ToolSchema[];
  toolChoice?: ClaudeToolChoice;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}): Promise<ClaudeResponse> {
  const result = await sporelabsChatCompletions({
    model: SPORELABS_SONNET_MODEL,
    messages: toOpenAIMessages(params.system, params.messages),
    tools: params.tools.map(toOpenAITool),
    toolChoice: toOpenAIToolChoice(params.toolChoice),
    maxTokens: params.maxTokens,
    temperature: params.temperature,
    timeoutMs: params.timeoutMs,
  });

  const blocks = fromOpenAIMessage(result.content, result.toolCalls);
  if (blocks.length === 0) {
    throw new ModelError(
      "malformed_response",
      "SporeLabs returned a response with no content blocks.",
      true,
    );
  }

  return {
    blocks,
    stopReason:
      result.finishReason === "tool_calls" ? "tool_use" : result.finishReason,
    usage: {
      inputTokens: result.usage.promptTokens,
      outputTokens: result.usage.completionTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    source: "sporelabs",
  };
}

function toOpenAITool(tool: ToolSchema): SporeLabsTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

function toOpenAIToolChoice(
  choice: ClaudeToolChoice | undefined,
): SporeLabsToolChoice | undefined {
  if (!choice) return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  return { type: "function", function: { name: choice.name } };
}

function toOpenAIMessages(
  system: SystemBlock[],
  messages: ClaudeMessage[],
): SporeLabsChatMessage[] {
  const out: SporeLabsChatMessage[] = [];
  const systemText = system
    .map((block) => block.text)
    .filter(Boolean)
    .join("\n\n");
  if (systemText) {
    out.push({ role: "system", content: systemText });
  }

  for (const message of messages) {
    if (message.role === "assistant") {
      out.push(assistantToOpenAI(message));
      continue;
    }
    out.push(...userToOpenAI(message));
  }

  return out;
}

function assistantToOpenAI(message: ClaudeMessage): SporeLabsChatMessage {
  const texts: string[] = [];
  const toolCalls: SporeLabsToolCall[] = [];
  for (const raw of message.content) {
    const block = raw as Record<string, unknown>;
    if (block.type === "text") {
      texts.push(String(block.text ?? ""));
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: String(block.id ?? ""),
        type: "function",
        function: {
          name: String(block.name ?? ""),
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }
  const content = texts.join("\n") || null;
  return {
    role: "assistant",
    content,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function userToOpenAI(message: ClaudeMessage): SporeLabsChatMessage[] {
  const out: SporeLabsChatMessage[] = [];
  const leftover: SporeLabsContentPart[] = [];
  const imagesFromTools: SporeLabsContentPart[] = [];

  for (const raw of message.content) {
    const block = raw as Record<string, unknown>;
    if (block.type === "tool_result") {
      const { text, images } = flattenToolResult(block);
      out.push({
        role: "tool",
        tool_call_id: String(block.tool_use_id ?? ""),
        content: text,
      });
      imagesFromTools.push(...images);
      continue;
    }
    leftover.push(...contentPartFromBlock(block));
  }

  const userParts = [...imagesFromTools, ...leftover];
  if (userParts.length > 0) {
    out.push({ role: "user", content: userParts });
  }
  return out;
}

function contentPartFromBlock(
  block: Record<string, unknown>,
): SporeLabsContentPart[] {
  if (block.type === "text") {
    return [{ type: "text", text: String(block.text ?? "") }];
  }
  if (block.type === "image") {
    const source = (block.source ?? {}) as {
      media_type?: string;
      data?: string;
    };
    if (source.media_type && source.data) {
      return [
        {
          type: "image_url",
          image_url: {
            url: `data:${source.media_type};base64,${source.data}`,
          },
        },
      ];
    }
  }
  return [];
}

function flattenToolResult(block: Record<string, unknown>): {
  text: string;
  images: SporeLabsContentPart[];
} {
  const images: SporeLabsContentPart[] = [];
  const texts: string[] = [];
  const content = block.content;

  if (typeof content === "string") {
    return { text: content, images };
  }
  if (Array.isArray(content)) {
    for (const raw of content) {
      const item = raw as Record<string, unknown>;
      if (item.type === "text") {
        texts.push(String(item.text ?? ""));
      } else if (item.type === "image") {
        images.push(...contentPartFromBlock(item));
      }
    }
  }
  if (block.is_error) {
    texts.unshift("ERROR");
  }
  return { text: texts.filter(Boolean).join("\n") || "(empty tool result)", images };
}

function fromOpenAIMessage(
  content: string | null,
  toolCalls: SporeLabsToolCall[],
): ClaudeContentBlock[] {
  const blocks: ClaudeContentBlock[] = [];
  if (content && content.trim()) {
    blocks.push({ type: "text", text: content });
  }
  for (const call of toolCalls) {
    let input: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(call.function.arguments || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>;
      }
    } catch {
      input = {};
    }
    blocks.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input,
    });
  }
  return blocks;
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
  const status =
    err instanceof SporeLabsError
      ? err.status
      : (err as { status?: number })?.status;
  const message = errorText(err);

  if (status === 429) {
    return { code: "model_throttled", message, retryable: true };
  }
  if (status !== undefined && status >= 500) {
    return { code: "model_unavailable", message, retryable: true };
  }
  if (status === 401 || status === 403) {
    return { code: "model_access_denied", message, retryable: false };
  }
  if (status === 402) {
    return { code: "model_access_denied", message, retryable: false };
  }
  if (status === 400) {
    return { code: "model_invalid_request", message, retryable: false };
  }

  if (name === "AbortError" || /aborted|timed out/i.test(message)) {
    return { code: "model_timeout", message: "The model call timed out.", retryable: true };
  }
  if (/throttl|too many requests|429/i.test(message)) {
    return { code: "model_throttled", message, retryable: true };
  }
  return { code: "model_error", message, retryable: true };
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
