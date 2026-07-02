import type { ProposedSegment, TranscriptSegment } from "../types";
import type { NarrativeBrief, StoryBeat } from "./types";

const MAX_TITLE_WORDS = 10;
const MAX_KEY_DIALOGUE_CHARS = 2500;
const PART_SUFFIX_RE = /\s*\(Part\s+\d+\)\s*$/i;

function truncateWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return words.slice(0, maxWords).join(" ");
}

function stripPartSuffix(title: string): string {
  return title.replace(PART_SUFFIX_RE, "").trim();
}

function firstSentenceInRange(
  transcript: TranscriptSegment[],
  start: number,
  end: number,
): string | null {
  const words: string[] = [];

  for (const seg of transcript) {
    if (seg.startTime >= start && seg.startTime < end) {
      const text = seg.text.trim();
      if (text) {
        words.push(text);
        if (text.match(/[.?!]$/)) break;
        if (words.length >= MAX_TITLE_WORDS) break;
      }
    }
  }

  if (words.length === 0) return null;
  return truncateWords(words.join(" "), MAX_TITLE_WORDS);
}

function transcriptSnippet(
  transcript: TranscriptSegment[],
  start: number,
  end: number,
): string {
  return transcript
    .filter((t) => t.endTime > start && t.startTime < end)
    .map((t) => t.text.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, MAX_KEY_DIALOGUE_CHARS);
}

function allBeats(brief: NarrativeBrief): StoryBeat[] {
  const recap = brief.recapBeats ?? [];
  const arcBeats = brief.arcs.flatMap((a) => a.beats);
  return recap.length > 0 ? recap : arcBeats;
}

function findBeatForSegment(
  midpoint: number,
  beats: StoryBeat[],
): StoryBeat | null {
  if (beats.length === 0) return null;

  for (const beat of beats) {
    if (
      midpoint >= beat.approximateStartSec &&
      midpoint <= beat.approximateEndSec
    ) {
      return beat;
    }
  }

  let best: StoryBeat | null = null;
  let bestDist = Infinity;
  for (const beat of beats) {
    const beatMid =
      (beat.approximateStartSec + beat.approximateEndSec) / 2;
    const dist = Math.abs(midpoint - beatMid);
    if (dist < bestDist) {
      bestDist = dist;
      best = beat;
    }
  }

  // Only map to nearest beat when reasonably close (10 min)
  return best && bestDist <= 600 ? best : null;
}

function beatReasoning(beat: StoryBeat): string {
  const theme = beat.producerTheme?.trim();
  const note = theme ? `: ${theme}` : `: ${beat.label}`;
  return `Narrative beat (${beat.narrativeRole})${note}`;
}

function dedupeTitle(title: string, used: Map<string, number>): string {
  const base = title.trim();
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  if (count === 0) return base;
  return `${base} (${count + 1})`;
}

/**
 * Refresh segment titles/metadata from NarrativeBrief beats + transcript.
 * No mechanical (Part N) suffixes — beat labels or transcript-derived titles only.
 */
export function applyNarrativeTitles(
  segments: ProposedSegment[],
  brief: NarrativeBrief,
  transcript: TranscriptSegment[],
): ProposedSegment[] {
  const beats = allBeats(brief);
  const usedTitles = new Map<string, number>();

  return segments.map((seg) => {
    const midpoint = (seg.startTime + seg.endTime) / 2;
    const beat = findBeatForSegment(midpoint, beats);

    let title: string;
    if (beat) {
      title = truncateWords(beat.label, MAX_TITLE_WORDS);
    } else {
      title =
        firstSentenceInRange(transcript, seg.startTime, seg.endTime) ??
        truncateWords(stripPartSuffix(seg.title), MAX_TITLE_WORDS);
    }

    title = dedupeTitle(title, usedTitles);

    const reasoning = beat
      ? beatReasoning(beat)
      : seg.reasoning || "Selected for compact narrative flow";

    return {
      ...seg,
      title,
      reasoning,
      expectedContent: transcriptSnippet(
        transcript,
        seg.startTime,
        seg.endTime,
      ),
      section: beat ? `role-${beat.narrativeRole}` : seg.section,
    };
  });
}
