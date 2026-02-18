/**
 * StoryIQ Prompts
 *
 * Prompt templates for the tool-based StoryIQ pipeline.
 * Tools enforce constraints; prompts provide context and purpose-specific instructions.
 */

import {
  Purpose,
  type VideoMetadata,
  type TranscriptSegment,
  type SceneWithDialogue,
} from "./types";
import { type SceneBreak } from "../twelvelabs";

// ============================================================================
// Tool-Based Prompt (main export)
// ============================================================================

/**
 * Simplified prompt for tool-based segment generation.
 * No output schema, no duration rules, no anti-patterns — the tools enforce all of that.
 * Just context (transcript + scenes) and purpose-specific instructions.
 */
export function getToolBasedPrompt(
  purpose: Purpose,
  metadata: VideoMetadata,
  transcript: TranscriptSegment[],
  sceneBreaks: SceneBreak[] | null,
  targetDuration?: number,
  userInstructions?: string,
  targetPercent?: number,
): string {
  // Build context section (same transcript + scene formatting)
  const groupedScenes = sceneBreaks
    ? groupDialogueByScene(sceneBreaks, transcript, metadata.duration)
    : null;
  const contextSection = groupedScenes
    ? formatScenesForPlanning(metadata, groupedScenes)
    : formatContextForPlanning(metadata, transcript, sceneBreaks);

  // Build purpose-specific instructions
  let instructions: string;

  switch (purpose) {
    case Purpose.FULL_VIDEO: {
      const expectedChapters = Math.ceil(metadata.duration / 90);
      instructions =
        `PURPOSE: Divide the entire video into chapters (like YouTube chapters).\n\n` +
        `INSTRUCTIONS:\n` +
        `- Create chapters covering ALL content — no gaps between chapters.\n` +
        `- First chapter starts at 0, last chapter ends at ${Math.round(metadata.duration)}s.\n` +
        `- Each chapter: 60-180 seconds, based on natural content breaks.\n` +
        `- Expected: ~${expectedChapters} chapters for this ${Math.round(metadata.duration)}s video.\n` +
        `- Title each chapter based on what is ACTUALLY SAID in the transcript at those timestamps.\n` +
        `- Find where conversations change, speakers shift, or topics transition — those are your chapter boundaries.`;
      break;
    }

    case Purpose.COMPACT_VIDEO:
    case Purpose.HIGHLIGHTS: {
      const percent = targetPercent || 50;
      const targetSeconds =
        targetDuration || Math.round((metadata.duration * percent) / 100);
      const expectedSegments = Math.round(targetSeconds / 90);
      instructions =
        `PURPOSE: Select the best ${percent}% of the video — cut ${100 - percent}% of the content.\n\n` +
        `TARGET: ~${Math.round(targetSeconds)}s total (~${expectedSegments} segments, each 60-180s).\n` +
        `The tool tracks your budget and will tell you how much time remains.\n\n` +
        `INSTRUCTIONS:\n` +
        `- SELECT high-impact content: emotional peaks, reveals, humor, tension, key plot points.\n` +
        `- CUT slow pacing, redundant dialogue, filler, disconnected subplots.\n` +
        `- Segments must be chronological and tell a coherent story when watched in order.\n` +
        `- There WILL BE GAPS between segments — that's the point of compacting.\n` +
        `- Title each segment based on what is ACTUALLY SAID in the transcript at those timestamps.`;
      break;
    }

    default: {
      // For trailer, tunein, bridge, recap, social — use generic instructions
      const targetSeconds = targetDuration || 90;
      instructions =
        `PURPOSE: ${purpose}\n` +
        `TARGET: ~${Math.round(targetSeconds)}s total.\n\n` +
        `INSTRUCTIONS:\n` +
        `- Create segments appropriate for ${purpose}.\n` +
        `- Title each segment based on what is ACTUALLY SAID in the transcript.\n` +
        `- The tool validates constraints and returns actual content for verification.`;
      break;
    }
  }

  let prompt =
    `You are StoryIQ, an expert video editor. Create segments using the provided tools.\n\n` +
    `${instructions}\n\n` +
    `HOW TO USE THE TOOLS:\n` +
    `1. Call add_segment for each segment. The tool validates it and returns the actual transcript content.\n` +
    `2. READ the returned content — verify your title matches what is really said.\n` +
    `3. Use update_segment to fix titles if the content doesn't match.\n` +
    `4. Use remove_segment if you need to drop a segment (over budget or poor quality).\n` +
    `5. Call finish_segments when done — it validates total duration/coverage.\n\n` +
    `CRITICAL RULES:\n` +
    `- Base titles on the TRANSCRIPT, not external knowledge about this content.\n` +
    `- Use precise timestamps from the transcript (e.g., 305.28s, not 300s).\n` +
    `- Segments must NOT overlap.\n\n` +
    `${contextSection}`;

  if (userInstructions?.trim()) {
    prompt += `\n\n---\nUSER INSTRUCTIONS: ${userInstructions.trim()}\n---`;
  }

  return prompt;
}

