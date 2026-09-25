/** Mirrors zeevee/src/lib/segmentRenderFingerprint.ts for render staleness checks. */

// Bump whenever the Remotion bundle changes rendered pixels without changing
// project inputs. This invalidates MP4s made by an older renderer.
export const RENDER_PIPELINE_VERSION = 8;

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

function sortedWordEdits(
  wordEdits: Record<string, string> | null | undefined,
): Array<[string, string]> {
  if (!wordEdits) return [];
  return Object.keys(wordEdits)
    .sort()
    .map((key) => [key, wordEdits[key]] as [string, string]);
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
  captionSettings: {
    enabled: boolean;
    style: unknown;
    activeLanguage?: string;
    wordEdits?: Record<string, string> | null;
  },
  globalFraming: { aspectRatio: string; enabled?: boolean; squareTop?: boolean },
  transcriptionVersion?: string | null,
  renderPipelineVersion = RENDER_PIPELINE_VERSION,
): string {
  const payload = {
    renderPipelineVersion,
    startTime: segment.startTime,
    endTime: segment.endTime,
    framing: normalizeFraming(segment.framing),
    captions: {
      enabled: captionSettings.enabled,
      style: captionSettings.style,
      activeLanguage: captionSettings.activeLanguage || "original",
      ...(captionSettings.enabled && transcriptionVersion
        ? { transcriptionVersion }
        : {}),
      // Word edits (text, deletions, manual line breaks) change the burn-in.
      // Sorted so key order never changes the hash.
      ...(captionSettings.enabled
        ? { wordEdits: sortedWordEdits(captionSettings.wordEdits) }
        : {}),
    },
    aspectRatio: globalFraming.aspectRatio,
    framingEnabled: globalFraming.enabled !== false,
    // Coerce to boolean so old projects (squareTop undefined) hash identically
    // to squareTop=false — keeps this mirror in lockstep with the frontend copy.
    squareTop: !!globalFraming.squareTop,
  };

  const str = JSON.stringify(payload);
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}
