/**
 * Shot-hold framing on SporeLabs (FRAMING_ENGINE=sporelabs).
 *
 * One SporeLabs job per framing job, covering every segment. SporeLabs finds
 * the camera cuts inside each segment and returns one hold per shot, already on
 * the source frame grid. We never move segment bounds and never re-round times.
 *
 * A first run on an hour-long asset (proxy build + analysis) can outlast one
 * Lambda. The SporeLabs job id is stored on `framingJob.sporelabsJobId`; when
 * time runs low we re-invoke ourselves to keep polling that job, never to
 * resubmit it. Lambda's own async retry lands in the same resume path.
 */

import { randomUUID } from "crypto";
import {
  buildReframeAssetKey,
  clampReframeSegments,
  REFRAME_TARGET_ASPECT,
} from "./sporelabs-reframe";
import type {
  ClampedReframeSegments,
  ReframeClientOptions,
  ReframeJob,
  ReframeProgress,
  ReframeRequest,
  ReframeResult,
  ReframeSubmitResponse,
} from "./sporelabs-reframe";

// ============================================================================
// TYPES (mirror analyzeFraming.ts)
// ============================================================================

export interface FramingKeyframe {
  id: string;
  time: number;
  focusX: number;
  focusY: number;
  zoom: number;
  aiReasoning?: string;
  isAiGenerated: boolean;
}

export interface ShotHoldSegment {
  id: string;
  startTime: number;
  endTime: number;
}

export interface ShotHoldJobInput {
  projectId: string;
  jobId: string;
  segments: ShotHoldSegment[];
  /** Present on a continuation invocation. */
  sporelabsJobId?: string;
  continuation?: number;
}

export interface ShotHoldProxy {
  url: string;
  etag: string;
  fps: number;
  width: number;
  height: number;
  /** Frames in the proxy file actually sent; bounds the segments. */
  frameCount?: number | null;
  /** Container duration of that file; fallback bound. */
  durationSec?: number | null;
}

export interface ShotHoldDeps {
  /** Current `framingJob` row, or null when the project is gone. */
  readJob(): Promise<{ jobId?: string; sporelabsJobId?: string } | null>;
  /** Guarded on jobId. Resolves false when a newer job owns the row. */
  updateJob(updates: Record<string, unknown>): Promise<boolean>;
  getAsset(): Promise<{ assetId: string; rawKey: string }>;
  ensureProxy(asset: {
    assetId: string;
    rawKey: string;
    deadlineAt: number;
    onHeartbeat: () => Promise<unknown>;
  }): Promise<ShotHoldProxy>;
  submitReframe(
    request: ReframeRequest,
    opts?: ReframeClientOptions,
  ): Promise<ReframeSubmitResponse>;
  getReframe(id: string, opts?: ReframeClientOptions): Promise<ReframeJob>;
  writeResults(keyframesByIndex: Map<number, FramingKeyframe[]>): Promise<void>;
  makeFallbackKeyframe(): FramingKeyframe;
  invokeContinuation(input: ShotHoldJobInput): Promise<void>;
  remainingMs(): number;
  sleep(ms: number): Promise<void>;
}

export type ShotHoldOutcome = "completed" | "continued" | "superseded";

// ============================================================================
// TUNABLES
// ============================================================================

const TARGET_CANVAS_ASPECT = 9 / 16;

export const POLL_INTERVAL_MS = 5_000;
/** Below this, hand off to a fresh invocation instead of polling again. */
export const CONTINUE_BELOW_MS = 90_000;
/** Proxy build must leave at least this much for submit + first poll. */
const PROXY_RESERVE_MS = 60_000;
/** Two hours of continuations is well past any real job. */
export const MAX_CONTINUATIONS = 10;
/** Heartbeat the framingJob row at least this often while waiting. */
const HEARTBEAT_EVERY_MS = 30_000;

// ============================================================================
// PURE HELPERS
// ============================================================================

/** SporeLabs worker stages, in order. "analyze" (one decode pass) dominates. */
const STAGE_ORDER = ["cache", "download", "analyze", "plan"] as const;
const STAGE_WEIGHT: Record<string, number> = {
  cache: 0,
  download: 0.1,
  analyze: 0.85,
  plan: 0.05,
};

/**
 * Map SporeLabs stage progress onto `completedCount` (segments). The whole
 * pipeline is weighted into one fraction, and the count stays below
 * segmentCount until results are actually written.
 */
