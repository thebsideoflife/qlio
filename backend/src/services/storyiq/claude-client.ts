/**
 * Claude Client - Unified interface for Claude API access
 *
 * Supports both:
 * - Direct Anthropic API (for development/testing)
 * - AWS Bedrock (for production with quota)
 *
 * Toggle USE_ANTHROPIC_API to switch between them.
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import Anthropic from "@anthropic-ai/sdk";
import { extractLLMContent } from "./types";

// ============================================================================
// Configuration - Toggle this to switch APIs
// ============================================================================

/**
 * Set to true to use direct Anthropic API (with API key from Secrets Manager)
 * Set to false to use AWS Bedrock
 */
export const USE_ANTHROPIC_API = true;

// Anthropic API model IDs (different from Bedrock model IDs)
const ANTHROPIC_MODEL_SONNET = "claude-sonnet-4-5-20250929";
const ANTHROPIC_MODEL_HAIKU = "claude-haiku-4-5-20251001";

// Bedrock model IDs
const BEDROCK_MODEL_SONNET = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const BEDROCK_MODEL_HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

// ============================================================================
// Clients (lazy initialized)
// ============================================================================

let bedrockClient: BedrockRuntimeClient | null = null;
let anthropicClient: Anthropic | null = null;
let secretsClient: SecretsManagerClient | null = null;
let cachedApiKey: string | null = null;

function getBedrockClient(): BedrockRuntimeClient {
  if (!bedrockClient) {
    bedrockClient = new BedrockRuntimeClient({
      region: process.env.AWS_REGION || "us-west-2",
    });
  }
  return bedrockClient;
}

function getSecretsClient(): SecretsManagerClient {
  if (!secretsClient) {
    secretsClient = new SecretsManagerClient({
      region: process.env.AWS_REGION || "us-west-2",
    });
  }
  return secretsClient;
}

async function getAnthropicApiKey(): Promise<string> {
  if (cachedApiKey) {
    return cachedApiKey;
  }

  const client = getSecretsClient();
  const command = new GetSecretValueCommand({
    SecretId: "zeevee/anthropic-api-key",
  });

  const response = await client.send(command);
  if (!response.SecretString) {
    throw new Error("Anthropic API key not found in Secrets Manager");
  }

  cachedApiKey = response.SecretString;
  return cachedApiKey;
}

