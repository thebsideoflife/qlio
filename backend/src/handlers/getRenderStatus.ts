import type { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { checkAuth } from "../utils/auth";
import {
  computeSegmentRenderFingerprint,
  type SegmentFraming,
} from "../utils/segmentRenderFingerprint";
import {
  copyRenderToCorsBucket,
  corsRenderObjectKey,
  presignRenderDownload,
} from "../utils/renderDownloads";
import { isSameRenderArtifact } from "../utils/renderArtifactCache";
import {
  isTransientRenderError,
  MAX_SEGMENT_RENDER_ATTEMPTS,
  shouldReplaceStoredRender,
} from "../utils/renderReuse";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { mapWithConcurrency } from "../utils/concurrency";
import { getRenderProgress } from "@remotion/lambda/client";
import type { AwsRegion } from "@remotion/lambda";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const RENDER_JOBS_TABLE = process.env.RENDER_JOBS_TABLE!;
const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const RENDERS_BUCKET = process.env.RENDERS_BUCKET;
const REMOTION_FUNCTION_NAME = process.env.REMOTION_FUNCTION_NAME;
const AWS_REGION_NAME = process.env.AWS_REGION_NAME;
const STITCH_FUNCTION_NAME = process.env.STITCH_FUNCTION_NAME;
// A scene waiting this long for cutSegments to hand back a render ID is lost.
const PENDING_LAUNCH_TIMEOUT_MS = 20 * 60 * 1000;
const lambdaClient = new LambdaClient({});
// Wait before relaunching after an AWS capacity/throttle error: 45s, 90s, 135s.
const RETRY_BACKOFF_MS = 45_000;
const PROGRESS_CHECK_CONCURRENCY = 10;

type RenderLocation = { bucket: string; key: string };

// Stored on project for persistent render access
interface StoredSegmentRender {
  segmentId: string;
  title: string;
  bucket: string;
  key: string;
  renderedAt: string;
  contentHash?: string;
  sourceBucket?: string;
  sourceKey?: string;
}

interface SegmentRender {
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
  /** Stored render reused as-is; already on the project. */
  reused?: boolean;
  failedAt?: string;
}

interface SegmentDownload {
  segmentId: string;
  title: string;
  status: "rendering" | "completed" | "failed";
  downloadUrl?: string;
  progress?: number;
  error?: string;
  /** Hash of the inputs captured when this render job started. */
  contentHash?: string;
  /** Hit a temporary AWS error; will be relaunched automatically. */
  retrying?: boolean;
}

/**
 * Copy a completed Remotion output onto the CORS-enabled renders bucket so
 * the editor can fetch() it. Falls back to the Remotion working bucket.
 */
async function resolveDownloadLocation(
  projectId: string,
  seg: SegmentRender,
  existing: StoredSegmentRender | undefined,
  contentHash: string | undefined,
): Promise<RenderLocation> {
  const source: RenderLocation = {
    bucket: seg.bucketName,
    key: seg.outputKey,
  };
  if (!RENDERS_BUCKET) return source;

  if (
    existing?.bucket === RENDERS_BUCKET &&
    isSameRenderArtifact(existing, source, contentHash)
  ) {
    return { bucket: existing.bucket, key: existing.key };
  }

  try {
    return await copyRenderToCorsBucket({
      sourceBucket: seg.bucketName,
      sourceKey: seg.outputKey,
      destBucket: RENDERS_BUCKET,
      destKey: corsRenderObjectKey(projectId, seg.segmentId),
    });
  } catch (error) {
    console.error(
      `Failed to copy render ${seg.segmentId} to CORS bucket:`,
      error,
    );
    return source;
  }
}

/**
 * Persist completed renders to project for permanent access.
 * Merges with existing renders (handles partial re-renders).
 */
async function persistRendersToProject(
  projectId: string,
  segmentRenders: SegmentRender[],
  job: {
    segments?: Array<{
      id: string;
      startTime: number;
      endTime: number;
      framing?: SegmentFraming;
    }>;
    captionSettings?: {
      enabled: boolean;
      style: unknown;
      activeLanguage?: string;
    };
    globalFraming?: { aspectRatio: string; enabled?: boolean; squareTop?: boolean };
    transcriptionVersion?: string;
    renderPipelineVersion?: number;
    createdAt?: string;
  },
): Promise<Map<string, RenderLocation>> {
  const locations = new Map<string, RenderLocation>();
  try {
    // Get existing renders from project
    const projectResult = await docClient.send(
      new GetCommand({
        TableName: PROJECTS_TABLE,
        Key: { projectId },
        ProjectionExpression: "segmentRenders",
      }),
    );

    // Merge: existing renders + new completed renders (new wins)
    const renderMap = new Map<string, StoredSegmentRender>();
    for (const r of (projectResult.Item?.segmentRenders ||
      []) as StoredSegmentRender[]) {
      renderMap.set(r.segmentId, r);
    }

    const now = new Date().toISOString();
    const captionSettings = job.captionSettings || {
      enabled: true,
      style: {},
    };
    const globalFraming = job.globalFraming || { aspectRatio: "9:16" };

    const completed = segmentRenders.filter(
      (seg): seg is SegmentRender =>
        seg.status === "completed" &&
        !seg.reused &&
        Boolean(seg.bucketName && seg.outputKey),
    );

    const resolved = await Promise.all(
      completed.map(async (seg) => {
        const sourceSegment = job.segments?.find((s) => s.id === seg.segmentId);
        const contentHash = sourceSegment
          ? computeSegmentRenderFingerprint(
              sourceSegment,
              captionSettings,
              globalFraming,
              job.transcriptionVersion,
              job.renderPipelineVersion ?? 7,
            )
          : undefined;
        const existing = renderMap.get(seg.segmentId);
        const source = { bucket: seg.bucketName, key: seg.outputKey };
        const sameArtifact = isSameRenderArtifact(
          existing,
          source,
          contentHash,
        );
        const location = await resolveDownloadLocation(
          projectId,
          seg,
          existing,
          contentHash,
        );
        return { seg, location, contentHash, existing, sameArtifact, source };
      }),
    );

    for (const {
      seg,
      location,
      contentHash,
      existing,
      sameArtifact,
      source,
    } of resolved) {
      locations.set(seg.segmentId, location);
      // Never let an older job (e.g. a re-polled failed one) clobber a newer render.
      if (!sameArtifact && !shouldReplaceStoredRender(existing, job.createdAt)) {
        continue;
      }
      renderMap.set(seg.segmentId, {
        segmentId: seg.segmentId,
        title: seg.title,
        bucket: location.bucket,
        key: location.key,
        renderedAt: sameArtifact && existing ? existing.renderedAt : now,
        contentHash,
        sourceBucket: source.bucket,
        sourceKey: source.key,
      });
    }

    await docClient.send(
      new UpdateCommand({
        TableName: PROJECTS_TABLE,
        Key: { projectId },
        UpdateExpression:
          "SET segmentRenders = :renders, updatedAt = :updatedAt",
        ExpressionAttributeValues: {
          ":renders": Array.from(renderMap.values()),
          ":updatedAt": now,
        },
      }),
    );

    console.log(`Persisted ${renderMap.size} renders to project ${projectId}`);
  } catch (e) {
    console.error("Failed to persist renders to project:", e);
  }
  return locations;
}

async function applyPersistedDownloadUrls(
  downloads: SegmentDownload[],
  locations: Map<string, RenderLocation>,
): Promise<void> {
  await Promise.all(
    downloads.map(async (download) => {
      const location = locations.get(download.segmentId);
      if (download.status !== "completed" || !location) return;
      try {
        download.downloadUrl = await presignRenderDownload(
          location.bucket,
          location.key,
        );
      } catch (error) {
        console.error(
          `Error generating URL for segment ${download.segmentId}:`,
          error,
        );
      }
    }),
  );
}

export const handler: APIGatewayProxyHandler = async (event) => {
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  const jobId = event.pathParameters?.jobId;
  if (!jobId) {
    return {
      statusCode: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Missing jobId" }),
    };
  }

  // Get render job
  const result = await docClient.send(
    new GetCommand({
      TableName: RENDER_JOBS_TABLE,
      Key: { jobId },
    }),
  );

  if (!result.Item) {
    return {
      statusCode: 404,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Render job not found" }),
    };
  }

  const job = result.Item;
  const segmentRenders: SegmentRender[] = job.segmentRenders || [];
  const renderContentHash = (segmentId: string): string | undefined => {
    const source = job.segments?.find((s: { id: string }) => s.id === segmentId);
    return source
      ? computeSegmentRenderFingerprint(
          source,
          job.captionSettings || { enabled: true, style: {} },
          job.globalFraming || { aspectRatio: "9:16" },
          job.transcriptionVersion,
          job.renderPipelineVersion ?? 7,
        )
      : undefined;
  };

  console.log(`Render status check for ${jobId}:`, {
    status: job.status,
    segmentCount: segmentRenders.length,
  });

  // Check if render is stuck (> 6 hours)
  const MAX_RENDER_TIME = 6 * 60 * 60 * 1000;
  if (job.status === "rendering") {
    const renderStartTime = new Date(job.createdAt).getTime();
    if (Date.now() - renderStartTime > MAX_RENDER_TIME) {
      console.error(`Render timeout for job ${jobId} - exceeded 6 hours`);
      await docClient.send(
        new UpdateCommand({
          TableName: RENDER_JOBS_TABLE,
          Key: { jobId },
          UpdateExpression:
            "SET #status = :status, #error = :error, updatedAt = :updatedAt",
          ExpressionAttributeNames: { "#status": "status", "#error": "error" },
          ExpressionAttributeValues: {
            ":status": "failed",
            ":error": "Render timeout - exceeded 6 hours",
            ":updatedAt": new Date().toISOString(),
          },
        }),
      );
      job.status = "failed";
      job.error = "Render timeout";
    }
  }

  // Helper to generate presigned URL using stored bucket/key
  async function generatePresignedUrl(
    segment: SegmentRender,
  ): Promise<string | undefined> {
    try {
      return await presignRenderDownload(segment.bucketName, segment.outputKey);
    } catch (error) {
      console.error(
        `Error generating URL for segment ${segment.segmentId}:`,
        error,
      );
      return undefined;
    }
  }

  const segmentDownloads: SegmentDownload[] = [];
  let completedCount = 0;
  const progressById = new Map<string, number>();
  // Downloads must come from the CORS-enabled copies the editor can fetch().
  let persistedLocations = new Map<string, RenderLocation>();

  if (job.status === "rendering" && REMOTION_FUNCTION_NAME && AWS_REGION_NAME) {
    let needsUpdate = false;
    const now = Date.now();

    // Each getRenderProgress call invokes the Remotion Lambda. Checking them
    // one by one pushes large exports past API Gateway's 29s limit.
    await mapWithConcurrency(
      segmentRenders,
      PROGRESS_CHECK_CONCURRENCY,
      async (segment, i) => {
        if (segment.status !== "rendering") return;

        if (!segment.renderId) {
          const requestedAt = Date.parse(
            segment.launchRequestedAt || job.createdAt,
          );
          if (now - requestedAt > PENDING_LAUNCH_TIMEOUT_MS) {
            segmentRenders[i] = {
              ...segment,
              status: "failed",
              error: "Timed out waiting for the scene to be cut",
              failedAt: new Date(now).toISOString(),
            };
            needsUpdate = true;
          }
          return;
        }

        try {
          const renderProgress = await getRenderProgress({
            bucketName: segment.bucketName,
            renderId: segment.renderId,
            functionName: REMOTION_FUNCTION_NAME,
            region: AWS_REGION_NAME as AwsRegion,
          });

          if (renderProgress.fatalErrorEncountered) {
            const rawError =
              renderProgress.errors?.[0]?.message || "Render failed";
            segmentRenders[i] = {
              ...segment,
              status: "failed",
              error: rawError.slice(0, 2000),
              failedAt: new Date(now).toISOString(),
            };
            needsUpdate = true;
            console.error(`Segment ${segment.segmentId} failed:`, rawError);
          } else if (renderProgress.done) {
            segmentRenders[i] = { ...segment, status: "completed" };
            needsUpdate = true;
            console.log(
              `Segment ${segment.segmentId} completed! Key: ${segment.outputKey}`,
            );
          } else {
            progressById.set(
              segment.segmentId,
              Math.round(renderProgress.overallProgress * 100),
            );
          }
        } catch (error) {
          console.error(
            `Error checking progress for segment ${segment.segmentId}:`,
            error,
          );
        }
      },
    );

    // Relaunch scenes that hit a temporary AWS error instead of failing the
    // whole export.
    const retryIds: string[] = [];
    const willRetry = (segment: SegmentRender) =>
      Boolean(STITCH_FUNCTION_NAME) &&
      segment.status === "failed" &&
      (segment.attempts ?? 1) < MAX_SEGMENT_RENDER_ATTEMPTS &&
      isTransientRenderError(segment.error);
    if (STITCH_FUNCTION_NAME) {
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
          needsUpdate = true;
        }
      });
    }

    const completed = segmentRenders.filter((s) => s.status === "completed");
    // Scenes waiting out a retry backoff still count as in progress.
    const failed = segmentRenders.filter(
      (s) => s.status === "failed" && !willRetry(s),
    );
    const expected = Array.isArray(job.segments)
      ? job.segments.length
      : segmentRenders.length;
    const newStatus =
      segmentRenders.length >= expected && completed.length === segmentRenders.length
        ? "completed"
        : segmentRenders.length >= expected &&
            completed.length + failed.length === segmentRenders.length
          ? "failed"
          : "rendering";
    const jobError =
      newStatus === "failed"
        ? `${failed.length} of ${segmentRenders.length} scenes failed (${failed
            .map((s) => s.title)
            .join(", ")}): ${failed[0]?.error ?? "Render failed"}`.slice(0, 4000)
        : undefined;

    if (needsUpdate || newStatus !== job.status) {
      const rev = typeof job.rev === "number" ? job.rev : null;
      try {
        await docClient.send(
          new UpdateCommand({
            TableName: RENDER_JOBS_TABLE,
            Key: { jobId },
            UpdateExpression: `SET #status = :status, segmentRenders = :segmentRenders, progress = :progress, updatedAt = :updatedAt, rev = :nextRev${
              jobError ? ", #error = :error" : ""
            }`,
            ConditionExpression:
              rev === null ? "attribute_not_exists(rev)" : "rev = :rev",
            ExpressionAttributeNames: {
              "#status": "status",
              ...(jobError ? { "#error": "error" } : {}),
            },
            ExpressionAttributeValues: {
              ":status": newStatus,
              ":segmentRenders": segmentRenders,
              ":progress": Math.round(
                (completed.length / Math.max(expected, 1)) * 100,
              ),
              ":updatedAt": new Date().toISOString(),
              ":nextRev": (rev ?? 0) + 1,
              ...(rev === null ? {} : { ":rev": rev }),
              ...(jobError ? { ":error": jobError } : {}),
            },
          }),
        );
        job.status = newStatus;
        job.error = jobError;
      } catch (error) {
        if ((error as { name?: string }).name !== "ConditionalCheckFailedException") {
          throw error;
        }
        // Another writer (cut worker or concurrent poll) got there first;
        // report without side effects and let the next poll decide.
        console.log(`Render job ${jobId} changed concurrently; skipping update`);
        retryIds.length = 0;
        job.status = "rendering";
      }

      if (retryIds.length > 0) {
        console.log(`Retrying scenes ${retryIds.join(",")} for job ${jobId}`);
        await lambdaClient.send(
          new InvokeCommand({
            FunctionName: STITCH_FUNCTION_NAME,
            InvocationType: "Event",
            Payload: JSON.stringify({ jobId, segmentIds: retryIds }),
          }),
        );
      }

      if (
        (job.status === "completed" || job.status === "failed") &&
        job.projectId
      ) {
        // Keep every finished scene, even when others failed, so Retry only
        // has to render what's missing.
        persistedLocations = await persistRendersToProject(
          job.projectId,
          segmentRenders,
          job,
        );
        await docClient.send(
          new UpdateCommand({
            TableName: PROJECTS_TABLE,
            Key: { projectId: job.projectId },
            UpdateExpression: "REMOVE activeRenderJobId SET updatedAt = :now",
            ConditionExpression: "activeRenderJobId = :jobId",
            ExpressionAttributeValues: {
              ":now": new Date().toISOString(),
              ":jobId": jobId,
            },
          }),
        ).catch((error: { name?: string }) => {
          if (error.name !== "ConditionalCheckFailedException") throw error;
        });
      }
    }
  } else if (
    (job.status === "completed" || job.status === "failed") &&
    job.projectId &&
    segmentRenders.some((s) => s.status === "completed" && !s.reused)
  ) {
    // Idempotent: catches a persist that failed or never ran (including
    // older failed jobs whose finished scenes were discarded).
    persistedLocations = await persistRendersToProject(
      job.projectId,
      segmentRenders,
      job,
    );
  }

  for (const segment of segmentRenders) {
    const download: SegmentDownload = {
      segmentId: segment.segmentId,
      title: segment.title,
      status: segment.status,
      contentHash: renderContentHash(segment.segmentId),
    };
    if (segment.status === "completed") {
      completedCount++;
      download.downloadUrl = await generatePresignedUrl(segment);
    } else if (segment.status === "failed") {
      download.error = segment.error;
      // Still in flight from the user's point of view: we'll relaunch it.
      if (
        job.status === "rendering" &&
        (segment.attempts ?? 1) < MAX_SEGMENT_RENDER_ATTEMPTS &&
        isTransientRenderError(segment.error)
      ) {
        download.status = "rendering";
        download.retrying = true;
      }
    } else {
      download.progress = progressById.get(segment.segmentId) ?? 0;
      if ((segment.attempts ?? 1) > 1) download.retrying = true;
    }
    segmentDownloads.push(download);
  }
  await applyPersistedDownloadUrls(segmentDownloads, persistedLocations);

  // Calculate overall progress
  const progress =
    segmentRenders.length > 0
      ? Math.round((completedCount / segmentRenders.length) * 100)
      : job.progress || 0;

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify({
      jobId: job.jobId,
      projectId: job.projectId,
      status: job.status,
      progress,
      segmentCount: segmentRenders.length,
      completedCount,
      segmentDownloads,
      totalDuration: job.totalDuration,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      error: job.error,
    }),
  };
};
