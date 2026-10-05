/**
 * SporeLabs shot-hold reframe client (`POST/GET {base}/video/reframe`).
 *
 * The service owns the clock (camera cuts from pixels) and the crop policy.
 * We hand it a 360p proxy URL plus segment bounds and get back one keyframe
 * per shot, already on the source frame grid.
 *
 * Never log the presigned `video_url` or the API key.
 */

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const secretsClient = new SecretsManagerClient({});

export const SPORELABS_REFRAME_BASE_URL =
  process.env.SPORELABS_BASE_URL?.replace(/\/$/, "") ||
  "https://sporelabs.dev/v1";

/** Per HTTP call. Submit and poll are both small JSON exchanges. */
export const REFRAME_HTTP_TIMEOUT_MS = 30_000;
export const REFRAME_MAX_ATTEMPTS = 4;
export const REFRAME_MAX_SEGMENTS = 500;

// ============================================================================
// TYPES
// ============================================================================

/** Autoframing only outputs 9:16. */
export type ReframeTargetAspect = "9:16";
export const REFRAME_TARGET_ASPECT: ReframeTargetAspect = "9:16";

export interface ReframeSegmentInput {
  id: string;
  start: number;
  end: number;
}

export interface ReframeRequest {
  video_url: string;
  asset_key: string;
  fps: number;
  source_aspect: number;
  target_aspect: ReframeTargetAspect;
  segments: ReframeSegmentInput[];
  options?: Record<string, unknown>;
}

export type ReframeStatus = "queued" | "in_progress" | "completed" | "failed";

export type ReframeStage = "cache" | "download" | "analyze" | "plan";

export interface ReframeProgress {
  stage: ReframeStage | string;
  done: number;
  total: number;
}

export interface ReframeKeyframe {
  /** Seconds from segment start; round((start + time) * fps) === sourceFrame. */
  time: number;
  zoom: number;
  focusX: number;
  focusY: number;
  sourceFrame?: number;
  reason?: string;
}

export interface ReframeSegmentResult {
  id: string;
  start: number;
  end: number;
  shots: number;
  keyframes: ReframeKeyframe[];
}

export interface ReframeResult {
  fps: number;
  versions?: Record<string, string>;
  segments: ReframeSegmentResult[];
}

export interface ReframeSubmitResponse {
  id: string;
  object: "video.reframe";
  status: ReframeStatus;
  polling_url?: string;
}

export interface ReframeJob {
  id: string;
  object: "video.reframe";
  status: ReframeStatus;
  progress?: ReframeProgress;
  error?: { message?: string };
  result?: ReframeResult;
}

export interface ReframeClientOptions {
  /** Skip Secrets Manager (tests). */
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  timeoutMs?: number;
}

export class SporeLabsError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type?: string,
    readonly code?: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "SporeLabsError";
  }
}

// ============================================================================
// KEY
// ============================================================================

let cachedApiKey: string | null = null;

export async function getSporeLabsReframeApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const secretArn = process.env.SPORELABS_SECRET_ARN;
  if (!secretArn) {
    throw new Error("SPORELABS_SECRET_ARN is not set");
  }
  const result = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  const key = result.SecretString?.trim();
  if (!key || key.startsWith("REPLACE_ME")) {
    throw new Error(
      "SporeLabs API key is missing in Secrets Manager (secret still holds the REPLACE_ME placeholder or is empty)",
    );
  }
  cachedApiKey = key;
  return key;
}

// ============================================================================
// HTTP
// ============================================================================

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 1s, 2s, 4s … with ±20% jitter, or the server's Retry-After when shorter than 60s. */
function backoffMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 60) {
    return seconds * 1000;
  }
  const base = 1000 * 2 ** (attempt - 1);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

type ErrorEnvelope = {
  error?: { message?: string; type?: string; code?: string };
};

/** Error code on the SporeLabsError thrown when an idempotency key is reused with a different body. */
export const IDEMPOTENCY_CONFLICT_CODE = "idempotency_conflict";

export function isIdempotencyConflict(err: unknown): err is SporeLabsError {
  return err instanceof SporeLabsError && err.code === IDEMPOTENCY_CONFLICT_CODE;
}

