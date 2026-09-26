/**
 * Carry a project's caption word edits over to a new transcript version.
 *
 * Word edits are keyed by the edited word's timestamps (`"${start}-${end}"`, see
 * editorSlice.updateCaptionWord), so re-transcribing an asset orphans every edit:
 * the new words have new timings. This maps each edited word in the previous
 * transcript to the matching word in the new one:
 *
 *   1. Same spoken word (case and punctuation ignored) starting within
 *      MATCH_WINDOW_SECONDS; the nearest start wins.
 *   2. Otherwise, for a text change (not a deletion), the new word that overlaps
 *      the old word's time span the most. A deletion is only carried over to the
 *      same spoken word, so it can never delete a different word.
 *
 * Two edits never land on the same new word (the closer match keeps it). Edits
 * that cannot be placed are returned in `dropped` so the caller can keep them
 * for a person to review.
 */

export interface MigratableWord {
  start: number;
  end: number;
  value: string;
}

export interface DroppedWordEdit {
  key: string;
  value: string;
  previousText: string | null;
  reason: "not-in-previous-transcript" | "no-matching-word" | "taken-by-closer-edit";
}

export interface WordEditMigration {
  wordEdits: Record<string, string>;
  migrated: number;
  dropped: DroppedWordEdit[];
}

export const MATCH_WINDOW_SECONDS = 1.0;

export function wordEditKey(word: { start: number; end: number }): string {
  return `${word.start}-${word.end}`;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}']+/gu, "")
    .replace(/^'+|'+$/g, "");
}

function overlap(a: MigratableWord, b: MigratableWord): number {
  return Math.min(a.end, b.end) - Math.max(a.start, b.start);
}

export function migrateWordEdits(
  previousWords: readonly MigratableWord[],
  newWords: readonly MigratableWord[],
  wordEdits: Record<string, string>,
): WordEditMigration {
  const previousByKey = new Map<string, MigratableWord>();
  for (const word of previousWords) {
    if (!previousByKey.has(wordEditKey(word))) previousByKey.set(wordEditKey(word), word);
  }
  const sorted = [...newWords].sort((a, b) => a.start - b.start);

  const dropped: DroppedWordEdit[] = [];
  const placed = new Map<string, { key: string; value: string; distance: number }>();

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

  const place = (key: string, value: string, target: MigratableWord, distance: number, previousText: string) => {
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
    const isDeletion = value.trim() === "";
    const overlapping = isDeletion
      ? undefined
      : nearby
          .filter((w) => overlap(w, previous) > 0)
          .sort((a, b) => overlap(b, previous) - overlap(a, previous))[0];
    if (overlapping) {
      place(key, value, overlapping, 0.5 + Math.abs(overlapping.start - previous.start), previous.value);
      continue;
    }
    dropped.push({ key, value, previousText: previous.value, reason: "no-matching-word" });
  }

  const migrated: Record<string, string> = {};
  for (const [targetKey, { value }] of placed) migrated[targetKey] = value;
  return { wordEdits: migrated, migrated: placed.size, dropped };
}
