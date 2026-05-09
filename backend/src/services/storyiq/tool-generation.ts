/**
 * Segment Generation — Gemini 2.5 Pro
 *
 * Replaces the Claude tool-use pipeline with a simpler Gemini prompt-based approach.
 * Uses a social-media content strategist persona for high-retention short-form clips.
 *
 * Pipeline:
 * 1. Single Gemini call with structured prompt → JSON segments
 * 2. Quality validation (deterministic)
 * 3. Constraint enforcement (deterministic)
 */

import {
  Purpose,
  type ProposedSegment,
  type TranscriptSegment,
  type VideoMetadata,
  type FinalSegments,
} from "./types";
import { type SceneBreak } from "../twelvelabs";
import { getVideoContext } from "./prompts";
import { enforceConstraints } from "./verify";
import { callGemini } from "./gemini-client";
import { SchemaType, type Schema } from "@google/generative-ai";

// Schema for structured JSON output from Gemini
const SEGMENTS_RESPONSE_SCHEMA: Schema = {
  type: SchemaType.ARRAY,
  items: {
    type: SchemaType.OBJECT,
    properties: {
      startTime: {
        type: SchemaType.NUMBER,
        description: "Start time in seconds (decimal, e.g. 123.45)",
      },
      endTime: {
        type: SchemaType.NUMBER,
        description: "End time in seconds (decimal, e.g. 234.56)",
      },
      title: {
        type: SchemaType.STRING,
        description:
          "Short descriptive title for the segment based on dialogue",
      },
      reasoning: {
        type: SchemaType.STRING,
        description: "Brief explanation of why this segment was selected",
      },
    },
    required: ["startTime", "endTime", "title"],
  },
};

// ============================================================================
// Main Orchestration
// ============================================================================

export interface GenerateWithToolsOptions {
  metadata: VideoMetadata;
  transcript: TranscriptSegment[];
  sceneBreaks: SceneBreak[] | null;
  purpose: Purpose;
  targetDuration?: number;
  targetPercent?: number;
  userInstructions?: string;
}

/**
 * Generate segments using Gemini 2.5 Pro.
 *
 * Single prompt → JSON parse → deterministic constraint enforcement.
 */
export async function generateSegmentsWithTools(
  options: GenerateWithToolsOptions,
): Promise<FinalSegments> {
  const { metadata, transcript, sceneBreaks, purpose, targetDuration } =
    options;
  const startTime = Date.now();

  console.log(`[StoryIQ Gemini] Starting generation for ${metadata.assetId}`);
  console.log(
    `[StoryIQ Gemini] Purpose: ${purpose}, Target: ${targetDuration || "auto"}s, Video: ${metadata.duration}s`,
  );

  // Build video context (transcript + scenes) — no tool instructions
  const videoContext = getVideoContext(
    metadata,
    transcript,
    sceneBreaks,
    options.userInstructions,
  );

  // Build the Gemini prompt with social-media strategist persona
  const geminiPrompt = buildGeminiSegmentPrompt(
    purpose,
    metadata,
    videoContext,
    targetDuration,
    options.targetPercent,
  );

  console.log(
    `[StoryIQ Gemini] Prompt: ${geminiPrompt.length} chars (~${Math.round(geminiPrompt.length / 4)} tokens)`,
  );

  // ── Single Gemini Call ─────────────────────────────────────────────

  let rawSegments: ProposedSegment[] = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await callGemini({
        maxTokens: 65536, // Large videos need substantial output space
        messages: [{ role: "user", text: geminiPrompt }],
        responseSchema: SEGMENTS_RESPONSE_SCHEMA,
      });

      console.log(`[StoryIQ Gemini] Response length: ${response.length} chars`);

      // Structured output (responseSchema) → single JSON value; parse directly
      const parsed = JSON.parse(response.trim()) as unknown;

      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error(`Expected array of segments, got: ${typeof parsed}`);
      }

      rawSegments = parsed.map((seg) => ({
        startTime: coerceTimestamp(seg.startTime, metadata.duration),
        endTime: coerceTimestamp(seg.endTime, metadata.duration),
        title: seg.title,
        reasoning: seg.reasoning || "",
        expectedContent: seg.expectedContent || "",
      }));

      console.log(
        `[StoryIQ Gemini] Parsed ${rawSegments.length} segments on attempt ${attempt}`,
      );
      break;
    } catch (err) {
      console.error(
        `[StoryIQ Gemini] Attempt ${attempt} failed:`,
        err instanceof Error ? err.message : err,
      );
      if (attempt === 2) {
        throw new Error(
          `[StoryIQ Gemini] Failed to generate segments after 2 attempts: ${
            err instanceof Error ? err.message : "Unknown error"
          }`,
        );
      }
    }
  }

  // ── Deterministic Constraint Enforcement ────────────────────────────

  console.log(
    `[StoryIQ Gemini] Enforcing constraints on ${rawSegments.length} segments`,
  );

  const { segments: enforced, changes } = enforceConstraints(
    rawSegments,
    metadata,
    transcript,
    purpose,
    targetDuration,
  );

  if (changes.length > 0) {
    console.warn(`[StoryIQ Gemini] Enforcer made ${changes.length} change(s):`);
    changes.forEach((c) => console.warn(`  - ${c.detail}`));
  } else {
    console.log(`[StoryIQ Gemini] Enforcer: no changes needed (clean output)`);
  }

  // ── Return ─────────────────────────────────────────────────────────

  const processingTime = Date.now() - startTime;
  const totalDuration = enforced.reduce(
    (sum, s) => sum + (s.endTime - s.startTime),
    0,
  );

  console.log(
    `[StoryIQ Gemini] Complete in ${processingTime}ms. ` +
      `${enforced.length} segments, ${Math.round(totalDuration)}s total`,
  );

  const confidence = changes.length === 0 ? 0.9 : 0.75;

  return {
    segments: enforced,
    confidence,
    notes:
      changes.length > 0
        ? [
            `Enforcer applied ${changes.length} fix(es) after Gemini generation.`,
          ]
        : ["All constraints met by Gemini generation."],
    attempts: 1,
  };
}

