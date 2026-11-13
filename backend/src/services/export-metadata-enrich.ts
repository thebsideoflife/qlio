/**
 * Enrich Pegasus clip descriptions with transcript-aware context via Claude
 * through SporeLabs. Pegasus sees only the clip; the transcript carries names
 * and broader story context. On failure, Pegasus output is returned as-is.
 */

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
import { SPORELABS_SONNET_MODEL, sporelabsChatText } from "./sporelabs";

const ENRICHMENT_TIMEOUT_MS = 180_000; // 3 minutes

// Context limits — Sonnet has a large context window (~800K chars).
// We use ~10K tokens max (~40K chars) leaving plenty of headroom.
const MAX_FULL_TRANSCRIPT_CHARS = 24_000; // ~6K tokens — enough for character names
const MAX_SCENE_DIALOGUE_CHARS = 16_000; // ~4K tokens — handles 10+ min segments


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

async function invokeClaudeForEnrichment(
  prompt: string,
): Promise<{ text: string; source: "sporelabs" }> {
  const text = await sporelabsChatText({
    model: SPORELABS_SONNET_MODEL,
    user: prompt,
    // Headroom for Sonnet 5.5's default thinking, which counts against this.
    maxTokens: 4096,
    timeoutMs: ENRICHMENT_TIMEOUT_MS,
  });
  return { text, source: "sporelabs" };
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
