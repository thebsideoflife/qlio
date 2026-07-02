/**
 * Jockey v3 prompt templates — self-directed cutting.
 *
 * Prompts are first-class code artifacts (12-factor agents). Per
 * SPEC-jockey-v3-self-directed-cuts.md, the only guidance Jockey receives is
 * the producer's intent plus format and target runtime — no preprocessing
 * brief, no external scene data. Jockey explores the asset, decides where the
 * scenes are, and returns the final cuts.
 */

import type { JockeyV3PurposeKey, V3Issue } from "./self-directed";
import {
  COMPACT_BAND_LOWER_MULT,
  COMPACT_BAND_UPPER_MULT,
  RECAP_MAX_BEATS,
  RECAP_MAX_TOTAL_SEC,
  RECAP_MIN_BEATS,
  RECAP_MIN_TOTAL_SEC,
  SCENE_EDGE_TOLERANCE_SEC,
} from "./self-directed";

export const SELF_DIRECTED_INSTRUCTIONS =
  "You are a professional video editor with full access to this video through your knowledge store. " +
  "You explore the content yourself, decide where the scenes are, and return final, ship-ready cuts. " +
  "Every cut must open and close exactly on a scene change you identified — never mid-scene, mid-gesture, or mid-word. " +
  "Your cuts are used as-is with no downstream editing, so the timestamps you return are the timestamps that ship.";

export interface SelfDirectedPromptOptions {
  purpose: JockeyV3PurposeKey;
  title: string;
  durationSec: number;
  targetSeconds: number;
  userInstructions?: string;
}

function formatBlock(opts: SelfDirectedPromptOptions): string {
  const { purpose, durationSec, targetSeconds } = opts;
  if (purpose === "episode_recap") {
    return [
      `FORMAT: Episode recap ("Previously on…").`,
      `- Return ${RECAP_MIN_BEATS}–${RECAP_MAX_BEATS} beats totaling ${RECAP_MIN_TOTAL_SEC}–${RECAP_MAX_TOTAL_SEC} seconds.`,
      `- Ordered beats must read as a connected setup → payoff mini-story, not a highlight reel.`,
      `- Pick the sharpest moment inside a scene; each beat opens and closes on a scene boundary — never mid-line.`,
    ].join("\n");
  }
  const lower = Math.round(targetSeconds * COMPACT_BAND_LOWER_MULT);
  const upper = Math.round(targetSeconds * COMPACT_BAND_UPPER_MULT);
  return [
    `FORMAT: Compact cut of the full story.`,
    `- Source runs ${Math.round(durationSec)}s. Keep scenes totaling ${lower}–${upper}s (target ~${Math.round(targetSeconds)}s).`,
    `- Hit the target by choosing which whole scenes to keep — never by clipping a scene short.`,
    `- Follow the narrative arc across the ENTIRE timeline: selections must appear in every quarter of the source, opening act through ending.`,
    `- Each kept segment must be watchable in isolation: it starts where a scene starts and ends where that scene ends.`,
  ].join("\n");
}

export function buildSelfDirectedPrompt(
  opts: SelfDirectedPromptOptions,
): string {
  const producerBlock = opts.userInstructions?.trim()
    ? `PRODUCER INTENT (honor named themes, scenes, and characters):\n${opts.userInstructions.trim()}`
    : "PRODUCER INTENT: none given — favor dialog-forward scenes that advance the story.";

  return [
    `Cut "${opts.title}" (${Math.round(opts.durationSec)}s source).`,
    "",
    producerBlock,
    "",
    formatBlock(opts),
    "",
    `WORKFLOW:`,
    `1. Explore the video and identify its scene changes — the moments where one scene ends and the next begins.`,
    `2. Choose the scenes to keep based on the producer intent and format above.`,
    `3. Return the final cuts. Every startTime and endTime must sit exactly on one of the scene changes you identified (within ${SCENE_EDGE_TOLERANCE_SEC}s).`,
    "",
    `OUTPUT RULES:`,
    `- All timestamps are seconds on the source video timeline.`,
    `- segments: chronological, non-overlapping final cuts.`,
    `- sceneBoundaries: every scene-change timestamp you identified while exploring (including all cut edges).`,
    `- title: human-readable headline per segment, ≤10 words, WHO does WHAT. No "(Part N)" or numbering suffixes.`,
    `- description: one sentence on why the scene earns its place.`,
  ].join("\n");
}

/**
 * Re-ask prompt for a bounded retry: the previous pass plus the specific
 * validation failures. Code never repairs the cuts — Jockey revises them.
 */
export function buildRevisionPrompt(opts: {
  base: SelfDirectedPromptOptions;
  previousResponseJson: string;
  issues: V3Issue[];
  passNumber: number;
}): string {
  const issueLines = opts.issues
    .map((i) => `- [${i.code}] ${i.message}`)
    .join("\n");

  return [
    buildSelfDirectedPrompt(opts.base),
    "",
    `REVISION (pass ${opts.passNumber}): your previous cut list failed validation.`,
    "",
    `Your previous response:`,
    opts.previousResponseJson,
    "",
    `Problems to fix:`,
    issueLines,
    "",
    `Return a corrected, complete cut list following all the rules above. ` +
      `Fix every listed problem by re-selecting or re-timing cuts on real scene changes — do not simply resubmit the same timestamps.`,
  ].join("\n");
}
