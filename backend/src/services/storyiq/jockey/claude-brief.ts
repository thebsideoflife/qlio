/**
 * Claude Sonnet via SporeLabs for Jockey narrative brief preprocess.
 */

import {
  SPORELABS_SONNET_MODEL,
  sporelabsChatText,
} from "../../sporelabs";

const PREPROCESS_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_TOKENS = 8192;

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
}): Promise<{ parsed: unknown; source: "sporelabs" }> {
  const { systemPrompt, userPrompt } = opts;

  const text = await sporelabsChatText({
    model: SPORELABS_SONNET_MODEL,
    system: systemPrompt,
    user: userPrompt,
    maxTokens: MAX_OUTPUT_TOKENS,
    timeoutMs: PREPROCESS_TIMEOUT_MS,
  });
  try {
    return { parsed: parseClaudeJson(text), source: "sporelabs" };
  } catch (parseErr) {
    throw new Error(
      `[Jockey] Claude preprocess JSON parse failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
    );
  }
}