// ============================================================================
// Helper: Format Context for Planning
// ============================================================================

/**
 * Batch word-level transcript segments into sentences for token efficiency.
 * Groups by punctuation (. ? !) or time gaps (>2s pause).
 */
function batchTranscriptIntoSentences(
  transcript: TranscriptSegment[],
): { startTime: number; endTime: number; text: string }[] {
  if (transcript.length === 0) return [];

  const sentences: { startTime: number; endTime: number; text: string }[] = [];
  let currentWords: string[] = [];
  let startTime = transcript[0].startTime;
  let endTime = transcript[0].endTime;

  for (let i = 0; i < transcript.length; i++) {
    const seg = transcript[i];
    const text = seg.text.trim();

    // Check for time gap (>2s pause indicates new thought)
    const prevEndTime = i > 0 ? transcript[i - 1].endTime : seg.startTime;
    const timeGap = seg.startTime - prevEndTime;

    // Flush current sentence if there's a big time gap
    if (timeGap > 2 && currentWords.length > 0) {
      sentences.push({
        startTime,
        endTime,
        text: currentWords.join(" "),
      });
      currentWords = [];
      startTime = seg.startTime;
    }

    // Add word to current sentence (skip empty)
    if (text) {
      if (currentWords.length === 0) {
        startTime = seg.startTime;
      }
      currentWords.push(text);
      endTime = seg.endTime;
    }

    // Check if this word ends a sentence (punctuation)
    if (text.match(/[.?!]$/)) {
      sentences.push({
        startTime,
        endTime,
        text: currentWords.join(" "),
      });
      currentWords = [];
    }
  }

  // Don't forget remaining words
  if (currentWords.length > 0) {
    sentences.push({
      startTime,
      endTime,
      text: currentWords.join(" "),
    });
  }

  return sentences;
}

/**
 * Format video metadata, transcript, and scene breaks for planning prompts.
 * This is the primary context Claude uses to make segment decisions.
 */
function formatContextForPlanning(
  metadata: VideoMetadata,
  transcript: TranscriptSegment[],
  sceneBreaks: SceneBreak[] | null,
): string {
  const parts: string[] = [];

  // Basic metadata
  parts.push(`TITLE: ${metadata.title}`);
  parts.push(
    `DURATION: ${Math.round(metadata.duration)}s (${Math.round(
      metadata.duration / 60,
    )} min)`,
  );
  parts.push("");

  // Scene breaks (if available) - fallback format when grouping fails
  if (sceneBreaks && sceneBreaks.length > 0) {
    parts.push("SCENE BREAKS (what's visually happening):");
    for (const scene of sceneBreaks) {
      const timestamp = formatTimestamp(scene.time);
      parts.push(
        `  ${timestamp} | ${scene.who} | ${scene.action} | ${scene.mood} | ${scene.audio}`,
      );
    }
    parts.push("");
  }

  // Transcript - batched into sentences for token efficiency
  const sentences = batchTranscriptIntoSentences(transcript);
  parts.push(`TRANSCRIPT (${sentences.length} lines):`);
  parts.push("");
  for (const sentence of sentences) {
    const startTs = formatTimestamp(sentence.startTime);
    const endTs = formatTimestamp(sentence.endTime);
    parts.push(`  [${startTs}-${endTs}] ${sentence.text}`);
  }

  return parts.join("\n");
}

