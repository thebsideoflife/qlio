import type { CaptionLine } from "./types";

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
