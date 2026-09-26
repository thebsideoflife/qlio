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

/**
 * A launched scene that hasn't finished by now is treated as stuck. Remotion's
 * main function is capped at 240s, so a healthy scene always ends (done or
 * fatal) well inside this; the message is transient so the scene is retried.
 */
export const SCENE_RENDER_TIMEOUT_MS = 12 * 60 * 1000;
export const SCENE_RENDER_TIMEOUT_ERROR = "Scene render timed out";

/**
 * Hard ceiling for a whole export. Launch (20 min) plus every scene retry
 * (4 x (12 min + backoff)) stays under ~80 min, so this only catches jobs
 * nothing else could finish. Past it a job never blocks a new export.
 */
export const MAX_RENDER_JOB_MS = 2 * 60 * 60 * 1000;

/** True when a job is past the hard ceiling, or its start time is unreadable. */
export function isRenderJobExpired(
  createdAt: unknown,
  now: number = Date.now(),
): boolean {
  const started = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
  return !Number.isFinite(started) || now - started > MAX_RENDER_JOB_MS;
}

/** True when a launched scene has run past SCENE_RENDER_TIMEOUT_MS. */
export function isSceneRenderStuck(
  launchedAt: string | undefined,
  fallbackStart: string | undefined,
  now: number = Date.now(),
): boolean {
  const started = Date.parse(launchedAt || fallbackStart || "");
  return !Number.isFinite(started) || now - started > SCENE_RENDER_TIMEOUT_MS;
}

/** AWS capacity, throttling and 5xx errors that succeed on a later attempt. */
export function isTransientRenderError(message: string | undefined): boolean {
  if (!message) return false;
  return /sufficient capacity|reduce your request rate|reducing your request rate|Rate Exceeded|TooManyRequests|Throttl|SlowDown|internal error|InternalError|ServiceUnavailable|ServiceException|socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|timed out|timeout/i.test(
    message,
  );
}
