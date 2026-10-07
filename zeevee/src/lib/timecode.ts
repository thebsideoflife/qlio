/**
 * Precise editor times: "m:ss.cc" (hundredths), "h:mm:ss.cc" from an hour.
 * Shared by the playhead readout and the word timing fields so they compare
 * directly.
 */
export function formatTimecode(seconds: number): string {
  const centis = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(centis / 360000);
  const m = Math.floor((centis % 360000) / 6000);
  const s = Math.floor((centis % 6000) / 100);
  const cc = centis % 100;
  const tail = `${s.toString().padStart(2, "0")}.${cc.toString().padStart(2, "0")}`;
  return h > 0 ? `${h}:${m.toString().padStart(2, "0")}:${tail}` : `${m}:${tail}`;
}

/**
 * Read "1:36.55", "1:02:03.5" or plain seconds ("96.55"). Returns null for
 * anything else, including negative or out-of-range fields.
 */
export function parseTimecode(text: string): number | null {
  const parts = text.trim().split(":");
  if (parts.length === 0 || parts.length > 3) return null;
  if (!parts.every((part) => /^\d+(\.\d+)?$/.test(part))) return null;
  const nums = parts.map(Number);
  // Only the last field may have decimals; minutes and seconds must be < 60.
  if (nums.slice(0, -1).some((n) => !Number.isInteger(n))) return null;
  if (nums.length > 1 && nums[nums.length - 1] >= 60) return null;
  if (nums.length === 3 && nums[1] >= 60) return null;
  return nums.reduce((total, n) => total * 60 + n, 0);
}

interface TimelineSegment {
  startTime: number;
  endTime: number;
}

/**
 * Map one source time onto the preview timeline (segments played back to back
 * in start order), relative to the segment containing `anchor`. Returns null
 * when `anchor` is in no segment. Using the anchor's segment for both edges of
 * a word keeps the mapping linear even if an edge sits past the segment end.
 */
export function sourceToPreviewTime(
  segments: readonly TimelineSegment[],
  anchor: number,
  time: number,
): number | null {
  let offset = 0;
  for (const seg of [...segments].sort((a, b) => a.startTime - b.startTime)) {
    if (anchor >= seg.startTime && anchor < seg.endTime) {
      return offset + (time - seg.startTime);
    }
    offset += seg.endTime - seg.startTime;
  }
  return null;
}

/** Inverse of sourceToPreviewTime for the same anchor. */
export function previewToSourceTime(
  segments: readonly TimelineSegment[],
  anchor: number,
  previewTime: number,
): number | null {
  const zero = sourceToPreviewTime(segments, anchor, 0);
  return zero === null ? null : previewTime - zero;
}

/**
 * A time inside the segment that [start, end) overlaps, to anchor
 * sourceToPreviewTime for a word (or a card's first/last word) that a segment
 * edge cuts through. Its start can sit just before the segment, which is in
 * no segment at all. Null when [start, end) overlaps no segment.
 */
export function anchorInSegments(
  segments: readonly TimelineSegment[],
  start: number,
  end: number,
): number | null {
  for (const seg of [...segments].sort((a, b) => a.startTime - b.startTime)) {
    if (end > seg.startTime && start < seg.endTime) return Math.max(start, seg.startTime);
  }
  return null;
}
