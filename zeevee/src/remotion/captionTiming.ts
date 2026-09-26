import type { CaptionLine, CaptionWord } from "./types";

/**
 * Exclusive-end timing rule shared by editor playback and Remotion.
 *
 * `notBefore` is the start of the segment being played: a caption whose words
 * all ended before it is skipped even if its hold (`endTime`) reaches into the
 * segment, so a held caption never carries over a cut.
 */
export function activeCaptionAt(
  captions: CaptionLine[],
  currentTime: number,
  notBefore?: number,
): CaptionLine | undefined {
  return captions.find(
    (caption) =>
      currentTime >= caption.startTime &&
      currentTime < caption.endTime &&
      (notBefore == null || (caption.speechEndTime ?? caption.endTime) > notBefore),
  );
}

/**
 * Index of the word to highlight. After the last word ends it stays
 * highlighted through the caption's hold (until `captionEndTime`).
 */
export function activeWordIndexAt(
  words: Pick<CaptionWord, "start" | "end">[],
  currentTime: number,
  captionEndTime: number,
): number {
  const index = words.findIndex(
    (word) => currentTime >= word.start && currentTime < word.end,
  );
  if (index !== -1) return index;
  const last = words.length - 1;
  if (last >= 0 && currentTime >= words[last].end && currentTime < captionEndTime) {
    return last;
  }
  return -1;
}
