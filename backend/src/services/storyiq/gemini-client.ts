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
import { GoogleGenerativeAI } from "@google/generative-ai";

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
}

/**
 * Call Gemini 2.5 Pro with a conversation history.
 * Returns the text content from the response.
 */
export async function callGemini(options: GeminiOptions): Promise<string> {
  const { maxTokens = 8000, messages } = options;
  const client = await getClient();
  const model = client.getGenerativeModel({
    model: "gemini-2.5-pro",
    generationConfig: { maxOutputTokens: maxTokens },
  });

  // Build Gemini content parts from messages
  const contents = messages.map((m) => ({
    role: m.role,
    parts: [{ text: m.text }],
  }));

  console.log(`[Gemini] Calling gemini-2.5-pro with ${messages.length} messages`);

  const result = await model.generateContent({ contents });
  const responseText = result.response.text();

  if (!responseText) {
    throw new Error("Empty response from Gemini");
  }

  return responseText;
}
