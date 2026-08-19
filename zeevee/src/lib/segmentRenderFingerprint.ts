import type {
  CaptionSettings,
  GlobalFramingSettings,
  SegmentFraming,
} from "@/remotion/types";
import { getEffectiveKeyframes } from "@/remotion/types";
import type { Segment } from "@/store/editorSlice";

// Keep in lockstep with backend/src/utils/segmentRenderFingerprint.ts. Bump
// when a Remotion bundle change alters output without changing project inputs.
export const RENDER_PIPELINE_VERSION = 2;

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

/** Stable hash of render-relevant segment + project settings. */
export function computeSegmentRenderFingerprint(
  segment: Pick<Segment, "startTime" | "endTime" | "framing">,
  captionSettings: CaptionSettings,
  globalFraming: GlobalFramingSettings,
  transcriptionVersion?: string | null,
): string {
  const payload = {
    renderPipelineVersion: RENDER_PIPELINE_VERSION,
    startTime: segment.startTime,
    endTime: segment.endTime,
    framing: normalizeFraming(segment.framing),
    captions: {
      enabled: captionSettings.enabled,
      style: captionSettings.style,
      ...(captionSettings.activeLanguage &&
      captionSettings.activeLanguage !== "original"
        ? { activeLanguage: captionSettings.activeLanguage }
        : {}),
      ...(captionSettings.enabled && transcriptionVersion
        ? { transcriptionVersion }
        : {}),
    },
    aspectRatio: globalFraming.aspectRatio,
    // Coerce to boolean so old projects (squareTop undefined) hash identically
    // to squareTop=false — keeps the frontend and backend fingerprints in lockstep.
    squareTop: !!globalFraming.squareTop,
  };

  const str = JSON.stringify(payload);
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}

export interface SegmentRenderCache {
  segmentId: string;
  title: string;
  url: string;
  contentHash?: string;
}

export function isSegmentRenderStale(
  cached: SegmentRenderCache | undefined,
  currentHash: string,
): boolean {
  if (!cached?.url) return false;
  if (!cached.contentHash) return true; // Unknown state = treat as stale
  return cached.contentHash !== currentHash;
}
