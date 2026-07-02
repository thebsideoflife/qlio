/**
 * Claude Sonnet via Bedrock for Jockey narrative brief preprocess.
 * Falls back to direct Anthropic API (same pattern as export-metadata-enrich.ts).
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

const bedrockClient = new BedrockRuntimeClient({ region: "us-west-2" });
const secretsClient = new SecretsManagerClient({});
const BEDROCK_MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const ANTHROPIC_API_MODEL = "claude-sonnet-4-5-20250929";
const PREPROCESS_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_TOKENS = 8192;

let cachedAnthropicApiKey: string | null | undefined;

async function getAnthropicApiKey(): Promise<string | null> {
  if (cachedAnthropicApiKey !== undefined) {
    return cachedAnthropicApiKey;
  }

  const secretArn = process.env.ANTHROPIC_SECRET_ARN;
  if (!secretArn) {
    cachedAnthropicApiKey = null;
    return null;
  }

  try {
    const secret = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    cachedAnthropicApiKey = secret.SecretString?.trim() || null;
    return cachedAnthropicApiKey;
  } catch (err) {
    console.warn("[Jockey] Could not load Anthropic API key for fallback:", err);
    cachedAnthropicApiKey = null;
    return null;
  }
}

async function withTimeout<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

async function invokeBedrock(
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: MAX_OUTPUT_TOKENS,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const response = await bedrockClient.send(
    new InvokeModelCommand({
      modelId: BEDROCK_MODEL,
      contentType: "application/json",
      accept: "application/json",
      body,
    }),
    { abortSignal: signal },
  );

  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  return responseBody.content?.[0]?.text || "";
}

async function invokeAnthropicApi(
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const apiKey = await getAnthropicApiKey();
  if (!apiKey) {
    throw new Error("Anthropic API key not configured");
  }

  const client = new Anthropic({
    apiKey,
    timeout: PREPROCESS_TIMEOUT_MS,
  });

  const message = await client.messages.create({
    model: ANTHROPIC_API_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const block = message.content[0];
  return block?.type === "text" ? block.text : "";
}

export function parseClaudeJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/m.exec(trimmed);
  const raw = fence ? fence[1].trim() : trimmed;
  return JSON.parse(raw);
}

/**
 * Invoke Claude for JSON narrative brief. Throws on empty or unrecoverable failure.
 */
export async function invokeClaudeForJson(opts: {
  systemPrompt: string;
  userPrompt: string;
}): Promise<{ parsed: unknown; source: "bedrock" | "anthropic_api" }> {
  const { systemPrompt, userPrompt } = opts;

  try {
    const text = await withTimeout(PREPROCESS_TIMEOUT_MS, (signal) =>
      invokeBedrock(systemPrompt, userPrompt, signal),
    );
    if (!text.trim()) {
      throw new Error("empty Bedrock response");
    }
    return { parsed: parseClaudeJson(text), source: "bedrock" };
  } catch (bedrockErr) {
    console.warn(
      "[Jockey] Bedrock preprocess failed, trying Anthropic API:",
      bedrockErr,
    );
    const text = await invokeAnthropicApi(systemPrompt, userPrompt);
    if (!text.trim()) {
      throw new Error("[Jockey] Claude preprocess returned empty response");
    }
    try {
      return { parsed: parseClaudeJson(text), source: "anthropic_api" };
    } catch (parseErr) {
      throw new Error(
        `[Jockey] Claude preprocess JSON parse failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      );
    }
  }
}
