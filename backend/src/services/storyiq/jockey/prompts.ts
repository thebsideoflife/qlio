/**
 * Jockey prompt templates — Claude Sonnet preprocess + Pegasus enrichment.
 *
 * Prompts are first-class code artifacts (12-factor agents). The preprocess
 * model may use prior knowledge of well-known titles for context, but the
 * transcript is the source of truth: every timestamp must come from ASR
 * segment boundaries, and prior knowledge that conflicts with the transcript
 * must be discarded.
 */

import { Purpose } from "../types";
import type { NarrativeBrief } from "./types";

const GROUNDING_RULES = `GROUNDING RULES (non-negotiable):
- Every beat timestamp MUST align to a transcript line timestamp — never invent or interpolate times.
- If you recognize this title, you may use what you know about it (characters, famous scenes, cultural context) to pick BETTER beats and write sharper labels.
- But the transcript is the source of truth. If your prior knowledge does not match what the transcript actually shows, trust the transcript and drop the assumption. Never describe a scene that is not evidenced in the transcript.
- Prefer dialog-forward beats where people actually speak. Skip filler, travelogue, and transitions.`;

const COMPACT_SYSTEM = `You are a narrative analyst preparing a long-form video for compaction to roughly half its runtime.
Extract the story structure that a sharp editor would protect: the main spine plus the one or two secondary threads that pay off.
Cover the ENTIRE runtime — beats must span from the opening act to the ending. A compact cut that ignores the first half of the video is a failure.
Content must be tight: every beat should earn its place; mark the strongest, most dialog-forward moments.
When the producer names themes, scenes, or characters, reflect them in arc names and beat labels.
Beat labels must be ≤10 words, punchy headlines (WHO does WHAT), usable directly as segment titles.

${GROUNDING_RULES}`;

const RECAP_SYSTEM = `You are a TV editor crafting a "Previously on…" episode recap.
Extract exactly 4–6 connected narrative beats from the transcript.
Beats must flow as a mini-story: setup → escalation → pivot/payoff — not a random highlight reel. Each beat should set up or pay off another.
Each beat should be coverable in a 10–20 second clip: pick the sharpest moment inside a scene, not the whole scene.
Beat labels must be ≤10 words, punchy headlines (WHO does WHAT), usable directly as segment titles.

${GROUNDING_RULES}`;

export function claudePreprocessSystemPrompt(
  purpose: "compact_video" | "episode_recap",
): string {
  return purpose === "episode_recap" ? RECAP_SYSTEM : COMPACT_SYSTEM;
}

const STORY_BEAT_SHAPE = `{
  "id": "beat-1",
  "label": "≤10 words, WHO does WHAT",
  "approximateStartSec": number,
  "approximateEndSec": number,
  "narrativeRole": "setup"|"escalation"|"pivot"|"payoff"|"main_story"|"secondary_story",
  "characters": ["name"],
  "dialogForward": boolean,
  "producerTheme": "optional theme from producer prompt"
}`;

export function claudePreprocessUserPrompt(opts: {
  purpose: "compact_video" | "episode_recap";
  title: string;
  durationSec: number;
  targetRuntimeSec: number;
  userInstructions?: string;
  transcriptText: string;
}): string {
  const {
    purpose,
    title,
    durationSec,
    targetRuntimeSec,
    userInstructions,
    transcriptText,
  } = opts;

  const runtimeGuidance =
    purpose === "episode_recap"
      ? `Target: 4–6 beats totaling ~60–90 seconds (default ~${Math.round(targetRuntimeSec)}s).`
      : `Target compact runtime: ~${Math.round(targetRuntimeSec)}s from ${Math.round(durationSec)}s source. Beats must span the full ${Math.round(durationSec)}s timeline, including the first quarter.`;

  const producerBlock = userInstructions?.trim()
    ? `\nProducer instructions (honor named themes/scenes):\n${userInstructions.trim()}\n`
    : "";

  const outputShape =
    purpose === "episode_recap"
      ? `{
  "logline": "one sentence series/episode premise",
  "arcs": [{ "name": "arc name", "beats": [StoryBeat, ...] }],
  "recapBeats": [StoryBeat, ...],
  "producerNotes": "how producer themes were applied",
  "targetRuntimeSec": number
}

recapBeats: exactly 4–6 ordered beats for the recap, in story order. Each StoryBeat:
${STORY_BEAT_SHAPE}`
      : `{
  "logline": "one sentence premise",
  "arcs": [{ "name": "named narrative arc", "beats": [StoryBeat, ...] }],
  "producerNotes": "how producer themes were applied",
  "targetRuntimeSec": number
}

Name narrative arcs when the producer prompt names themes/scenes; otherwise name them after the actual story threads.
Each StoryBeat:
${STORY_BEAT_SHAPE}`;

  return `Video: "${title}"
Duration: ${Math.round(durationSec)}s
${runtimeGuidance}
${producerBlock}
If you recognize this title, briefly consider what it is known for before selecting beats — then verify each beat against the transcript below.

Transcript (timestamps in [M:SS] format — use ONLY these for beat times):
---
${transcriptText}
---

Respond with valid JSON only (no markdown fences):
${outputShape}`;
}

