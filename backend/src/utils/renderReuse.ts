/**
 * Decisions shared by renderVideo (what to render) and getRenderStatus (what
 * to keep, what to retry). Pure so they can be tested without AWS.
 */

export interface StoredRender {
  segmentId: string;
  bucket?: string;
  key?: string;
  renderedAt?: string;
  contentHash?: string;
}

/**
 * Split requested segments into ones whose stored render already matches the
 * current inputs (reuse it) and ones that must be rendered.
 */
export function planSegmentReuse<T extends { id: string }>(
  segments: T[],
  storedRenders: StoredRender[] | undefined,
  fingerprint: (segment: T) => string,
): { reuse: Array<{ segment: T; stored: StoredRender }>; render: T[] } {
  const stored = new Map(
    (storedRenders || []).map((render) => [render.segmentId, render]),
  );
  const reuse: Array<{ segment: T; stored: StoredRender }> = [];
  const render: T[] = [];
  for (const segment of segments) {
    const existing = stored.get(segment.id);
    if (
      existing?.bucket &&
      existing.key &&
      existing.contentHash &&
      existing.contentHash === fingerprint(segment)
    ) {
      reuse.push({ segment, stored: existing });
    } else {
      render.push(segment);
    }
  }
  return { reuse, render };
}

/**
 * A job's output may replace a stored render unless the stored one is newer
 * than the job (a later render finished first, or an old job is re-polled).
 */
export function shouldReplaceStoredRender(
  existing: StoredRender | undefined,
  jobCreatedAt: string | undefined,
): boolean {
  if (!existing?.renderedAt || !jobCreatedAt) return true;
  return existing.renderedAt <= jobCreatedAt;
}

export const MAX_SEGMENT_RENDER_ATTEMPTS = 4;

/** AWS capacity, throttling and 5xx errors that succeed on a later attempt. */
export function isTransientRenderError(message: string | undefined): boolean {
  if (!message) return false;
  return /sufficient capacity|reduce your request rate|reducing your request rate|Rate Exceeded|TooManyRequests|Throttl|SlowDown|internal error|InternalError|ServiceUnavailable|ServiceException|socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|timed out|timeout/i.test(
    message,
  );
}
