import type { FramingKeyframe } from "@/remotion/types";

/**
 * Rebase keyframe times so they stay pinned to the source timeline when a
 * segment's in/out points move.
 *
 * Interior keyframes keep their absolute times. The first setting stretches
 * back to the new start; the last setting holds to the new end. Keyframes
 * that fall completely outside the new range are dropped.
 */
export function reanchorKeyframesToTimeline(
  keyframes: FramingKeyframe[],
  oldStart: number,
  newStart: number,
  newEnd: number,
): FramingKeyframe[] {
  if (keyframes.length === 0) return keyframes;

  const shift = oldStart - newStart;
  const duration = newEnd - newStart;
  const shifted = keyframes.map((kf) => ({
    ...kf,
    time: kf.time + shift,
  }));
  shifted.sort((a, b) => a.time - b.time);

  // Framing that should hold at the new start: last kf at or before 0,
  // or the first kf if the start extended into empty time.
  let coveringIdx = 0;
  for (let i = 0; i < shifted.length; i++) {
    if (shifted[i].time <= 0) coveringIdx = i;
    else break;
  }

  const result: FramingKeyframe[] = [{ ...shifted[coveringIdx], time: 0 }];
  for (let i = coveringIdx + 1; i < shifted.length; i++) {
    if (shifted[i].time >= duration) break;
    if (shifted[i].time > 0) result.push(shifted[i]);
  }
  return result;
}
