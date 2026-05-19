/** Mirrors zeevee/src/lib/segmentRenderFingerprint.ts for render staleness checks. */

interface FramingKeyframe {
  time: number;
  focusX: number;
  focusY: number;
  zoom: number;
}

export interface SegmentFraming {
  aspectRatio: string;
  mode?: string;
  focusX?: number;
  focusY?: number;
  keyframes?: FramingKeyframe[];
}

function getEffectiveKeyframes(framing: SegmentFraming): FramingKeyframe[] {
  if (framing.keyframes?.length) return framing.keyframes;
  return [
    {
      time: 0,
      focusX: framing.focusX ?? 0.5,
      focusY: framing.focusY ?? 0.5,
      zoom: framing.mode === "crop" ? 1.0 : 0.0,
    },
  ];
}

function normalizeFraming(framing: SegmentFraming | undefined) {
  if (!framing) return null;
  const keyframes = getEffectiveKeyframes(framing)
    .map((kf) => ({
      time: kf.time,
      focusX: kf.focusX,
      focusY: kf.focusY,
      zoom: kf.zoom,
    }))
    .sort((a, b) => a.time - b.time);
  return { aspectRatio: framing.aspectRatio, keyframes };
}

export function computeSegmentRenderFingerprint(
  segment: {
    startTime: number;
    endTime: number;
    framing?: SegmentFraming;
  },
  captionSettings: { enabled: boolean; style: unknown },
  globalFraming: { aspectRatio: string },
): string {
  const payload = {
    startTime: segment.startTime,
    endTime: segment.endTime,
    framing: normalizeFraming(segment.framing),
    captions: {
      enabled: captionSettings.enabled,
      style: captionSettings.style,
    },
    aspectRatio: globalFraming.aspectRatio,
  };

  const str = JSON.stringify(payload);
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}