// ============================================================================
// Timestamp Coercion
// ============================================================================

/**
 * Coerce a Gemini-returned timestamp to a valid decimal-seconds number.
 * Handles: numbers, numeric strings, "MM:SS" / "HH:MM:SS" strings.
 * Clamps result to [0, videoDuration].
 */
function coerceTimestamp(
  value: number | string,
  videoDuration: number,
): number {
  let seconds: number;

  if (typeof value === "number") {
    seconds = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    // Handle "MM:SS" or "HH:MM:SS"
    if (trimmed.includes(":")) {
      const parts = trimmed.split(":").map(Number);
      if (parts.length === 3) {
        seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
      } else if (parts.length === 2) {
        seconds = parts[0] * 60 + parts[1];
      } else {
        seconds = parseFloat(trimmed) || 0;
      }
    } else {
      seconds = parseFloat(trimmed) || 0;
    }
  } else {
    seconds = 0;
  }

  // Clamp to valid range
  return Math.max(0, Math.min(seconds, videoDuration));
}

// ============================================================================
// Gemini Prompt Builder — Social Media Content Strategist
// ============================================================================

function buildGeminiSegmentPrompt(
  purpose: Purpose,
  metadata: VideoMetadata,
  contextPrompt: string,
  targetDuration?: number,
  targetPercent?: number,
): string {
  const percent = targetPercent || 50;
  const targetSeconds =
    targetDuration || Math.round((metadata.duration * percent) / 100);

  let purposeInstructions: string;

  switch (purpose) {
    case Purpose.FULL_VIDEO: {
      const expectedChapters = Math.ceil(metadata.duration / 90);
      purposeInstructions =
        `Divide the ENTIRE video into ${expectedChapters} chapters covering ALL content.\n` +
        `- First chapter starts at 0, last chapter ends at ${Math.round(metadata.duration)}s.\n` +
        `- Each chapter: 60-180 seconds.\n` +
        `- No gaps between chapters.`;
      break;
    }

    case Purpose.COMPACT_VIDEO:
    case Purpose.HIGHLIGHTS:
    default: {
      purposeInstructions =
        `Select the best ${percent}% of the video — approximately ${Math.round(targetSeconds)}s total.\n\n` +
        `As a social media content strategist, apply these principles:\n` +
        `1. HOOK FIRST — The first segment must be a "thumb-stop" moment: an emotional peak, surprising reveal, or high-energy moment that grabs attention in the first 3 seconds.\n` +
        `2. HIGH-VALUE MOMENTS — Prioritize emotional peaks, reveals, humor, tension, and key plot points. Cut slow pacing, redundant dialogue, and filler.\n` +
        `3. NARRATIVE ARC — Even in condensed form, maintain Setup → Conflict → Resolution. The segments should tell a coherent story.\n` +
        `4. AUTHENTIC DIALOGUE — Keep original dialogue. Don't paraphrase or summarize what people say.\n` +
        `5. PACING — Vary segment lengths for rhythm. Short punchy segments (60-90s) near the start, allow slightly longer (up to 180s) for climactic moments.\n\n` +
        `Each segment should be 60-180 seconds. Target ~${Math.max(1, Math.round(targetSeconds / 90))} segments.`;
      break;
    }
  }

  return (
    `You are a social media content strategist who specializes in creating high-retention short-form video edits.\n\n` +
    `${purposeInstructions}\n\n` +
    `RULES:\n` +
    `- Timestamps MUST be decimal seconds (e.g., 305.28, 90.0). NEVER use MM:SS or HH:MM:SS format.\n` +
    `- Use PRECISE timestamps from the transcript — match to the nearest tenth of a second.\n` +
    `- All timestamps must be between 0 and ${Math.round(metadata.duration)}.\n` +
    `- Segments must NOT overlap.\n` +
    `- Segments must be chronological.\n` +
    `- Title each segment based on what is ACTUALLY SAID in the transcript at those timestamps.\n\n` +
    `OUTPUT FORMAT: Return ONLY a JSON array. No prose, no markdown fences, no code blocks.\n` +
    `[\n` +
    `  {\n` +
    `    "startTime": 12.5,\n` +
    `    "endTime": 85.3,\n` +
    `    "title": "Compelling title based on dialogue",\n` +
    `    "reasoning": "Why this segment works"\n` +
    `  }\n` +
    `]\n\n` +
    `--- VIDEO CONTEXT ---\n\n` +
    `${contextPrompt}`
  );
}