// ============================================================================
// Helper: Format Scenes with Grouped Dialogue
// ============================================================================

/**
 * Format timestamp as decimal seconds (e.g., 4849.0).
 * Using decimal seconds ensures the model outputs timestamps in the same format
 * we expect back — avoids confusion with MM:SS formats.
 */
function formatTimestamp(seconds: number): string {
  return seconds.toFixed(1);
}

/**
 * Group transcript dialogue into scenes.
 * Returns null if no scene breaks exist or if grouping fails.
 */
function groupDialogueByScene(
  sceneBreaks: SceneBreak[],
  transcript: TranscriptSegment[],
  videoDuration: number,
): SceneWithDialogue[] | null {
  // Fallback if no scenes
  if (!sceneBreaks || sceneBreaks.length === 0) {
    return null;
  }

  try {
    // Sort scenes by time
    const sorted = [...sceneBreaks].sort((a, b) => a.time - b.time);

    return sorted.map((scene, i) => {
      const startTime = scene.time;
      const endTime =
        i < sorted.length - 1 ? sorted[i + 1].time : videoDuration;

      // Get transcript segments that START within this scene (no duplicates across scenes)
      const dialogue = transcript.filter(
        (t) => t.startTime >= startTime && t.startTime < endTime,
      );

      const allText = dialogue.map((d) => d.text).join(" ");

      return {
        sceneIndex: i + 1,
        startTime,
        endTime,
        who: scene.who,
        action: scene.action,
        mood: scene.mood,
        audio: scene.audio,
        dialogue,
        wordCount: allText.split(/\s+/).filter((w) => w).length,
      };
    });
  } catch (error) {
    console.error("[StoryIQ] Failed to group dialogue by scene:", error);
    return null; // Fallback to existing format
  }
}

/**
 * Format grouped scenes for planning prompts.
 * Concatenates all dialogue into a single text block per scene for token efficiency.
 */
function formatScenesForPlanning(
  metadata: VideoMetadata,
  scenes: SceneWithDialogue[],
): string {
  const parts: string[] = [];

  parts.push(`TITLE: ${metadata.title}`);
  parts.push(
    `DURATION: ${Math.round(metadata.duration)}s (${Math.round(
      metadata.duration / 60,
    )} min)`,
  );
  parts.push(`SCENES: ${scenes.length} total`);
  parts.push("");

  for (const scene of scenes) {
    const startTs = formatTimestamp(scene.startTime);
    const endTs = formatTimestamp(scene.endTime);
    const duration = Math.round(scene.endTime - scene.startTime);

    parts.push(
      `--- Scene ${scene.sceneIndex} (${startTs} - ${endTs}) | ${duration}s ---`,
    );
    parts.push(
      `Visual: ${scene.who} | ${scene.action} | ${scene.mood} | ${scene.audio}`,
    );

    if (scene.dialogue.length > 0) {
      // Batch dialogue into sentences - same as transcript-only mode for consistency
      const sentences = batchTranscriptIntoSentences(scene.dialogue);
      for (const sentence of sentences) {
        const sentenceStartTs = formatTimestamp(sentence.startTime);
        const sentenceEndTs = formatTimestamp(sentence.endTime);
        parts.push(`  [${sentenceStartTs}-${sentenceEndTs}] ${sentence.text}`);
      }
    } else {
      parts.push("  (visual/music only - no dialogue)");
    }
    parts.push("");
  }

  return parts.join("\n");
}
