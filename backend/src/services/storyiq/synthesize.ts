/**
 * StoryIQ Video Understanding Synthesis
 *
 * Builds a comprehensive VideoUnderstanding document from multiple 12Labs queries.
 * This is Phase 1 & 2 of the StoryIQ pipeline:
 * 1. Query 12Labs with focused prompts (via tools)
 * 2. Synthesize into unified understanding
 */

import {
  parseJSONFromLLM,
  type VideoUnderstanding,
  type SceneBreakdown,
  type TranscriptSegment,
  type CharacterInfo,
  type EmotionalBeat,
  type VisualNote,
  type StoryIQTools,
} from "./types";
import { callClaude } from "./claude-client";

// ============================================================================
// Synthesis Prompt
// ============================================================================

const SYNTHESIS_PROMPT = `You are synthesizing video analysis data into a coherent understanding.

Given the following analysis data, create a unified summary:

SCENES:
{scenes}

CHARACTERS:
{characters}

EMOTIONAL BEATS:
{emotions}

VISUAL NOTES:
{visuals}

TRANSCRIPT EXCERPT:
{transcript}

Create a JSON object with:
- logline: One compelling sentence describing what this video is about
- themes: Array of 3-5 major themes
- tone: Overall tone (e.g., "dramatic", "comedic", "suspenseful", "heartwarming")
- genre: Best genre classification if apparent
- peakMoments: Array of { timestamp: number, reason: string } for the most impactful moments

Output ONLY valid JSON, no explanation.`;

// ============================================================================
// Main Synthesis Function
// ============================================================================

export interface SynthesizeOptions {
  assetId: string;
  duration: number;
  title?: string;
  tools: StoryIQTools;
}

/**
 * Build comprehensive VideoUnderstanding from 12Labs analysis.
 *
 * This function:
 * 1. Queries all analysis tools in parallel where possible
 * 2. Handles partial failures gracefully
 * 3. Synthesizes high-level understanding via LLM
 */
