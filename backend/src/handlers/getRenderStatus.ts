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
import {
  advanceRenderJob,
  type SegmentRender,
} from "../utils/renderJobProgress";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
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
const lambdaClient = new LambdaClient({});
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


/** Free the project's export slot if this job still holds it. */
async function releaseExportSlot(projectId: string, jobId: string) {
  await docClient
    .send(
      new UpdateCommand({
        TableName: PROJECTS_TABLE,
        Key: { projectId },
        UpdateExpression: "REMOVE activeRenderJobId SET updatedAt = :now",
        ConditionExpression: "activeRenderJobId = :jobId",
        ExpressionAttributeValues: {
          ":now": new Date().toISOString(),
          ":jobId": jobId,
        },
      }),
    )
    .catch((error: { name?: string }) => {
      if (error.name !== "ConditionalCheckFailedException") throw error;
    });
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
  let segmentRenders: SegmentRender[] = job.segmentRenders || [];
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
  let progressById = new Map<string, number>();
  // Downloads must come from the CORS-enabled copies the editor can fetch().
  let persistedLocations = new Map<string, RenderLocation>();

  if (job.status === "rendering" && REMOTION_FUNCTION_NAME && AWS_REGION_NAME) {
    const functionName = REMOTION_FUNCTION_NAME;
    const region = AWS_REGION_NAME as AwsRegion;
    const advance = await advanceRenderJob({
      job,
      segmentRenders,
      now: Date.now(),
      canRetry: Boolean(STITCH_FUNCTION_NAME),
      concurrency: PROGRESS_CHECK_CONCURRENCY,
      probe: async (scene) => {
        const progress = await getRenderProgress({
          bucketName: scene.bucketName,
          renderId: scene.renderId,
          functionName,
          region,
        });
        return {
          done: progress.done,
          fatalError: progress.fatalErrorEncountered
            ? progress.errors?.[0]?.message || "Render failed"
            : undefined,
          overallProgress: progress.overallProgress,
        };
      },
    });
    segmentRenders = advance.segmentRenders;
    progressById = advance.progressById;
    const retryIds = advance.retryIds;

    if (advance.changed || advance.status !== job.status) {
      const rev = typeof job.rev === "number" ? job.rev : null;
      const jobError = advance.error;
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
              ":status": advance.status,
              ":segmentRenders": segmentRenders,
              ":progress": Math.round(
                (advance.completedCount / Math.max(advance.expectedCount, 1)) *
                  100,
              ),
              ":updatedAt": new Date().toISOString(),
              ":nextRev": (rev ?? 0) + 1,
              ...(rev === null ? {} : { ":rev": rev }),
              ...(jobError ? { ":error": jobError } : {}),
            },
          }),
        );
        job.status = advance.status;
        job.error = jobError;
      } catch (error) {
        if ((error as { name?: string }).name !== "ConditionalCheckFailedException") {
          throw error;
        }
        // Another writer (cut worker, cancel or concurrent poll) got there
        // first; report without side effects and let the next poll decide.
        console.log(`Render job ${jobId} changed concurrently; skipping update`);
        retryIds.length = 0;
        segmentRenders = job.segmentRenders || [];
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

  // Idempotent: a finished job must never keep holding the export slot (e.g.
  // an earlier release that failed, or a job cancelled mid-poll).
  if (
    (job.status === "completed" || job.status === "failed") &&
    job.projectId
  ) {
    await releaseExportSlot(job.projectId, jobId);
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