async function getAnthropicClient(): Promise<Anthropic> {
  if (!anthropicClient) {
    const apiKey = await getAnthropicApiKey();
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

// ============================================================================
// Unified Interface
// ============================================================================

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ClaudeOptions {
  model?: "sonnet" | "haiku";
  maxTokens?: number;
  messages: ClaudeMessage[];
}

/**
 * Call Claude with the configured API (Anthropic or Bedrock)
 * Returns the text content from the response.
 */
export async function callClaude(options: ClaudeOptions): Promise<string> {
  const { model = "sonnet", maxTokens = 8000, messages } = options;

  if (USE_ANTHROPIC_API) {
    return callClaudeViaAnthropic(model, maxTokens, messages);
  } else {
    return callClaudeViaBedrock(model, maxTokens, messages);
  }
}

// ============================================================================
// Anthropic API Implementation
// ============================================================================

async function callClaudeViaAnthropic(
  model: "sonnet" | "haiku",
  maxTokens: number,
  messages: ClaudeMessage[],
): Promise<string> {
  const client = await getAnthropicClient();
  const modelId =
    model === "sonnet" ? ANTHROPIC_MODEL_SONNET : ANTHROPIC_MODEL_HAIKU;

  console.log(`[Claude] Using Anthropic API with model: ${modelId}`);

  const response = await client.messages.create({
    model: modelId,
    max_tokens: maxTokens,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  });

  // Extract text from response
  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text content in Anthropic response");
  }

  return textBlock.text;
}

// ============================================================================
// Tool Use Interface
// ============================================================================

/**
 * Tool definition for Claude tool use.
 * Matches Anthropic API tool schema format.
 */
export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * A tool_use block from Claude's response.
 */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * A tool_result block to send back to Claude.
 */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/**
 * A text block from Claude's response.
 * Can include cache_control for prompt caching.
 */
export interface TextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

/** A content block in Claude's response */
export type ContentBlock = TextBlock | ToolUseBlock;

/**
 * Full response from a tool-use Claude call.
 */
export interface ClaudeToolResponse {
  content: ContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
}

/**
 * Message format for tool-use conversations.
 * Content can be a string (user text) or an array of content blocks (tool results).
 */
export interface ToolMessage {
  role: "user" | "assistant";
  content: string | (TextBlock | ToolUseBlock | ToolResultBlock)[];
}

export interface ClaudeToolOptions {
  model?: "sonnet" | "haiku";
  maxTokens?: number;
  tools: ClaudeTool[];
  messages: ToolMessage[];
}

/**
 * Call Claude with tool definitions. Returns the full response
 * including stop_reason and all content blocks (text + tool_use).
 *
 * Used for multi-turn tool conversations where we need to process
 * tool_use blocks and send back tool_result blocks.
 */
export async function callClaudeWithTools(
  options: ClaudeToolOptions,
): Promise<ClaudeToolResponse> {
  const { model = "sonnet", maxTokens = 8000, tools, messages } = options;

  if (USE_ANTHROPIC_API) {
    return callClaudeWithToolsViaAnthropic(model, maxTokens, tools, messages);
  } else {
    return callClaudeWithToolsViaBedrock(model, maxTokens, tools, messages);
  }
}

// ============================================================================
// Anthropic API - Tool Use Implementation
// ============================================================================

async function callClaudeWithToolsViaAnthropic(
  model: "sonnet" | "haiku",
  maxTokens: number,
  tools: ClaudeTool[],
  messages: ToolMessage[],
): Promise<ClaudeToolResponse> {
  const client = await getAnthropicClient();
  const modelId =
    model === "sonnet" ? ANTHROPIC_MODEL_SONNET : ANTHROPIC_MODEL_HAIKU;

  console.log(
    `[Claude Tools] Using Anthropic API with model: ${modelId}, ${tools.length} tools`,
  );

  // Our ClaudeTool/ToolMessage types are structurally compatible with the SDK's
  // Anthropic.MessageCreateParams but not nominally identical (we define our own
  // for Bedrock portability). Use SDK parameter types for a narrow cast that will
  // break at compile time if the SDK changes its shape.
  type CreateParams = Parameters<typeof client.messages.create>[0];

      const response = await client.messages.create({
        model: modelId,
        max_tokens: maxTokens,
        tools: tools as CreateParams["tools"],
        messages: messages as CreateParams["messages"],
      });

      // Log cache stats if available
      const usage = response.usage as {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
      if (usage.cache_read_input_tokens || usage.cache_creation_input_tokens) {
        console.log(
          `[Claude Tools] Cache: ${usage.cache_read_input_tokens || 0} read, ${usage.cache_creation_input_tokens || 0} created, ${usage.input_tokens} uncached`,
        );
      }

      return {
        content: response.content as ContentBlock[],
        stop_reason: response.stop_reason as ClaudeToolResponse["stop_reason"],
      };
}

// ============================================================================
// Bedrock Implementation
// ============================================================================

async function callClaudeViaBedrock(
  model: "sonnet" | "haiku",
  maxTokens: number,
  messages: ClaudeMessage[],
): Promise<string> {
  const client = getBedrockClient();
  const modelId = model === "sonnet" ? BEDROCK_MODEL_SONNET : BEDROCK_MODEL_HAIKU;

  console.log(`[Claude] Using AWS Bedrock with model: ${modelId}`);

  const command = new InvokeModelCommand({
    modelId,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: maxTokens,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    }),
  });

  const response = await client.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));

  return extractLLMContent(responseBody);
}

// ============================================================================
// Bedrock - Tool Use Implementation
// ============================================================================

async function callClaudeWithToolsViaBedrock(
  model: "sonnet" | "haiku",
  maxTokens: number,
  tools: ClaudeTool[],
  messages: ToolMessage[],
): Promise<ClaudeToolResponse> {
  const client = getBedrockClient();
  const modelId = model === "sonnet" ? BEDROCK_MODEL_SONNET : BEDROCK_MODEL_HAIKU;

  console.log(
    `[Claude Tools] Using AWS Bedrock with model: ${modelId}, ${tools.length} tools`,
  );

  const command = new InvokeModelCommand({
    modelId,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: maxTokens,
      tools,
      messages,
    }),
  });

  const response = await client.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));

  // Validate response structure — Bedrock can return errors, throttles, or
  // malformed bodies that would silently propagate as undefined downstream.
  if (!responseBody.content || !Array.isArray(responseBody.content)) {
    throw new Error(
      `Invalid Bedrock tool-use response: missing 'content' array. ` +
        `Response: ${JSON.stringify(responseBody).substring(0, 300)}`,
    );
  }
  if (!responseBody.stop_reason) {
    throw new Error(
      `Invalid Bedrock tool-use response: missing 'stop_reason'. ` +
        `Response: ${JSON.stringify(responseBody).substring(0, 300)}`,
    );
  }

  return {
    content: responseBody.content as ContentBlock[],
    stop_reason: responseBody.stop_reason as ClaudeToolResponse["stop_reason"],
  };
}
