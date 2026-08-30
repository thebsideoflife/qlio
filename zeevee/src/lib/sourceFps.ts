import { ALL_FORMATS, Input, UrlSource } from "mediabunny";

/**
 * NTSC/PAL clocks. Snap noisy probes so preview (Mediabunny packet rate)
 * and export (ffprobe) share the same frame grid.
 *
 * Threshold is half the 23.976↔24 gap, so 23.97 snaps but 24 does not.
 */
const CANONICAL_FPS = [
  24000 / 1001,
  24,
  25,
  30000 / 1001,
  30,
  50,
  60000 / 1001,
  60,
  120000 / 1001,
  120,
] as const;

const CANONICAL_FPS_MAX_DELTA = 0.012;

export function canonicalizeFps(fps: number): number {
  let best = fps;
  let bestDelta = CANONICAL_FPS_MAX_DELTA;
  for (const candidate of CANONICAL_FPS) {
    const delta = Math.abs(fps - candidate);
    if (delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }
  return best;
}

/**
 * Source frame rate via Mediabunny (Remotion's recommended metadata path).
 * `averagePacketRate` on a video track is the frame rate.
 */
export async function probeSourceFps(src: string): Promise<number | null> {
  if (!src) return null;
  let input: Input | undefined;
  try {
    input = new Input({
      formats: ALL_FORMATS,
      source: new UrlSource(src),
    });
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const stats = await track.computePacketStats(120);
    if (stats.packetCount < 2 || !(stats.averagePacketRate > 0)) return null;
    return canonicalizeFps(stats.averagePacketRate);
  } catch {
    return null;
  } finally {
    input?.dispose();
  }
}
