/**
 * Enrich Pegasus clip descriptions with transcript-aware context via Claude.
 * Pegasus sees only the clip; the transcript carries names and broader story context.
 * Tries Bedrock first, falls back to direct Anthropic API, then Pegasus output.
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
import type { TranscriptSegment } from "./storyiq/types";
import {
  truncateFullTranscriptPlain,
  transcriptInRangePlain,
} from "../utils/transcript";
import {
  parseExportMetadataResponse,
  type ExportMetadataOptions,
  type ParsedSegmentMetadata,
} from "./export-metadata";

const bedrockClient = new BedrockRuntimeClient({ region: "us-west-2" });
const secretsClient = new SecretsManagerClient({});
// Must use inference profile ID — raw model IDs fail on-demand in us-west-2.
const BEDROCK_MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const ANTHROPIC_API_MODEL = "claude-sonnet-4-5-20250929";
const ENRICHMENT_TIMEOUT_MS = 180_000; // 3 minutes

// Context limits — Sonnet has a large context window (~800K chars).
// We use ~10K tokens max (~40K chars) leaving plenty of headroom.
const MAX_FULL_TRANSCRIPT_CHARS = 24_000; // ~6K tokens — enough for character names
const MAX_SCENE_DIALOGUE_CHARS = 16_000; // ~4K tokens — handles 10+ min segments

let cachedAnthropicApiKey: string | null | undefined;

export interface EnrichDescriptionsInput {
  pegasus: ParsedSegmentMetadata;
  transcript: TranscriptSegment[];
  segmentStart: number;
  segmentEnd: number;
  videoTitle?: string;
  options: ExportMetadataOptions;
}

function buildEnrichmentPrompt(input: EnrichDescriptionsInput): string {
  const { pegasus, transcript, segmentStart, segmentEnd, videoTitle, options } =
    input;

  const lengths = options.descriptionLengths ?? [
    "short",
    "two_sentences",
    "paragraph",
  ];

  const fieldSpecs: string[] = [];
  if (lengths.includes("short")) {
    fieldSpecs.push('"description_short": "max 15 words"');
  }
  if (lengths.includes("two_sentences")) {
    fieldSpecs.push('"description_two_sentences": "exactly 2 sentences"');
  }
  if (lengths.includes("paragraph")) {
    fieldSpecs.push('"description_paragraph": "3-5 sentences"');
  }

  const fullTranscript = truncateFullTranscriptPlain(
    transcript,
    MAX_FULL_TRANSCRIPT_CHARS,
  );

  const pegasusText =
    pegasus.descriptions?.paragraph ||
    pegasus.descriptions?.two_sentences ||
    pegasus.descriptions?.short ||
    "";

  let clipDialogue = transcriptInRangePlain(
    transcript,
    segmentStart,
    segmentEnd,
  );
  if (clipDialogue.length > MAX_SCENE_DIALOGUE_CHARS) {
    clipDialogue = clipDialogue.slice(0, MAX_SCENE_DIALOGUE_CHARS - 1) + "…";
  }

  const titleLine = videoTitle?.trim() ? `"${videoTitle.trim()}"` : "";

  return `Write descriptions for a scene from ${titleLine || "a video"}. Use character names from the transcript. Keep visual details accurate. Don't say "the scene" or "the clip" — just describe what happens.

<full_transcript>
${fullTranscript || "(none)"}
</full_transcript>

<visual_description>
${pegasusText || "(none)"}
</visual_description>

<scene_dialogue>
${clipDialogue || "(none)"}
</scene_dialogue>

JSON only:
{
  ${fieldSpecs.join(",\n  ")}
}`;
}

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
    const apiKey = secret.SecretString?.trim();
    cachedAnthropicApiKey = apiKey || null;
    return cachedAnthropicApiKey;
  } catch (err) {
    console.warn(
      "[ExportMetadata] Could not load Anthropic API key for fallback:",
      err,
    );
    cachedAnthropicApiKey = null;
    return null;
  }
}

async function invokeBedrock(prompt: string, signal: AbortSignal): Promise<string> {
  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
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

async function invokeAnthropicApi(prompt: string): Promise<string> {
  const apiKey = await getAnthropicApiKey();
  if (!apiKey) {
    throw new Error("Anthropic API key not configured");
  }

  const client = new Anthropic({
    apiKey,
    timeout: ENRICHMENT_TIMEOUT_MS,
  });

  const message = await client.messages.create({
    model: ANTHROPIC_API_MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const block = message.content[0];
  return block?.type === "text" ? block.text : "";
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

async function invokeClaudeForEnrichment(
  prompt: string,
): Promise<{ text: string; source: "bedrock" | "anthropic_api" }> {
  try {
    const text = await withTimeout(ENRICHMENT_TIMEOUT_MS, (signal) =>
      invokeBedrock(prompt, signal),
    );
    return { text, source: "bedrock" };
  } catch (bedrockErr) {
    console.warn(
      "[ExportMetadata] Bedrock enrichment failed, trying Anthropic API:",
      bedrockErr,
    );
    const text = await invokeAnthropicApi(prompt);
    return { text, source: "anthropic_api" };
  }
}

/**
 * Best-effort enrichment. Never throws — returns Pegasus output on any failure.
 */
export async function enrichSegmentDescriptions(
  input: EnrichDescriptionsInput,
): Promise<ParsedSegmentMetadata> {
  if (!input.transcript.length) {
    return input.pegasus;
  }
  if (!input.pegasus.descriptions) {
    return input.pegasus;
  }
  if (input.options.includeDescriptions === false) {
    return input.pegasus;
  }

  try {
    const prompt = buildEnrichmentPrompt(input);
    const { text, source } = await invokeClaudeForEnrichment(prompt);

    if (!text.trim()) {
      console.warn("[ExportMetadata] Claude enrichment returned empty response");
      return input.pegasus;
    }

    const enriched = parseExportMetadataResponse(text, input.options);
    if (!enriched.descriptions) {
      console.warn(
        "[ExportMetadata] Claude enrichment response had no descriptions",
      );
      return input.pegasus;
    }

    console.log(
      `[ExportMetadata] Claude enrichment succeeded via ${source} for ${Object.keys(enriched.descriptions).join(", ")}`,
    );

    return {
      ...input.pegasus,
      descriptions: {
        ...input.pegasus.descriptions,
        ...enriched.descriptions,
      },
    };
  } catch (err) {
    console.warn(
      "[ExportMetadata] Claude enrichment failed, using Pegasus output:",
      err,
    );
    return input.pegasus;
  }
}