export interface RequestJsonExtras {
  /**
   * Sent as `Idempotency-Key` on every attempt, retries included. SporeLabs
   * returns the original job for a repeated key (no new charge) and answers
   * 409 when the key was used with a different body. Servers that do not
   * support the header ignore it.
   */
  idempotencyKey?: string;
}

/** Shared by every SporeLabs job client (reframe, transcribe). */
export async function requestJson<T>(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  opts: ReframeClientOptions,
  extras: RequestJsonExtras = {},
): Promise<T> {
  const apiKey = opts.apiKey ?? (await getSporeLabsReframeApiKey());
  const baseUrl = (opts.baseUrl ?? SPORELABS_REFRAME_BASE_URL).replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? REFRAME_MAX_ATTEMPTS);
  const timeoutMs = opts.timeoutMs ?? REFRAME_HTTP_TIMEOUT_MS;
  const label = `SporeLabs ${method} ${path}`;
  const idempotencyKey = extras.idempotencyKey;
  if (idempotencyKey !== undefined && !/^[\x21-\x7e]{1,255}$/.test(idempotencyKey)) {
    throw new SporeLabsError(400, `${label}: invalid Idempotency-Key`);
  }

  let lastError: SporeLabsError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Network error or our own timeout. Only the error name/message — the
      // request body holds a presigned URL.
      const reason =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      lastError = new SporeLabsError(0, `${label} failed: ${reason}`, undefined, undefined, true);
      if (attempt < maxAttempts) {
        console.warn(`[SporeLabs] ${lastError.message} (attempt ${attempt}/${maxAttempts})`);
        await sleep(backoffMs(attempt, null));
        continue;
      }
      throw lastError;
    }

    const text = await response.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      // handled below
    }

    if (response.ok) {
      if (data === undefined || data === null || typeof data !== "object") {
        throw new SporeLabsError(
          response.status,
          `${label} returned non-JSON (${response.status})`,
        );
      }
      return data as T;
    }

    const envelope = (data as ErrorEnvelope | undefined)?.error;
    const message =
      envelope?.message || response.statusText || `HTTP ${response.status}`;
    if (response.status === 409 && idempotencyKey) {
      // The key already names a job created from a different request body.
      // Resubmitting cannot succeed and must not create a second billed job.
      const conflict = new SporeLabsError(
        409,
        `${label} 409: Idempotency-Key ${idempotencyKey} was already used with a ` +
          `different request body; not resubmitting (${message})`,
        envelope?.type,
        IDEMPOTENCY_CONFLICT_CODE,
        false,
      );
      console.error(`[SporeLabs] ${conflict.message}`);
      throw conflict;
    }
    // 429 is retried for rate limits, but an empty wallet will not refill itself.
    const retryable =
      isRetryableStatus(response.status) &&
      envelope?.code !== "insufficient_quota";
    const err = new SporeLabsError(
      response.status,
      `${label} ${response.status}: ${message}`,
      envelope?.type,
      envelope?.code,
      retryable,
    );
    if (retryable && attempt < maxAttempts) {
      console.warn(`[SporeLabs] ${err.message} (attempt ${attempt}/${maxAttempts})`);
      lastError = err;
      await sleep(backoffMs(attempt, response.headers.get("retry-after")));
      continue;
    }
    throw err;
  }
  throw lastError ?? new SporeLabsError(0, `${label} failed`);
}

// ============================================================================
// SEGMENT BOUNDS
// ============================================================================

/** What is known about the length of the file SporeLabs will decode. */
export interface ReframeVideoBounds {
  fps: number;
  /** Frames in that file: an exact packet count, or the container's nb_frames. */
  frameCount?: number | null;
  /** Container duration in seconds. */
  durationSec?: number | null;
}

export interface ReframeSegmentClamp {
  id: string;
  field: "start" | "end";
  from: number;
  to: number;
}

export interface ClampedReframeSegments {
  /** Segments to submit, in the original order. Untouched objects are reused. */
  segments: ReframeSegmentInput[];
  clamped: ReframeSegmentClamp[];
  /** Segments with no frame inside the video; not submitted. */
  dropped: ReframeSegmentInput[];
  /** Last usable segment end in seconds, or null when the length is unknown. */
  maxEndSec: number | null;
}

