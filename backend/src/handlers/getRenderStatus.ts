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
  renderId: string;
  bucketName: string;
  outputKey: string; // Exact S3 key - stored at render start
  status: "rendering" | "completed" | "failed";
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
        seg.status === "completed" && Boolean(seg.bucketName && seg.outputKey),
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

  // Build segment downloads array and check progress for each
  const segmentDownloads: SegmentDownload[] = [];
  let completedCount = 0;
  let failedCount = 0;
  let needsUpdate = false;

  if (job.status === "rendering" && REMOTION_FUNCTION_NAME && AWS_REGION_NAME) {
    // Each getRenderProgress call invokes the Remotion Lambda. Checking them
    // one by one pushes large exports past API Gateway's 29s limit.
    const downloads = await mapWithConcurrency(
      segmentRenders,
      PROGRESS_CHECK_CONCURRENCY,
      async (segment, i) => {
        const download: SegmentDownload = {
          segmentId: segment.segmentId,
          title: segment.title,
          status: segment.status,
          contentHash: renderContentHash(segment.segmentId),
        };

        // If already completed/failed, generate URL if needed
        if (segment.status === "completed") {
          completedCount++;
          download.downloadUrl = await generatePresignedUrl(segment);
          return download;
        }

        if (segment.status === "failed") {
          failedCount++;
          return download;
        }

        // Check progress from Remotion
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

            segmentRenders[i].status = "failed";
            download.status = "failed";
            download.error = rawError;
            failedCount++;
            needsUpdate = true;

            console.error(`Segment ${segment.segmentId} failed:`, rawError);
          } else if (renderProgress.done) {
            segmentRenders[i].status = "completed";
            download.status = "completed";
            completedCount++;
            needsUpdate = true;

            // Generate presigned URL using stored bucket/key
            download.downloadUrl = await generatePresignedUrl(segment);

            console.log(
              `Segment ${segment.segmentId} completed! Key: ${segment.outputKey}`,
            );
          } else {
            download.progress = Math.round(renderProgress.overallProgress * 100);
          }
        } catch (error) {
          console.error(
            `Error checking progress for segment ${segment.segmentId}:`,
            error,
          );
          download.progress = 0;
        }

        return download;
      },
    );
    segmentDownloads.push(...downloads);

    // Update job if any segments changed status
    if (needsUpdate) {
      const allCompleted = completedCount === segmentRenders.length;
      const anyFailed = failedCount > 0;
      const newStatus = allCompleted
        ? "completed"
        : anyFailed && completedCount + failedCount === segmentRenders.length
          ? "failed"
          : "rendering";

      await docClient.send(
        new UpdateCommand({
          TableName: RENDER_JOBS_TABLE,
          Key: { jobId },
          UpdateExpression:
            "SET #status = :status, segmentRenders = :segmentRenders, progress = :progress, updatedAt = :updatedAt",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":status": newStatus,
            ":segmentRenders": segmentRenders,
            ":progress": Math.round(
              (completedCount / segmentRenders.length) * 100,
            ),
            ":updatedAt": new Date().toISOString(),
          },
        }),
      );

      job.status = newStatus;
      job.progress = Math.round((completedCount / segmentRenders.length) * 100);

      // Persist to project only when job completes (not on every segment)
      // This reduces DB writes from N to 1
      if (
        (newStatus === "completed" || newStatus === "failed") &&
        job.projectId
      ) {
        if (newStatus === "completed") {
          const locations = await persistRendersToProject(
            job.projectId,
            segmentRenders,
            job,
          );
          await applyPersistedDownloadUrls(segmentDownloads, locations);
        }
        // Clear activeRenderJobId since render is done
        await docClient.send(
          new UpdateCommand({
            TableName: PROJECTS_TABLE,
            Key: { projectId: job.projectId },
            UpdateExpression: "REMOVE activeRenderJobId SET updatedAt = :now",
            ExpressionAttributeValues: { ":now": new Date().toISOString() },
          }),
        );
      }
    }
  } else if (job.status === "completed" || job.status === "failed") {
    // Job already done - build download URLs
    for (const segment of segmentRenders) {
      const download: SegmentDownload = {
        segmentId: segment.segmentId,
        title: segment.title,
        status: segment.status,
        contentHash: renderContentHash(segment.segmentId),
      };

      if (segment.status === "completed") {
        download.downloadUrl = await generatePresignedUrl(segment);
        completedCount++;
      }

      segmentDownloads.push(download);
    }

    // Ensure renders are persisted to project (idempotent - safe to call multiple times)
    // This catches cases where persist failed or polling stopped before completion
    if (job.status === "completed" && job.projectId && completedCount > 0) {
      const locations = await persistRendersToProject(
        job.projectId,
        segmentRenders,
        job,
      );
      await applyPersistedDownloadUrls(segmentDownloads, locations);
    }
  }

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
