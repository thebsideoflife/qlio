/**
 * Content Classifier
 *
 * Multi-tier classification with fallbacks:
 * 1. TwelveLabs Pegasus (first 120s of video) - most accurate
 * 2. Gemini title-based classification - fast fallback
 * 3. Default to "sports" - safe fallback for our use case
 *
 * We default to "sports" rather than "generic" because:
 * - Our primary use case is sports highlights
 * - Sports replay detection failing is worse than running it on non-sports
 */

import type { TwelveLabs, TwelvelabsApi } from "twelvelabs-js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { ContentType } from "./types";

export interface ClassifyResult {
  contentType: ContentType;
  confidence: number;
  reasoning: string;
  source: "pegasus" | "gemini_title" | "default";
}

/** Analyze only first 2 minutes — genre is obvious from opening content. */
const CLASSIFICATION_WINDOW_SEC = 120;

/** Max retries for TwelveLabs API errors */
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Classify video content with multi-tier fallback.
 *
 * Priority:
 * 1. TwelveLabs Pegasus (video analysis) - most accurate
 * 2. Gemini title classification - if title is informative
 * 3. Default to "sports" - safe fallback
 */
export async function classifyContent(
  client: TwelveLabs,
  video: TwelvelabsApi.VideoContext,
  title?: string,
  geminiApiKey?: string,
): Promise<ClassifyResult> {
  // Tier 1: Try TwelveLabs Pegasus with retry
  try {
    const result = await classifyWithPegasusRetry(client, video, title);
    return { ...result, source: "pegasus" };
  } catch (pegasusErr) {
    const errMsg = pegasusErr instanceof Error ? pegasusErr.message : String(pegasusErr);
    console.warn(`[Classifier] Pegasus failed after retries: ${errMsg}`);
  }

  // Tier 2: Try Gemini title-based classification (if we have a real title)
  if (geminiApiKey && title && title !== "Untitled Video" && title.length > 3) {
    try {
      const result = await classifyWithGeminiTitle(geminiApiKey, title);
      if (result.confidence >= 0.6) {
        return { ...result, source: "gemini_title" };
      }
      console.log(`[Classifier] Gemini title confidence too low (${result.confidence}), using default`);
    } catch (geminiErr) {
      const errMsg = geminiErr instanceof Error ? geminiErr.message : String(geminiErr);
      console.warn(`[Classifier] Gemini title classification failed: ${errMsg}`);
    }
  } else if (!title || title === "Untitled Video") {
    console.log("[Classifier] No useful title for Gemini fallback");
  }

  // Tier 3: Default to sports (our primary use case)
  console.log("[Classifier] All classifiers failed, defaulting to SPORTS");
  return {
    contentType: "sports",
    confidence: 0.5,
    reasoning: "Classification failed, defaulting to sports (primary use case)",
    source: "default",
  };
}

// ============================================================================
// Tier 1: TwelveLabs Pegasus
// ============================================================================

async function classifyWithPegasusRetry(
  client: TwelveLabs,
  video: TwelvelabsApi.VideoContext,
  title?: string,
): Promise<Omit<ClassifyResult, "source">> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await classifyWithPegasus(client, video, title);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Check if retryable (5xx errors, timeouts)
      const isRetryable =
        lastError.message.includes("500") ||
        lastError.message.includes("502") ||
        lastError.message.includes("503") ||
        lastError.message.includes("timeout") ||
        lastError.message.includes("ETIMEDOUT");

      if (isRetryable && attempt < MAX_RETRIES) {
        console.warn(
          `[Classifier] Pegasus attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${RETRY_DELAY_MS}ms: ${lastError.message}`,
        );
        await sleep(RETRY_DELAY_MS * attempt); // Exponential backoff
        continue;
      }

      // Not retryable or last attempt
      break;
    }
  }

  throw lastError || new Error("Pegasus classification failed");
}

async function classifyWithPegasus(
  client: TwelveLabs,
  video: TwelvelabsApi.VideoContext,
  title?: string,
): Promise<Omit<ClassifyResult, "source">> {
  console.log(
    `[Classifier] Pegasus 1.5 (0-${CLASSIFICATION_WINDOW_SEC}s)${title ? ` title="${title}"` : ""}`,
  );

  const res = await client.analyze({
    modelName: "pegasus1.5",
    video,
    prompt: buildPegasusPrompt(title),
    maxTokens: 512,
    startTime: 0,
    endTime: CLASSIFICATION_WINDOW_SEC,
  });

  console.log(`[Classifier] Pegasus usage: ${JSON.stringify(res.usage)}`);

  if (!res.data) {
    throw new Error("Pegasus returned empty response");
  }

  const result = parseClassificationResponse(res.data);
  console.log(`[Classifier] Pegasus result: ${result.contentType} (${result.confidence})`);
  return result;
}

