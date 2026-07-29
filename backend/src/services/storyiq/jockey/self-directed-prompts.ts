/**
 * Jockey v3 prompt templates — self-directed cutting.
 *
 * Prompts are first-class code artifacts (12-factor agents). Per
 * SPEC-jockey-v3-self-directed-cuts.md, the only guidance Jockey receives is
 * the producer's intent plus format and target runtime — no preprocessing
 * brief, no external scene data. Jockey plans from its cultural knowledge of
 * the title, verifies against the actual content, and returns the final cuts.
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
  "You are a professional story editor cutting a microseries from a full episode. " +
  "You have full access to this video through your knowledge store. " +
  "You know television, film, and pop culture deeply — use that knowledge to plan, " +
  "but the indexed video content is your only source of truth for what actually happens " +
  "and for every timestamp. " +
  "Every cut must open and close on a natural scene boundary you identified in the content — " +
  "never mid-scene, mid-gesture, or mid-word. " +
  "Your cuts are used as-is with no downstream editing, so the timestamps you return are the timestamps that ship.";

export interface SelfDirectedPromptOptions {
  purpose: JockeyV3PurposeKey;
  title: string;
  durationSec: number;
  targetSeconds: number;
  userInstructions?: string;
  /** Producer-requested per-segment bounds (compact only). */
  minSegmentDurationSec?: number;
  maxSegmentDurationSec?: number;
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
  const segMin = Math.round(opts.minSegmentDurationSec ?? 60);
  const segMax = Math.round(opts.maxSegmentDurationSec ?? 120);
  return [
    `FORMAT: Compact microseries — the episode distilled to its core moments.`,
    `- Source runs ${Math.round(durationSec)}s. Keep material totaling ${lower}–${upper}s (target ~${Math.round(targetSeconds)}s — about half the episode).`,
    `- Each segment becomes its own standalone video in the microseries: it must be watchable in isolation and carry a complete moment or mini-arc.`,
    `- Each segment must run ${segMin}–${segMax} seconds — a hard bound from the producer, not a suggestion.`,
    `- Prioritize scenes driven by the primary characters. Cut B-roll, establishing filler, and side threads that don't advance the core story.`,
    `- Spread selections roughly uniformly across the ENTIRE timeline — opening act through ending — so together they tell the full story.`,
    ``,
    `EDGE DISCIPLINE (most important):`,
    `- Choose SPECIFIC starts and ends. Open at the exact moment the rich content begins — the first line, action, or reveal that earns the segment — not at the top of the general zone it lives in.`,
    `- Close the moment the beat lands. Never hold a segment open to coast toward the max length or the runtime target; a tight ${segMin}s beat always beats a padded ${segMax}s zone.`,
    `- Never round timestamps to whole minutes or tidy numbers. Times like 660.0 or 1020.0 are a tell that you estimated instead of verified — every edge must come from watching the content and land within a second or two of the real moment.`,
    `- If a scene is rich for only part of its span, cut only the rich part. Do not include dead air, walk-and-talk filler, or establishing tails at either end of a segment.`,
  ].join("\n");
}

export function buildSelfDirectedPrompt(
  opts: SelfDirectedPromptOptions,
): string {
  const producerBlock = opts.userInstructions?.trim()
    ? `PRODUCER INTENT (honor named themes, scenes, and characters):\n${opts.userInstructions.trim()}`
    : "PRODUCER INTENT: none given — favor dialog-forward scenes with the primary characters that advance the story.";

  const goal =
    opts.purpose === "episode_recap"
      ? "plan the recap"
      : "plan the compaction";

  return [
    `Cut "${opts.title}" (${Math.round(opts.durationSec)}s source).`,
    "",
    producerBlock,
    "",
    formatBlock(opts),
    "",
    `WORKFLOW:`,
    `1. PLAN FROM CONTEXT: Start from what you know about this title and the culture around it — ` +
      `its genre, its primary characters, its reputation, and what audiences remember or expect from it. ` +
      `Use that to ${goal}: which arcs, relationships, and moments must survive for the story to still land. ` +
      `Adapt your editorial approach to the genre — a procedural, a documentary, a comedy, and a prestige drama each compress differently.`,
    `2. VERIFY AGAINST THE CONTENT: The video in front of you is the source of truth. ` +
      `Explore it fully, confirm what actually happens, and identify its scene changes — the moments where one scene ends and the next begins. ` +
      `Every timestamp you return must come from this exploration, never from memory or assumption.`,
    `3. CUT: Select the moments that realize your plan and return the final cuts. ` +
      `Every startTime and endTime must sit on a scene change you identified in the content (within ${SCENE_EDGE_TOLERANCE_SEC}s).`,
    "",
    `OUTPUT RULES:`,
    `- All timestamps are seconds on the source video timeline.`,
    `- segments: chronological, non-overlapping final cuts.`,
    `- sceneBoundaries: every scene-change timestamp you identified while exploring (including all cut edges).`,
    `- title: human-readable headline per segment, ≤10 words, WHO does WHAT. No "(Part N)" or numbering suffixes.`,
    `- description: one sentence on why the moment earns its place in the story.`,
    `- edgeReason: one short clause per segment naming the specific moment each edge cuts on (e.g. "opens on the first absinthe pour, closes on his verdict"). This is how you prove the edges are deliberate, not rounded.`,
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
