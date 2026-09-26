/**
 * One status check's worth of progress for a render job: read each in-flight
 * scene, end the ones that can't finish, schedule retries, and decide the
 * job's status. The Remotion progress read is injected so every stuck-state
 * rule is testable without AWS.
 */
import { mapWithConcurrency } from "./concurrency";
import {
  isRenderJobExpired,
  isSceneRenderStuck,
  isTransientRenderError,
  MAX_SEGMENT_RENDER_ATTEMPTS,
  SCENE_RENDER_TIMEOUT_ERROR,
} from "./renderReuse";

export interface SegmentRender {
  segmentId: string;
  title: string;
  /** Empty while cutSegments is still cutting/launching this scene. */
  renderId: string;
  bucketName: string;
  outputKey: string; // Exact S3 key - stored at render start
  status: "rendering" | "completed" | "failed";
  error?: string;
  /** Launches so far (first render + automatic retries). */
  attempts?: number;
  launchRequestedAt?: string;
  /** Set by cutSegments when the Remotion render is launched. */
  launchedAt?: string;
  /** Stored render reused as-is; already on the project. */
  reused?: boolean;
  failedAt?: string;
}

export interface SceneProgress {
  done: boolean;
  /** Set when Remotion reports a fatal error. */
  fatalError?: string;
  /** 0..1 */
  overallProgress: number;
}

/** Reads one launched scene's progress; throws when it can't be read. */
export type SceneProbe = (scene: SegmentRender) => Promise<SceneProgress>;

// A scene waiting this long for cutSegments to hand back a render ID is lost.
export const PENDING_LAUNCH_TIMEOUT_MS = 20 * 60 * 1000;
// Wait before relaunching after an AWS capacity/throttle error: 45s, 90s, 135s.
export const RETRY_BACKOFF_MS = 45_000;
export const JOB_TIMEOUT_ERROR = "Export timed out";

export interface JobAdvance {
  segmentRenders: SegmentRender[];
  status: "rendering" | "completed" | "failed";
  error?: string;
  /** Scenes to hand back to cutSegments for another attempt. */
  retryIds: string[];
  progressById: Map<string, number>;
  completedCount: number;
  expectedCount: number;
  /** Anything changed that must be written back. */
  changed: boolean;
}

export async function advanceRenderJob(input: {
  job: { createdAt?: unknown; segments?: unknown[] };
  segmentRenders: SegmentRender[];
  probe: SceneProbe;
  now: number;
  /** False when there is no cut function to relaunch scenes with. */
  canRetry: boolean;
  concurrency: number;
}): Promise<JobAdvance> {
  const { job, probe, now, canRetry, concurrency } = input;
  const segmentRenders = [...input.segmentRenders];
  const progressById = new Map<string, number>();
  const jobCreatedAt =
    typeof job.createdAt === "string" ? job.createdAt : undefined;
  let changed = false;
  const fail = (i: number, error: string) => {
    segmentRenders[i] = {
      ...segmentRenders[i],
      status: "failed",
      error: error.slice(0, 2000),
      failedAt: new Date(now).toISOString(),
    };
    changed = true;
  };

  // Each probe invokes the Remotion Lambda. Checking them one by one pushes
  // large exports past API Gateway's 29s limit.
  await mapWithConcurrency(segmentRenders, concurrency, async (segment, i) => {
    if (segment.status !== "rendering") return;

    if (!segment.renderId) {
      const requestedAt = Date.parse(
        segment.launchRequestedAt || jobCreatedAt || "",
      );
      if (!Number.isFinite(requestedAt) || now - requestedAt > PENDING_LAUNCH_TIMEOUT_MS) {
        fail(i, "Timed out waiting for the scene to be cut");
      }
      return;
    }

    // A scene whose progress can't be read, or never moves, must still end.
    const stuck = isSceneRenderStuck(
      segment.launchedAt,
      segment.launchRequestedAt || jobCreatedAt,
      now,
    );
    try {
      const progress = await probe(segment);
      if (progress.fatalError) {
        console.error(`Segment ${segment.segmentId} failed:`, progress.fatalError);
        fail(i, progress.fatalError || "Render failed");
      } else if (progress.done) {
        segmentRenders[i] = { ...segment, status: "completed" };
        changed = true;
        console.log(
          `Segment ${segment.segmentId} completed! Key: ${segment.outputKey}`,
        );
      } else if (stuck) {
        console.error(`Segment ${segment.segmentId} stuck; failing it for retry`);
        fail(i, SCENE_RENDER_TIMEOUT_ERROR);
      } else {
        progressById.set(
          segment.segmentId,
          Math.round(progress.overallProgress * 100),
        );
      }
    } catch (error) {
      console.error(
        `Error checking progress for segment ${segment.segmentId}:`,
        error,
      );
      if (stuck) fail(i, SCENE_RENDER_TIMEOUT_ERROR);
    }
  });

  // Past the job ceiling nothing is retried and nothing stays in flight: keep
  // every finished scene, end the rest.
  const expired = isRenderJobExpired(job.createdAt, now);
  if (expired) {
    segmentRenders.forEach((segment, i) => {
      if (segment.status === "rendering") fail(i, JOB_TIMEOUT_ERROR);
    });
  }

  // Relaunch scenes that hit a temporary AWS error instead of failing the
  // whole export.
  const willRetry = (segment: SegmentRender) =>
    canRetry &&
    !expired &&
    segment.status === "failed" &&
    (segment.attempts ?? 1) < MAX_SEGMENT_RENDER_ATTEMPTS &&
    isTransientRenderError(segment.error);
  const retryIds: string[] = [];
  segmentRenders.forEach((segment, i) => {
    const failedAt = Date.parse(segment.failedAt || "") || 0;
    if (
      willRetry(segment) &&
      now - failedAt >= RETRY_BACKOFF_MS * (segment.attempts ?? 1)
    ) {
      retryIds.push(segment.segmentId);
      segmentRenders[i] = {
        ...segment,
        status: "rendering",
        renderId: "",
        bucketName: "",
        outputKey: "",
        attempts: (segment.attempts ?? 1) + 1,
        launchRequestedAt: new Date(now).toISOString(),
      };
      changed = true;
    }
  });

  const completed = segmentRenders.filter((s) => s.status === "completed");
  // Scenes waiting out a retry backoff still count as in progress.
  const failed = segmentRenders.filter(
    (s) => s.status === "failed" && !willRetry(s),
  );
  const expectedCount = Array.isArray(job.segments)
    ? job.segments.length
    : segmentRenders.length;
  const allAccountedFor = segmentRenders.length >= expectedCount;
  const status: JobAdvance["status"] =
    allAccountedFor && completed.length === segmentRenders.length
      ? "completed"
      : expired ||
          (allAccountedFor &&
            completed.length + failed.length === segmentRenders.length)
        ? "failed"
        : "rendering";
  const error =
    status !== "failed"
      ? undefined
      : expired
        ? `${JOB_TIMEOUT_ERROR} with ${completed.length} of ${expectedCount} scenes finished. Export again to render the rest.`
        : `${failed.length} of ${segmentRenders.length} scenes failed (${failed
            .map((s) => s.title)
            .join(", ")}): ${failed[0]?.error ?? "Render failed"}`.slice(0, 4000);

  return {
    segmentRenders,
    status,
    error,
    retryIds,
    progressById,
    completedCount: completed.length,
    expectedCount,
    changed,
  };
}