/**
 * Pegasus guidance for analyzing a virtual window of a longer video.
 * Pegasus only sees [windowLocalStartSec, windowLocalEndSec] of the physical
 * asset; make sure it treats the excerpt as mid-story context.
 */
export function windowAnalysisSuffix(opts: {
  windowLocalStartSec: number;
  windowLocalEndSec: number;
  globalStartSec: number;
  globalEndSec: number;
  /** Prompt-level segment length guidance — the API rejects min/max_segment_duration with time_ranges. */
  minSegmentSec?: number;
  maxSegmentSec?: number;
}): string {
  const {
    windowLocalStartSec,
    windowLocalEndSec,
    globalStartSec,
    globalEndSec,
    minSegmentSec,
    maxSegmentSec,
  } = opts;
  const durationHint =
    minSegmentSec !== undefined && maxSegmentSec !== undefined
      ? ` Each segment must run ${Math.round(minSegmentSec)}–${Math.round(maxSegmentSec)} seconds — split longer scenes at natural breaks and skip moments too thin to fill ${Math.round(minSegmentSec)}s.`
      : "";
  return (
    ` You are analyzing ONLY the ${Math.round(windowLocalStartSec)}–${Math.round(windowLocalEndSec)}s window of this video` +
    ` (${Math.round(globalStartSec)}–${Math.round(globalEndSec)}s of the full story).` +
    ` This excerpt is mid-story context — judge segments on their own merits within this window;` +
    ` do not treat the window edges as the story's beginning or end.` +
    ` Still be selective: keep only substantive beats that advance the story.` +
    durationHint
  );
}

/** Append narrative brief context to Pegasus segment definition descriptions. */
export function enrichSegmentDefinitionsWithBrief<
  T extends { description: string },
>(
  definitions: T[],
  brief: NarrativeBrief,
  purpose: Purpose.COMPACT_VIDEO | Purpose.EPISODE_RECAP,
  windowArcNames: string[],
  windowSuffix?: string,
): T[] {
  const arcSummary = brief.arcs
    .filter((a) => windowArcNames.length === 0 || windowArcNames.includes(a.name))
    .map((arc) => {
      const beatLines = arc.beats
        .slice(0, 12)
        .map(
          (b) =>
            `  - [${Math.round(b.approximateStartSec)}–${Math.round(b.approximateEndSec)}s] ${b.label} (${b.narrativeRole})`,
        )
        .join("\n");
      return `Arc "${arc.name}":\n${beatLines}`;
    })
    .join("\n");

  const recapBlock =
    purpose === Purpose.EPISODE_RECAP && brief.recapBeats?.length
      ? `\nRecap beat candidates (keep 4–6 connected):\n${brief.recapBeats
          .map(
            (b, i) =>
              `  ${i + 1}. [${Math.round(b.approximateStartSec)}–${Math.round(b.approximateEndSec)}s] ${b.label}`,
          )
          .join("\n")}`
      : "";

  const suffix = [
    `\nNarrative brief logline: ${brief.logline}`,
    arcSummary ? `\nStory beats in/near this window:\n${arcSummary}` : "",
    recapBlock,
    brief.producerNotes ? `\nEditor notes: ${brief.producerNotes}` : "",
    windowSuffix ?? "",
    " Select segments that align with these beats. Prefer dialog-forward moments at natural scene boundaries.",
  ]
    .filter(Boolean)
    .join("");

  return definitions.map((def) => ({
    ...def,
    description: def.description + suffix,
  }));
}