export function progressToCompletedCount(
  progress: ReframeProgress | undefined,
  segmentCount: number,
): number {
  if (!progress || segmentCount <= 0) return 0;
  const stageIndex = STAGE_ORDER.indexOf(progress.stage as (typeof STAGE_ORDER)[number]);
  if (stageIndex < 0) return 0;
  let fraction = 0;
  for (let i = 0; i < stageIndex; i++) fraction += STAGE_WEIGHT[STAGE_ORDER[i]];
  const within =
    progress.total > 0
      ? Math.min(1, Math.max(0, progress.done / progress.total))
      : 0;
  fraction += STAGE_WEIGHT[progress.stage] * within;
  return Math.max(0, Math.min(segmentCount - 1, Math.floor(fraction * segmentCount)));
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * SporeLabs result → FramingKeyframe per requested segment index. Times pass
 * through unchanged (they are already on the frame grid). Segments missing from
 * the result, or with no usable keyframes, get the fallback keyframe.
 */
export function mapReframeResult(
  result: ReframeResult | undefined,
  segments: ShotHoldSegment[],
  makeFallback: () => FramingKeyframe,
): { keyframes: Map<number, FramingKeyframe[]>; missing: string[] } {
  const byId = new Map((result?.segments ?? []).map((s) => [s.id, s]));
  const keyframes = new Map<number, FramingKeyframe[]>();
  const missing: string[] = [];

  segments.forEach((seg, i) => {
    const duration = seg.endTime - seg.startTime;
    const kfs = (byId.get(seg.id)?.keyframes ?? [])
      .filter(
        (k) =>
          Number.isFinite(k.time) &&
          k.time >= 0 &&
          k.time < duration &&
          Number.isFinite(k.zoom) &&
          Number.isFinite(k.focusX) &&
          Number.isFinite(k.focusY),
      )
      .sort((a, b) => a.time - b.time)
      .map<FramingKeyframe>((k) => ({
        id: randomUUID(),
        time: k.time,
        focusX: clamp01(k.focusX),
        focusY: clamp01(k.focusY),
        zoom: clamp01(k.zoom),
        aiReasoning: k.reason || "shot hold",
        isAiGenerated: true,
      }));

    if (kfs.length === 0) {
      missing.push(seg.id);
      keyframes.set(i, [
        {
          ...makeFallback(),
          aiReasoning: "Shot-hold analysis returned no framing for this segment",
        },
      ]);
      return;
    }
    // Contract says the first keyframe is t=0; hold the first shot from the
    // segment open if the service ever skips it.
    if (kfs[0].time !== 0) kfs[0] = { ...kfs[0], time: 0 };
    keyframes.set(i, kfs);
  });

  return { keyframes, missing };
}

/**
 * Segment bounds come from the asset record; the proxy is what SporeLabs
 * decodes. When the two disagree (a VFR source's average fps times the stored
 * duration overshoots the real frame count) the service rejects the job, so
 * bounds are clamped to the proxy's length here. `clamp` says what moved.
 */
export function buildReframeRequest(
  input: ShotHoldJobInput,
  assetId: string,
  proxy: ShotHoldProxy,
): { request: ReframeRequest; clamp: ClampedReframeSegments } {
  const clamp = clampReframeSegments(
    input.segments.map((s) => ({ id: s.id, start: s.startTime, end: s.endTime })),
    { fps: proxy.fps, frameCount: proxy.frameCount, durationSec: proxy.durationSec },
  );
  return {
    request: {
      video_url: proxy.url,
      asset_key: buildReframeAssetKey(assetId, proxy.etag),
      fps: proxy.fps,
      source_aspect: proxy.width / proxy.height,
      target_aspect: REFRAME_TARGET_ASPECT,
      segments: clamp.segments,
      options: {},
    },
    clamp,
  };
}

/** One warning line per submit that had to move a bound. Never includes the proxy URL. */
function describeClamp(
  jobId: string,
  proxy: ShotHoldProxy,
  clamp: ClampedReframeSegments,
): string {
  const length =
    proxy.frameCount != null
      ? `${proxy.frameCount} frames @ ${proxy.fps.toFixed(3)} fps`
      : `container duration ${proxy.durationSec?.toFixed(3)}s`;
  const moves = clamp.clamped
    .slice(0, 10)
    .map((c) => `${c.id}.${c.field} ${c.from.toFixed(3)}→${c.to.toFixed(3)}`);
  if (clamp.clamped.length > 10) moves.push(`… ${clamp.clamped.length - 10} more`);
  const parts = [
    `[Framing] Job ${jobId}: proxy ends at ${clamp.maxEndSec?.toFixed(3)}s (${length}); ` +
      `segment bounds from the asset record overshoot it.`,
  ];
  if (moves.length > 0) parts.push(`Clamped ${clamp.clamped.length}: ${moves.join(", ")}.`);
  if (clamp.dropped.length > 0) {
    parts.push(
      `Dropped ${clamp.dropped.length} past the end (fallback hold): ${clamp.dropped.map((d) => d.id).join(", ")}.`,
    );
  }
  return parts.join(" ");
}

// ============================================================================
// RUN
// ============================================================================

/**
 * Run (or resume) the shot-hold job. Throws on hard failure; the caller marks
 * the framingJob failed exactly like the Gemini path.
 */
export async function runShotHoldFraming(
  input: ShotHoldJobInput,
  deps: ShotHoldDeps,
): Promise<ShotHoldOutcome> {
  const { jobId, segments } = input;
  const current = await deps.readJob();
  if (!current || current.jobId !== jobId) return "superseded";

  let sporelabsJobId = input.sporelabsJobId ?? current.sporelabsJobId;

  if (!sporelabsJobId) {
    const asset = await deps.getAsset();
    if (!(await deps.updateJob({ stage: "proxy" }))) return "superseded";
    const proxy = await deps.ensureProxy({
      assetId: asset.assetId,
      rawKey: asset.rawKey,
      deadlineAt: Date.now() + deps.remainingMs() - PROXY_RESERVE_MS,
      onHeartbeat: () => deps.updateJob({ stage: "proxy" }),
    });
    // Don't pay for analysis if a newer job took the row while we encoded.
    if (!(await deps.updateJob({ stage: "submitting" }))) return "superseded";

    // A source no wider than the canvas (vertical phone footage into 9:16) has
    // nothing to crop; SporeLabs rejects it. Show the whole picture instead.
    if (proxy.width / proxy.height <= TARGET_CANVAS_ASPECT + 1e-6) {
      const fit = new Map<number, FramingKeyframe[]>();
      segments.forEach((_, i) =>
        fit.set(i, [
          {
            id: randomUUID(),
            time: 0,
            focusX: 0.5,
            focusY: 0.5,
            zoom: 0,
            aiReasoning: "Source is not wider than the target; fit",
            isAiGenerated: true,
          },
        ]),
      );
      await deps.writeResults(fit);
      return "completed";
    }

    const { request, clamp } = buildReframeRequest(input, asset.assetId, proxy);
    if (clamp.clamped.length > 0 || clamp.dropped.length > 0) {
      console.warn(describeClamp(jobId, proxy, clamp));
    }
    if (request.segments.length === 0) {
      throw new Error(
        `SporeLabs reframe: all ${segments.length} segments lie past the end of the proxy video (${clamp.maxEndSec?.toFixed(3)}s)`,
      );
    }
    const submitted = await deps.submitReframe(request);
    sporelabsJobId = submitted.id;
    console.log(
      `[Framing] SporeLabs reframe ${sporelabsJobId} submitted for job ${jobId}: ` +
        `${request.segments.length} of ${segments.length} segments, fps ${proxy.fps.toFixed(3)}, aspect ${request.source_aspect.toFixed(4)} → ${REFRAME_TARGET_ASPECT}`,
    );
    if (!(await deps.updateJob({ sporelabsJobId, stage: "queued" }))) {
      return "superseded";
    }
  } else {
    console.log(
      `[Framing] Resuming SporeLabs reframe ${sporelabsJobId} for job ${jobId} (continuation ${input.continuation ?? 0})`,
    );
  }

  let lastCompleted = -1;
  let lastStage = "";
  let lastHeartbeat = 0;

  for (;;) {
    if (deps.remainingMs() < CONTINUE_BELOW_MS) {
      const continuation = (input.continuation ?? 0) + 1;
      if (continuation > MAX_CONTINUATIONS) {
        throw new Error(
          `SporeLabs reframe ${sporelabsJobId} did not finish after ${MAX_CONTINUATIONS} continuations`,
        );
      }
      if (!(await deps.updateJob({ continuation }))) return "superseded";
      await deps.invokeContinuation({ ...input, sporelabsJobId, continuation });
      console.log(
        `[Framing] Job ${jobId}: handing SporeLabs reframe ${sporelabsJobId} to continuation ${continuation}`,
      );
      return "continued";
    }

    const job = await deps.getReframe(sporelabsJobId);

    if (job.status === "completed") {
      const { keyframes, missing } = mapReframeResult(
        job.result,
        segments,
        deps.makeFallbackKeyframe,
      );
      if (missing.length > 0) {
        console.warn(
          `[Framing] SporeLabs reframe ${sporelabsJobId}: no keyframes for ${missing.length} segment(s): ${missing.join(", ")}`,
        );
      }
      const holds = [...keyframes.values()].reduce((n, k) => n + k.length, 0);
      console.log(
        `[Framing] SporeLabs reframe ${sporelabsJobId} completed: ${holds} holds across ${segments.length} segments` +
          (job.result?.versions ? ` (${JSON.stringify(job.result.versions)})` : ""),
      );
      await deps.writeResults(keyframes);
      return "completed";
    }

    if (job.status === "failed") {
      throw new Error(
        `SporeLabs reframe failed: ${job.error?.message || "no error message"}`,
      );
    }

    const completedCount = Math.max(
      lastCompleted,
      progressToCompletedCount(job.progress, segments.length),
    );
    const stage = job.progress?.stage ?? job.status;
    const now = Date.now();
    if (
      completedCount !== lastCompleted ||
      stage !== lastStage ||
      now - lastHeartbeat >= HEARTBEAT_EVERY_MS
    ) {
      if (!(await deps.updateJob({ completedCount, stage }))) {
        return "superseded";
      }
      lastCompleted = completedCount;
      lastStage = stage;
      lastHeartbeat = now;
    }

    await deps.sleep(POLL_INTERVAL_MS);
  }
}
