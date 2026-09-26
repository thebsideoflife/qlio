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
 *
 * The same applies to Whisper's stock phrases over music or silence ("Thank you.",
 * "I'm sorry.", "Thanks for watching!", "© BF-WATCH TV 2021"): a segment that is only
 * such a phrase is held out when Whisper itself doubts there is speech
 * (no_speech_prob >= STOCK_PHRASE_MIN_NO_SPEECH) AND it sits alone, at least
 * STOCK_PHRASE_MIN_ISOLATION_SEC from any other speech. Measured on Miami Vice,
 * Babysitter's Seduction and Operation Repo: every hallucinated one met both
 * (no_speech_prob 0.74-0.98, 6-45 s alone); every real line said in dialogue had
 * no_speech_prob <= 0.55 and was within 2 s of other speech.
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

export const STOCK_PHRASE_MIN_NO_SPEECH = 0.6;
export const STOCK_PHRASE_MIN_ISOLATION_SEC = 5;

const STOCK_PHRASE =
  /^(?:(?:thank you|thanks|i'm sorry|bye|okay|you)[.!,]?\s*)+$|thanks? (?:you )?for watching|subtitles? by|©|watch ?tv|please subscribe/i;

export function isStockPhraseHallucination(
  seg: { text?: string; no_speech_prob?: number },
  secondsFromOtherSpeech: number,
): boolean {
  const text = String(seg.text ?? "").trim();
  if (!text || !STOCK_PHRASE.test(text)) return false;
  return (
    Number(seg.no_speech_prob) >= STOCK_PHRASE_MIN_NO_SPEECH &&
    secondsFromOtherSpeech >= STOCK_PHRASE_MIN_ISOLATION_SEC
  );
}

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
  const segments = result.segments ?? [];
  // Speech neighbours for the isolation test: segments SporeLabs did not flag.
  const spoken = segments
    .filter((seg) => !seg.hallucination_flag && (seg.words ?? []).length > 0)
    .sort((a, b) => Number(a.start) - Number(b.start));
  const secondsFromOtherSpeech = (seg: (typeof segments)[number]): number => {
    const i = spoken.indexOf(seg);
    const prevEnd = i > 0 ? Number(spoken[i - 1].end) : Number.NEGATIVE_INFINITY;
    const nextStart =
      i >= 0 && i + 1 < spoken.length ? Number(spoken[i + 1].start) : Number.POSITIVE_INFINITY;
    return Math.min(Number(seg.start) - prevEnd, nextStart - Number(seg.end));
  };
  for (const seg of segments) {
    const mapped = (seg.words ?? [])
      .map((w) => toCaptionWord(w, offset))
      .filter((w): w is CaptionWord => w !== null);
    let note = seg.hallucination_flag;
    if (!note) {
      const alone = secondsFromOtherSpeech(seg);
      if (isStockPhraseHallucination(seg, alone)) {
        note =
          `stock phrase over music/silence at ${round3(Number(seg.start) + offset)}s: ` +
          `"${String(seg.text).trim()}" (no_speech_prob ${Number(seg.no_speech_prob).toFixed(2)}, ` +
          `${Number.isFinite(alone) ? alone.toFixed(1) : "∞"} s from other speech)`;
      }
    }
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