export async function synthesizeVideoUnderstanding(
  options: SynthesizeOptions
): Promise<VideoUnderstanding> {
  const { assetId, duration, title, tools } = options;

  console.log("[StoryIQ Synthesize] Starting comprehensive analysis...");
  const startTime = Date.now();

  // Query all tools - some can run in parallel
  const [scenes, transcript, characters, emotions, visuals] = await Promise.all(
    [
      safeQuery(() => tools.read_scene_breakdown(), [] as SceneBreakdown[]),
      safeQuery(() => tools.read_full_transcript(), [] as TranscriptSegment[]),
      safeQuery(() => tools.read_character_analysis(), [] as CharacterInfo[]),
      safeQuery(() => tools.read_emotional_beats(), [] as EmotionalBeat[]),
      safeQuery(() => tools.read_visual_style_notes(), [] as VisualNote[]),
    ]
  );

  console.log(
    `[StoryIQ Synthesize] Raw analysis complete in ${Date.now() - startTime}ms`
  );
  console.log(
    `  - Scenes: ${scenes.length}, Characters: ${characters.length}, Emotions: ${emotions.length}`
  );

  // Validate scene timestamps - filter out any that exceed video duration
  // Allow 20% tolerance for minor timing discrepancies
  const maxAllowedTime = duration * 1.2;
  const validScenes = scenes.filter((scene) => {
    if (scene.endTime > maxAllowedTime) {
      console.warn(
        `[StoryIQ Synthesize] Discarding scene "${scene.description?.slice(0, 50)}..." ` +
          `(endTime ${scene.endTime}s > duration ${duration}s)`
      );
      return false;
    }
    return true;
  });

  if (validScenes.length < scenes.length) {
    console.warn(
      `[StoryIQ Synthesize] Filtered ${scenes.length - validScenes.length} scenes with invalid timestamps`
    );
  }

  // Similarly validate emotional arc timestamps
  const validEmotions = emotions.filter((e) => e.endTime <= maxAllowedTime);

  // Synthesize high-level understanding (using validated data)
  const synthesis = await synthesizeHighLevel(
    validScenes,
    characters,
    validEmotions,
    visuals,
    transcript
  );

  const understanding: VideoUnderstanding = {
    assetId,
    duration,
    title: title || synthesis.logline?.split(".")[0] || "Untitled",

    // High-level (from synthesis)
    logline: synthesis.logline || "Video content",
    themes: synthesis.themes || [],
    tone: synthesis.tone || "neutral",
    genre: synthesis.genre,

    // Detailed (from tools) - use validated scenes/emotions
    scenes: validScenes,
    characters,
    emotionalArc: validEmotions,
    visualNotes: visuals,
    transcript,

    // Quick lookups
    peakMoments: synthesis.peakMoments || extractPeakMoments(validEmotions),
  };

  console.log(`[StoryIQ Synthesize] Complete in ${Date.now() - startTime}ms`);

  return understanding;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Safely query a tool, returning default value on failure.
 */
async function safeQuery<T>(
  queryFn: () => Promise<T>,
  defaultValue: T
): Promise<T> {
  try {
    return await queryFn();
  } catch (error) {
    console.warn("[StoryIQ Synthesize] Tool query failed:", error);
    return defaultValue;
  }
}

/**
 * Use LLM to synthesize high-level understanding from raw data.
 */
async function synthesizeHighLevel(
  scenes: SceneBreakdown[],
  characters: CharacterInfo[],
  emotions: EmotionalBeat[],
  visuals: VisualNote[],
  transcript: TranscriptSegment[]
): Promise<{
  logline?: string;
  themes?: string[];
  tone?: string;
  genre?: string;
  peakMoments?: Array<{ timestamp: number; reason: string }>;
}> {
  // Prepare truncated data for prompt (avoid token limits)
  const sceneSummary = scenes
    .slice(0, 20)
    .map(
      (s) => `[${s.startTime}-${s.endTime}s] ${s.location}: ${s.description}`
    )
    .join("\n");

  const characterSummary = characters
    .map((c) => `${c.name}: ${c.description}`)
    .join("\n");

  const emotionSummary = emotions
    .map(
      (e) =>
        `[${e.startTime}-${e.endTime}s] ${e.intensity} ${e.emotion}: ${e.description}`
    )
    .join("\n");

  const visualSummary = visuals
    .slice(0, 10)
    .map((v) => `[${v.startTime}-${v.endTime}s] ${v.style}, ${v.pacing} pacing`)
    .join("\n");

  const transcriptExcerpt = transcript
    .slice(0, 30)
    .map((t) => t.text)
    .join(" ")
    .substring(0, 2000);

  const prompt = SYNTHESIS_PROMPT.replace(
    "{scenes}",
    sceneSummary || "No scene data"
  )
    .replace("{characters}", characterSummary || "No character data")
    .replace("{emotions}", emotionSummary || "No emotion data")
    .replace("{visuals}", visualSummary || "No visual data")
    .replace("{transcript}", transcriptExcerpt || "No transcript");

  try {
    const content = await callClaude({
      model: "sonnet",
      maxTokens: 1000,
      messages: [{ role: "user", content: prompt }],
    });

    return parseJSONFromLLM(content);
  } catch (error) {
    console.warn("[StoryIQ Synthesize] High-level synthesis failed:", error);
    return {};
  }
}

/**
 * Extract peak moments from emotional beats as fallback.
 */
function extractPeakMoments(
  emotions: EmotionalBeat[]
): Array<{ timestamp: number; reason: string }> {
  return emotions
    .filter((e) => e.intensity === "peak" || e.intensity === "high")
    .map((e) => ({
      timestamp: (e.startTime + e.endTime) / 2,
      reason: `${e.emotion}: ${e.description}`,
    }))
    .slice(0, 10); // Limit to top 10
}

// ============================================================================
// Utility: Format Understanding for Prompts
// ============================================================================

/**
 * Format VideoUnderstanding into a readable string for agent prompts.
 */
export function formatUnderstandingForPrompt(
  understanding: VideoUnderstanding
): string {
  const parts: string[] = [];

  // Header
  parts.push(`VIDEO: ${understanding.title}`);
  parts.push(`Duration: ${Math.round(understanding.duration)}s`);
  parts.push(`Logline: ${understanding.logline}`);
  parts.push(`Tone: ${understanding.tone}`);
  parts.push(`Themes: ${understanding.themes.join(", ")}`);
  parts.push("");

  // Scenes
  parts.push("SCENES:");
  for (const scene of understanding.scenes) {
    parts.push(
      `  [${scene.startTime}-${scene.endTime}s] Scene ${scene.sceneNumber}: ${scene.location}`
    );
    parts.push(`    ${scene.description}`);
    if (scene.characters.length > 0) {
      parts.push(`    Characters: ${scene.characters.join(", ")}`);
    }
  }
  parts.push("");

  // Characters
  if (understanding.characters.length > 0) {
    parts.push("CHARACTERS:");
    for (const char of understanding.characters) {
      parts.push(`  ${char.name}: ${char.description}`);
    }
    parts.push("");
  }

  // Emotional Arc
  parts.push("EMOTIONAL ARC:");
  for (const beat of understanding.emotionalArc) {
    const marker =
      beat.intensity === "peak" ? "★" : beat.intensity === "high" ? "▲" : "•";
    parts.push(
      `  ${marker} [${beat.startTime}-${beat.endTime}s] ${beat.emotion} (${beat.intensity})`
    );
  }
  parts.push("");

  // Peak Moments
  if (understanding.peakMoments.length > 0) {
    parts.push("PEAK MOMENTS:");
    for (const peak of understanding.peakMoments) {
      parts.push(`  ★ ${peak.timestamp}s: ${peak.reason}`);
    }
  }

  return parts.join("\n");
}
