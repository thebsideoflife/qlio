/**
 * Carry a project's caption word edits over to a new transcript version.
 *
 * Word edits are keyed by the edited word's timestamps (`"${start}-${end}"`, see
 * editorSlice.updateCaptionWord), so re-transcribing an asset orphans every edit:
 * the new words have new timings. This maps each edited word in the previous
 * transcript to the matching word in the new one:
 *
 *   the same spoken word (case and punctuation ignored) starting within
 *   MATCH_WINDOW_SECONDS; the nearest start wins.
 *
 * Only the same word is ever edited. An edit on a word the new transcript hears
 * differently is not moved: it was usually correcting a mishearing the new
 * transcript no longer has (Murdoch: "Mayor" -> "Mere", and the new transcript
 * already says "Mere"), and placing it by time overlap put it on the wrong word.
 *
 * Two edits never land on the same new word (the closer match keeps it). Edits
 * that cannot be placed are returned in `dropped` so the caller can keep them
 * for a person to review.
 */

import { wordEditKey, type WordEdit } from "./caption-grouping";

export interface MigratableWord {
  start: number;
  end: number;
  value: string;
}

export interface DroppedWordEdit {
  key: string;
  value: WordEdit;
  previousText: string | null;
  reason: "not-in-previous-transcript" | "no-matching-word" | "taken-by-closer-edit";
}

export interface WordEditMigration {
  wordEdits: Record<string, WordEdit>;
  migrated: number;
  dropped: DroppedWordEdit[];
}

export const MATCH_WINDOW_SECONDS = 1.0;

export { wordEditKey };

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}']+/gu, "")
    .replace(/^'+|'+$/g, "");
}

export function migrateWordEdits(
  previousWords: readonly MigratableWord[],
  newWords: readonly MigratableWord[],
  wordEdits: Record<string, WordEdit>,
): WordEditMigration {
  const previousByKey = new Map<string, MigratableWord>();
  for (const word of previousWords) {
    if (!previousByKey.has(wordEditKey(word))) previousByKey.set(wordEditKey(word), word);
  }
  const sorted = [...newWords].sort((a, b) => a.start - b.start);

  const dropped: DroppedWordEdit[] = [];
  const placed = new Map<string, { key: string; value: WordEdit; distance: number }>();

  const candidatesNear = (t: number): MigratableWord[] => {
    // Binary search for the first word starting after t - window.
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].start < t - MATCH_WINDOW_SECONDS) lo = mid + 1;
      else hi = mid;
    }
    const out: MigratableWord[] = [];
    for (let i = lo; i < sorted.length && sorted[i].start <= t + MATCH_WINDOW_SECONDS; i++) {
      out.push(sorted[i]);
    }
    return out;
  };

  const place = (key: string, value: WordEdit, target: MigratableWord, distance: number, previousText: string) => {
    const targetKey = wordEditKey(target);
    const existing = placed.get(targetKey);
    if (existing && existing.distance <= distance) {
      dropped.push({ key, value, previousText, reason: "taken-by-closer-edit" });
      return;
    }
    if (existing) {
      dropped.push({
        key: existing.key,
        value: existing.value,
        previousText: previousByKey.get(existing.key)?.value ?? null,
        reason: "taken-by-closer-edit",
      });
    }
    placed.set(targetKey, { key, value, distance });
  };

  for (const [key, value] of Object.entries(wordEdits)) {
    const previous = previousByKey.get(key);
    if (!previous) {
      dropped.push({ key, value, previousText: null, reason: "not-in-previous-transcript" });
      continue;
    }
    const nearby = candidatesNear(previous.start);
    const spoken = normalizeText(previous.value);
    const sameWord = nearby
      .filter((w) => spoken !== "" && normalizeText(w.value) === spoken)
      .sort((a, b) => Math.abs(a.start - previous.start) - Math.abs(b.start - previous.start))[0];
    if (sameWord) {
      place(key, value, sameWord, Math.abs(sameWord.start - previous.start), previous.value);
      continue;
    }
    dropped.push({ key, value, previousText: previous.value, reason: "no-matching-word" });
  }

  const migrated: Record<string, WordEdit> = {};
  for (const [targetKey, { value }] of placed) migrated[targetKey] = value;
  return { wordEdits: migrated, migrated: placed.size, dropped };
}