/**
 * Last usable segment end for the video SporeLabs will decode.
 *
 * The service puts bounds on the frame grid as `round(seconds * fps)` and
 * rejects a segment whose end frame lies past the file's frame count ("A
 * segment ends at frame 5664 but the video has 5637 frames"). The frame count
 * is therefore the authoritative bound: a VFR-derived average fps times the
 * stored asset duration can overshoot it by dozens of frames. The container
 * duration is the fallback when no count is known.
 */
export function reframeMaxEndSec(bounds: ReframeVideoBounds): number | null {
  const { fps, frameCount, durationSec } = bounds;
  if (!(Number.isFinite(fps) && fps > 0)) return null;
  if (frameCount != null && Number.isFinite(frameCount) && frameCount > 0) {
    return frameCount / fps;
  }
  if (durationSec != null && Number.isFinite(durationSec) && durationSec > 0) {
    return durationSec;
  }
  return null;
}

/**
 * Clamp segment bounds into [0, maxEnd] before submit. A segment whose first
 * frame is already at or past the end is dropped (the caller gives it a
 * fallback hold); every other segment keeps its id and position. Non-finite
 * bounds pass through untouched for the service to reject.
 */
export function clampReframeSegments(
  segments: ReframeSegmentInput[],
  bounds: ReframeVideoBounds,
): ClampedReframeSegments {
  const maxEndSec = reframeMaxEndSec(bounds);
  const clamped: ReframeSegmentClamp[] = [];
  const dropped: ReframeSegmentInput[] = [];
  if (maxEndSec == null) return { segments, clamped, dropped, maxEndSec };

  // Exclusive end frame of the file; a segment must start before it.
  const endFrame = Math.round(maxEndSec * bounds.fps);
  const out: ReframeSegmentInput[] = [];
  for (const seg of segments) {
    let { start, end } = seg;
    if (Number.isFinite(start)) {
      const floor = Math.max(0, start);
      if (Math.round(floor * bounds.fps) >= endFrame) {
        dropped.push(seg);
        continue;
      }
      if (floor !== start) {
        clamped.push({ id: seg.id, field: "start", from: start, to: floor });
        start = floor;
      }
    }
    if (Number.isFinite(end) && end > maxEndSec) {
      clamped.push({ id: seg.id, field: "end", from: end, to: maxEndSec });
      end = maxEndSec;
    }
    out.push(start === seg.start && end === seg.end ? seg : { ...seg, start, end });
  }
  return { segments: out, clamped, dropped, maxEndSec };
}

// ============================================================================
// API
// ============================================================================

export async function submitReframe(
  request: ReframeRequest,
  opts: ReframeClientOptions = {},
): Promise<ReframeSubmitResponse> {
  if (request.segments.length === 0) {
    throw new SporeLabsError(400, "SporeLabs reframe needs at least one segment");
  }
  if (request.segments.length > REFRAME_MAX_SEGMENTS) {
    throw new SporeLabsError(
      400,
      `SporeLabs reframe accepts at most ${REFRAME_MAX_SEGMENTS} segments (got ${request.segments.length})`,
    );
  }
  const res = await requestJson<ReframeSubmitResponse>(
    "POST",
    "/video/reframe",
    { ...request, options: request.options ?? {} },
    opts,
  );
  if (typeof res.id !== "string" || !res.id) {
    throw new SporeLabsError(502, "SporeLabs reframe submit returned no job id");
  }
  return res;
}

export async function getReframe(
  id: string,
  opts: ReframeClientOptions = {},
): Promise<ReframeJob> {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new SporeLabsError(400, `Invalid SporeLabs reframe id: ${id}`);
  }
  return requestJson<ReframeJob>(
    "GET",
    `/video/reframe/${encodeURIComponent(id)}`,
    undefined,
    opts,
  );
}

/** Opaque cache key: `zeevee/<assetId>/<proxy ETag>`, ≤200 chars of [A-Za-z0-9/_.:-]. */
export function buildReframeAssetKey(assetId: string, proxyEtag: string): string {
  const clean = (s: string) => s.replace(/"/g, "").replace(/[^A-Za-z0-9/_.:-]/g, "_");
  return `zeevee/${clean(assetId)}/${clean(proxyEtag)}`.slice(0, 200);
}
