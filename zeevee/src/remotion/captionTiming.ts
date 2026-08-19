import type { CaptionLine } from "./types";

/** Exclusive-end timing rule shared by editor playback and Remotion. */
export function activeCaptionAt(
  captions: CaptionLine[],
  currentTime: number,
): CaptionLine | undefined {
  return captions.find(
    (caption) =>
      currentTime >= caption.startTime && currentTime < caption.endTime,
  );
}
