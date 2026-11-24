/**
 * What the editor sees of a scene's thumbnail pick: flags, the chosen and
 * runner-up frames, and why. The full candidate list stays server-side.
 */
import type { StoredThumbnailPick } from "../services/thumbnails/pick";

export interface ThumbnailReview {
  flags: string[];
  chosenTime: number | null;
  subject: string | null;
  emotion: string | null;
  rationale: string;
  spoilerSensitivity: string;
  runnerUp: { index: number; time: number; url: string | null } | null;
}

export async function toThumbnailReview(
  pick: StoredThumbnailPick | undefined,
  sign: (key: string | undefined) => Promise<string | null>,
): Promise<ThumbnailReview | undefined> {
  if (!pick) return undefined;
  const chosen = pick.chosen >= 0 ? pick.candidates[pick.chosen] : undefined;
  const runner = pick.runnerUp >= 0 ? pick.candidates[pick.runnerUp] : undefined;
  return {
    flags: pick.flags,
    chosenTime: chosen?.time ?? null,
    subject: chosen?.attrs.subject ?? null,
    emotion: chosen?.attrs.emotion ?? null,
    rationale: pick.rationale,
    spoilerSensitivity: pick.brief.spoiler_sensitivity,
    runnerUp: runner
      ? { index: pick.runnerUp, time: runner.time, url: await sign(runner.previewKey) }
      : null,
  };
}
