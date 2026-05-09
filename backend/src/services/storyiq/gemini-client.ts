/**
 * Gemini Client - Unified interface for Gemini API access
 *
 * Uses @google/generative-ai SDK with API key from AWS Secrets Manager.
 * Replaces Claude for segment generation to align with the framing pipeline
 * (which already uses Gemini 2.5 Pro).
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { GoogleGenerativeAI, type Schema } from "@google/generative-ai";

// ============================================================================
// Clients (lazy initialized)
// ============================================================================

let geminiClient: GoogleGenerativeAI | null = null;
let secretsClient: SecretsManagerClient | null = null;
let cachedApiKey: string | null = null;

function getSecretsClient(): SecretsManagerClient {
  if (!secretsClient) {
    secretsClient = new SecretsManagerClient({
      region: process.env.AWS_REGION || "us-west-2",
    });
  }
  return secretsClient;
}

async function getGeminiApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;

  const secretArn = process.env.GEMINI_SECRET_ARN;
  if (!secretArn) {
    throw new Error(
      "GEMINI_SECRET_ARN environment variable not set. " +
        "Add it to the generateSegments Lambda configuration.",
    );
  }

  const client = getSecretsClient();
  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  if (!response.SecretString) {
    throw new Error("Gemini API key not found in Secrets Manager");
  }

  cachedApiKey = response.SecretString;
  return cachedApiKey;
}

async function getClient(): Promise<GoogleGenerativeAI> {
  if (!geminiClient) {
    const apiKey = await getGeminiApiKey();
    geminiClient = new GoogleGenerativeAI(apiKey);
  }
  return geminiClient;
}

// ============================================================================
// Public Interface
// ============================================================================

export interface GeminiMessage {
  role: "user" | "model";
  text: string;
}

export interface GeminiOptions {
  maxTokens?: number;
  messages: GeminiMessage[];
  responseSchema?: Schema;
}

/**
 * Call Gemini 2.5 Flash with a conversation history.
 * Returns the text content from the response.
 * If responseSchema is provided, uses structured output mode for reliable JSON.
 */
export async function callGemini(options: GeminiOptions): Promise<string> {
  const { maxTokens = 8000, messages, responseSchema } = options;
  const client = await getClient();
  
  // Build generation config
  const generationConfig: {
    maxOutputTokens: number;
    responseMimeType?: string;
    responseSchema?: Schema;
    thinkingConfig?: { thinkingBudget: number };
  } = {
    maxOutputTokens: maxTokens,
    thinkingConfig: { thinkingBudget: 0 },  // Disable thinking — saves tokens for actual output
  };
  
  // Enable structured JSON output if schema provided
  if (responseSchema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = responseSchema;
  }
  
  const model = client.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig,
  });

  // Build Gemini content parts from messages
  const contents = messages.map((m) => ({
    role: m.role,
    parts: [{ text: m.text }],
  }));

  console.log(`[Gemini] Calling gemini-2.5-flash with ${messages.length} messages`);

  const result = await model.generateContent({ contents });
  const response = result.response;
  
  // Log detailed feedback if available
  if (response.promptFeedback) {
    console.log(`[Gemini] Prompt feedback:`, JSON.stringify(response.promptFeedback));
  }
  
  // Check candidates for finish reason
  const candidates = response.candidates;
  if (candidates && candidates.length > 0) {
    const candidate = candidates[0];
    if (candidate.finishReason && candidate.finishReason !== "STOP") {
      throw new Error(
        `Gemini generation incomplete (${candidate.finishReason}). ` +
        `Output was truncated — reduce target duration or video length.`
      );
    }
    if (candidate.safetyRatings) {
      const blocked = candidate.safetyRatings.filter(
        (r: { probability: string }) => r.probability === "HIGH" || r.probability === "MEDIUM"
      );
      if (blocked.length > 0) {
        console.warn(`[Gemini] Safety concerns:`, JSON.stringify(blocked));
      }
    }
  } else {
    console.warn(`[Gemini] No candidates in response`);
  }
  
  const responseText = response.text();

  if (!responseText) {
    throw new Error(
      `Empty response from Gemini. ` +
      `Candidates: ${candidates?.length ?? 0}, ` +
      `FinishReason: ${candidates?.[0]?.finishReason ?? "unknown"}, ` +
      `PromptFeedback: ${JSON.stringify(response.promptFeedback) ?? "none"}`
    );
  }

  return responseText;
}
