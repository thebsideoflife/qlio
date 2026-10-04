import type {
  CaptionSettings,
  GlobalFramingSettings,
  SegmentFraming,
} from "@/remotion/types";
import { getEffectiveKeyframes } from "@/remotion/types";
import type { Segment } from "@/store/editorSlice";

// Keep in lockstep with backend/src/utils/segmentRenderFingerprint.ts. Bump
// when a Remotion bundle change alters output without changing project inputs.
export const RENDER_PIPELINE_VERSION = 10;

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.keys(val as Record<string, unknown>)
            .sort()
            .map((k) => [k, (val as Record<string, unknown>)[k]]),
        )
      : val,
  );
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
      activeLanguage: captionSettings.activeLanguage || "original",
      ...(captionSettings.enabled && transcriptionVersion
        ? { transcriptionVersion }
        : {}),
      // Word edits (text and deletions) change the burn-in.
      // Sorted so key order never changes the hash.
      ...(captionSettings.enabled
        ? { wordEdits: sortedWordEdits(captionSettings.wordEdits) }
        : {}),
    },
    aspectRatio: globalFraming.aspectRatio,
    framingEnabled: globalFraming.enabled !== false,
    // Coerce to boolean so old projects (squareTop undefined) hash identically
    // to squareTop=false — keeps the frontend and backend fingerprints in lockstep.
    squareTop: !!globalFraming.squareTop,
  };

  // Sort keys: caption styles come back from DynamoDB (and default merges) in
  // arbitrary key order, and order must not make identical renders look stale.
  const str = stableStringify(payload);
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