function buildPegasusPrompt(title?: string): string {
  const titleHint = title ? `\nVideo title: "${title}"\n` : "";
  return `Classify this video into exactly ONE category:
- sports: Live sports game, match, or highlights reel with scores, plays, commentary
- serialized_scifi: Episodic science fiction drama with A/B/C plot threads (like Star Trek)
- generic: Everything else (documentary, news, vlog, tutorial, general drama, etc.)
${titleHint}
Respond with JSON only:
{"type": "sports" | "serialized_scifi" | "generic", "confidence": 0.0-1.0, "reasoning": "one sentence"}`;
}

// ============================================================================
// Tier 2: Gemini Title-Based Classification
// ============================================================================

async function classifyWithGeminiTitle(
  apiKey: string,
  title: string,
): Promise<Omit<ClassifyResult, "source">> {
  console.log(`[Classifier] Gemini title classification: "${title}"`);

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const prompt = `Based ONLY on this video title, classify the content type.

Title: "${title}"

Categories:
- sports: Any sports game, match, highlights, or sports-related content (NFL, NBA, soccer, hockey, baseball, etc.)
- serialized_scifi: Science fiction TV series like Star Trek
- generic: Everything else

Look for keywords like team names, league names (NFL, NBA, NHL, MLB, Premier League), game terminology, player names, etc.

Respond with JSON only:
{"type": "sports" | "serialized_scifi" | "generic", "confidence": 0.0-1.0, "reasoning": "brief explanation"}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();

  console.log(`[Classifier] Gemini raw response: ${text.substring(0, 200)}`);

  const parsed = parseClassificationResponse(text);
  console.log(`[Classifier] Gemini title result: ${parsed.contentType} (${parsed.confidence})`);
  return parsed;
}

// ============================================================================
// Response Parsing
// ============================================================================

function parseClassificationResponse(raw: string): Omit<ClassifyResult, "source"> {
  const trimmed = raw.trim();
  let body = trimmed;

  // Strip markdown fences if present
  const fence = /```(?:json)?\s*([\s\S]*?)```/m.exec(trimmed);
  if (fence) {
    body = fence[1].trim();
  }

  // Find JSON object
  const objStart = body.indexOf("{");
  const objEnd = body.lastIndexOf("}");

  if (objStart >= 0 && objEnd > objStart) {
    try {
      const parsed = JSON.parse(body.slice(objStart, objEnd + 1)) as Record<string, unknown>;
      return {
        contentType: normalizeType(parsed.type),
        confidence: normalizeConfidence(parsed.confidence),
        reasoning: String(parsed.reasoning || ""),
      };
    } catch {
      console.warn("[Classifier] JSON parse failed");
    }
  }

  // Fallback: detect from raw text keywords
  const lower = trimmed.toLowerCase();
  if (lower.includes("sports") || lower.includes("game") || lower.includes("match")) {
    return { contentType: "sports", confidence: 0.5, reasoning: "Inferred from text" };
  }
  if (lower.includes("scifi") || lower.includes("sci-fi") || lower.includes("trek")) {
    return { contentType: "serialized_scifi", confidence: 0.5, reasoning: "Inferred from text" };
  }

  // Default to sports for our use case
  return { contentType: "sports", confidence: 0.3, reasoning: "Parse failed, defaulting to sports" };
}

function normalizeType(value: unknown): ContentType {
  if (typeof value !== "string") return "sports"; // Default to sports
  const v = value.toLowerCase().trim().replace(/[\s_-]+/g, "_");
  if (v === "sports" || v === "sports_broadcast") return "sports";
  if (v === "serialized_scifi" || v === "scifi" || v === "trek") return "serialized_scifi";
  if (v === "generic" || v === "other") return "generic";
  return "sports"; // Default to sports for unknown
}

function normalizeConfidence(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === "string") {
    const n = parseFloat(value);
    if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
  }
  return 0.7;
}

// ============================================================================
// Utilities
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
