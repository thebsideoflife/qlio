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
import { MODEL_SONNET, MODEL_HAIKU, extractLLMContent } from "./types";

// ============================================================================
// Configuration - Toggle this to switch APIs
// ============================================================================

/**
 * Set to true to use direct Anthropic API (with API key from Secrets Manager)
 * Set to false to use AWS Bedrock
 */
export const USE_ANTHROPIC_API = true;

// Anthropic API model IDs (different from Bedrock model IDs)
const ANTHROPIC_MODEL_SONNET = "claude-sonnet-4-20250514";
const ANTHROPIC_MODEL_HAIKU = "claude-3-5-haiku-20241022"; // Claude 3.5 Haiku (Haiku 4 not yet available)

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
  const { model = "sonnet", maxTokens = 2000, messages } = options;

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
  messages: ClaudeMessage[]
): Promise<string> {
  const client = await getAnthropicClient();
  const modelId = model === "sonnet" ? ANTHROPIC_MODEL_SONNET : ANTHROPIC_MODEL_HAIKU;

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
// Bedrock Implementation
// ============================================================================

async function callClaudeViaBedrock(
  model: "sonnet" | "haiku",
  maxTokens: number,
  messages: ClaudeMessage[]
): Promise<string> {
  const client = getBedrockClient();
  const modelId = model === "sonnet" ? MODEL_SONNET : MODEL_HAIKU;

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

