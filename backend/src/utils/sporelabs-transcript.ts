/**
 * SporeLabs Whisper result -> ZeeVee original.json words.
 *
 * Whisper timings are seconds into the WAV we sent; sample 0 of that WAV is the first
 * presented audio sample, so every time shifts by the audio stream's start in the video.
 *
 * Words in segments SporeLabs flagged as a hallucination loop (the reference run's
 * "13x repeated 'I'm sorry.'") are kept out of `words`, so captions and StoryIQ never
 * see them, and listed under `hallucinations` with the note, so nothing disappears
 * silently and a producer can restore a false positive.
 */

import type { CaptionWord } from "./transcript-format";
import type {
  TranscribeResult,
  TranscribeWord,
} from "../services/sporelabs-transcribe";

export type FlaggedStretch = {
  start: number;
  end: number;
  note: string;
  words: CaptionWord[];
};

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function toCaptionWord(w: TranscribeWord, offset: number): CaptionWord | null {
  const value = String(w.word ?? "").trim();
  const start = Number(w.start);
  const end = Number(w.end);
  if (!value || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  return {
    start: round3(start + offset),
    end: round3(Math.max(end, start) + offset),
    value,
  };
}

export function wordsFromSporeLabsResult(
  result: TranscribeResult,
  audioStartInVideoSec: number,
): { words: CaptionWord[]; hallucinations: FlaggedStretch[] } {
  const offset = Number.isFinite(audioStartInVideoSec) ? audioStartInVideoSec : 0;
  const words: CaptionWord[] = [];
  const byNote = new Map<string, FlaggedStretch>();
  for (const seg of result.segments ?? []) {
    const mapped = (seg.words ?? [])
      .map((w) => toCaptionWord(w, offset))
      .filter((w): w is CaptionWord => w !== null);
    const note = seg.hallucination_flag;
    if (!note) {
      words.push(...mapped);
      continue;
    }
    const stretch = byNote.get(note) ?? {
      start: round3(Number(seg.start) + offset),
      end: round3(Number(seg.end) + offset),
      note,
      words: [],
    };
    stretch.start = Math.min(stretch.start, round3(Number(seg.start) + offset));
    stretch.end = Math.max(stretch.end, round3(Number(seg.end) + offset));
    stretch.words.push(...mapped);
    byNote.set(note, stretch);
  }
  words.sort((a, b) => a.start - b.start || a.end - b.end);
  return {
    words,
    hallucinations: [...byNote.values()].sort((a, b) => a.start - b.start),
  };
}
