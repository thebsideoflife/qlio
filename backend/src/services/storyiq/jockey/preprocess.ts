/**
 * Jockey Phase 0 — Claude Sonnet via SporeLabs turns transcript + producer
 * prompt into a validated NarrativeBrief.
 */

import { ZodError } from "zod";
import type { TranscriptSegment } from "../types";
import { truncateFullTranscript } from "../../../utils/transcript";
import {
  NarrativeBriefSchema,
  type NarrativeBrief,
  type StoryBeat,
} from "./types";
import {
  claudePreprocessSystemPrompt,
  claudePreprocessUserPrompt,
} from "./prompts";
import { invokeClaudeForJson } from "./claude-brief";

const MAX_TRANSCRIPT_CHARS = 160_000;

function snapToTranscriptBoundary(
  time: number,
  transcript: TranscriptSegment[],
  prefer: "start" | "end",
): number {
  if (transcript.length === 0) return time;

  let best = transcript[0].startTime;
  let minDist = Infinity;

  for (const seg of transcript) {
    const candidate = prefer === "start" ? seg.startTime : seg.endTime;
    const dist = Math.abs(candidate - time);
    if (dist < minDist) {
      minDist = dist;
      best = candidate;
    }
  }

  return best;
}

function alignBeatToTranscript(
  beat: StoryBeat,
  transcript: TranscriptSegment[],
  durationSec: number,
): StoryBeat {
  const start = snapToTranscriptBoundary(
    beat.approximateStartSec,
    transcript,
    "start",
  );
  let end = snapToTranscriptBoundary(beat.approximateEndSec, transcript, "end");
  if (end <= start) {
    end = Math.min(durationSec, start + 5);
  }
  return {
    ...beat,
    approximateStartSec: Math.max(0, Math.min(start, durationSec)),
    approximateEndSec: Math.max(start + 1, Math.min(end, durationSec)),
  };
}

/** Beats whose model-claimed times are outside the video are hallucinations — drop them. */
function isBeatPlausible(beat: StoryBeat, durationSec: number): boolean {
  return (
    Number.isFinite(beat.approximateStartSec) &&
    Number.isFinite(beat.approximateEndSec) &&
    beat.approximateStartSec < durationSec &&
    beat.approximateEndSec > 0 &&
    beat.approximateEndSec > beat.approximateStartSec
  );
}

function validateAndAlignBrief(
  parsed: unknown,
  opts: {
    purpose: "compact_video" | "episode_recap";
    transcript: TranscriptSegment[];
    durationSec: number;
    targetRuntimeSec: number;
  },
): NarrativeBrief {
  const { purpose, transcript, durationSec, targetRuntimeSec } = opts;
  const brief = NarrativeBriefSchema.parse(parsed);

  const alignedArcs = brief.arcs
    .map((arc) => ({
      ...arc,
      beats: arc.beats
        .filter((b) => isBeatPlausible(b, durationSec))
        .map((b) => alignBeatToTranscript(b, transcript, durationSec)),
    }))
    .filter((arc) => arc.beats.length > 0);

  let alignedRecap = brief.recapBeats
    ?.filter((b) => isBeatPlausible(b, durationSec))
    .map((b) => alignBeatToTranscript(b, transcript, durationSec));

  if (purpose === "episode_recap") {
    // Recap needs 4–6 ordered beats. Backfill from arc beats if the model
    // under-delivered, keeping story order.
    if (!alignedRecap || alignedRecap.length < 4) {
      const arcBeats = alignedArcs
        .flatMap((a) => a.beats)
        .sort((a, b) => a.approximateStartSec - b.approximateStartSec);
      const seen = new Set(
        (alignedRecap ?? []).map((b) => Math.round(b.approximateStartSec)),
      );
      const backfilled = [...(alignedRecap ?? [])];
      for (const beat of arcBeats) {
        if (backfilled.length >= 4) break;
        const key = Math.round(beat.approximateStartSec);
        if (!seen.has(key)) {
          backfilled.push(beat);
          seen.add(key);
        }
      }
      alignedRecap = backfilled.sort(
        (a, b) => a.approximateStartSec - b.approximateStartSec,
      );
    }
    if (alignedRecap.length > 6) {
      alignedRecap = alignedRecap.slice(0, 6);
    }
    if (alignedRecap.length < 4) {
      throw new Error(
        `[Jockey] Recap brief has only ${alignedRecap.length} usable beats (need 4–6)`,
      );
    }
  }

  if (alignedArcs.length === 0 && (alignedRecap?.length ?? 0) === 0) {
    throw new Error("[Jockey] Brief has no usable beats after transcript alignment");
  }

  return {
    ...brief,
    targetRuntimeSec:
      targetRuntimeSec > 0 ? targetRuntimeSec : brief.targetRuntimeSec,
    arcs: alignedArcs.length > 0 ? alignedArcs : brief.arcs,
    recapBeats: alignedRecap,
  };
}

/**
 * Claude preprocess: transcript + producer prompt → NarrativeBrief.
 * One retry with validation feedback before failing the job.
 */
export async function preprocessNarrativeBrief(opts: {
  transcript: TranscriptSegment[];
  purpose: "compact_video" | "episode_recap";
  title: string;
  durationSec: number;
  targetRuntimeSec: number;
  userInstructions?: string;
}): Promise<NarrativeBrief> {
  const {
    transcript,
    purpose,
    title,
    durationSec,
    targetRuntimeSec,
    userInstructions,
  } = opts;

  const transcriptText = truncateFullTranscript(transcript, MAX_TRANSCRIPT_CHARS);

  console.log(
    `[Jockey] Claude preprocess (${purpose}, ${transcriptText.length} chars transcript)`,
  );

  const systemPrompt = claudePreprocessSystemPrompt(purpose);
  const basePrompt = claudePreprocessUserPrompt({
    purpose,
    title,
    durationSec,
    targetRuntimeSec,
    userInstructions,
    transcriptText,
  });

  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const userPrompt =
      attempt === 1
        ? basePrompt
        : `${basePrompt}\n\nYour previous response was rejected: ${describeError(lastError)}\n` +
          `Fix this and respond with valid JSON matching the required shape exactly.`;

    try {
      const { parsed, source } = await invokeClaudeForJson({
        systemPrompt,
        userPrompt,
      });
      const brief = validateAndAlignBrief(parsed, {
        purpose,
        transcript,
        durationSec,
        targetRuntimeSec,
      });
      const beatCount =
        brief.arcs.reduce((n, a) => n + a.beats.length, 0) +
        (brief.recapBeats?.length ?? 0);
      console.log(
        `[Jockey] Brief via ${source} (attempt ${attempt}): ${brief.arcs.length} arc(s), ${beatCount} beat(s)`,
      );
      return brief;
    } catch (err) {
      lastError = err;
      console.warn(
        `[Jockey] Claude preprocess attempt ${attempt} failed: ${describeError(err)}`,
      );
    }
  }

  throw new Error(
    `[Jockey] Claude preprocess failed after 2 attempts: ${describeError(lastError)}`,
  );
}

function describeError(err: unknown): string {
  if (err instanceof ZodError) {
    return `schema validation failed — ${err.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ")}`;
  }
  return err instanceof Error ? err.message : String(err);
}
