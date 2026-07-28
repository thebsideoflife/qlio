import { APIGatewayProxyHandler, Handler, type Context } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { TwelveLabs } from "twelvelabs-js";
import { randomUUID } from "crypto";
import { checkAuth } from "../utils/auth";
import { createTwelveLabsWrapper } from "../services/twelvelabs";
import {
  computeMissingMetadataOptions,
  computeSegmentMetadataFingerprint,
  generateSegmentMetadata,
  isSegmentMetadataIncomplete,
  mergeSegmentMetadataEntry,
  pruneSegmentMetadata,
  resolveClipForSegment,
  segmentSpansMultipleChunks,
  segmentThumbnailTimestamp,
  type ExportMetadataOptions,
  type ParsedSegmentMetadata,
} from "../services/export-metadata";
import type { StoredSegmentMetadata } from "../types/segment-metadata";
import { mapWithConcurrency } from "../utils/concurrency";
import { extractFrameToS3 } from "../utils/thumbnailExtract";
import { presignS3Uri } from "../utils/s3";
import {
  computeProjectThumbnailFingerprint,
  ensureProjectCoverThumbnail,
} from "../services/project-thumbnails";
import { enrichSegmentDescriptions } from "../services/export-metadata-enrich";
import { getActiveAgentRun } from "../services/iq-agent/thread";
import { fetchTranscriptFromS3 } from "../utils/transcript";
import type { TranscriptSegment } from "../services/storyiq/types";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: { removeUndefinedValues: true },
});
const secretsClient = new SecretsManagerClient({});
const lambdaClient = new LambdaClient({});

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const SECRET_ARN = process.env.SECRET_ARN!;
const BUCKET_NAME = process.env.BUCKET_NAME!;
const SELF_FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME!;

const MAX_CONCURRENCY = 3;
/** Keep batch wall time under Lambda max (3 parallel × ~10 min Pegasus cap). */
const SEGMENTS_PER_INVOCATION = 3;
const PRESIGN_TTL_SEC = 43_200;
const IN_FLIGHT_JOB_MAX_MS = 15 * 60 * 1000;

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

interface ProjectSegment {
  id: string;
  startTime: number;
  endTime: number;
  title?: string;
}

interface RequestBody {
  segmentIds?: string[];
  options?: ExportMetadataOptions;
}

interface ExportMetadataJob {
  status: "pending" | "generating" | "completed" | "failed";
  jobId: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
  segmentErrors?: Array<{ segmentId: string; error: string }>;
  segmentWarnings?: Array<{
    segmentId: string;
    code: string;
    message: string;
  }>;
}

interface AsyncJobPayload {
  isAsyncJob: true;
  projectId: string;
  jobId: string;
  body: RequestBody;
}

function fingerprintOptions(
  body: RequestBody,
): ExportMetadataOptions & { includeThumbnails: boolean } {
  const opts = body.options ?? {};
  return {
    ...opts,
    includeThumbnails: opts.includeThumbnails !== false,
  };
}

/** Just the metadata list, for use as a merge base right before a write. */
async function readCurrentSegmentMetadata(
  projectId: string,
  validSegmentIds: Set<string>,
): Promise<StoredSegmentMetadata[]> {
  const result = await docClient.send(
    new GetCommand({
      TableName: PROJECTS_TABLE,
      Key: { projectId },
      ProjectionExpression: "segmentMetadata",
      ConsistentRead: true,
    }),
  );
  const raw = result.Item?.segmentMetadata;
  return pruneSegmentMetadata(
    Array.isArray(raw) ? (raw as StoredSegmentMetadata[]) : [],
    validSegmentIds,
  );
}

function mergeStoredMetadata(
  existing: StoredSegmentMetadata[],
  updates: StoredSegmentMetadata[],
): StoredSegmentMetadata[] {
  const map = new Map(existing.map((e) => [e.segmentId, e]));
  for (const u of updates) {
    map.set(u.segmentId, mergeSegmentMetadataEntry(map.get(u.segmentId), u));
  }
  return Array.from(map.values());
}

async function signThumbnailKey(
  key: string | undefined,
): Promise<string | null> {
  if (!key) return null;
  return presignS3Uri(`s3://${BUCKET_NAME}/${key}`, PRESIGN_TTL_SEC);
}

/** Returns false if a newer job superseded this one. */
async function writeProjectMetadataIfJobActive(
  projectId: string,
  jobId: string,
  updateParts: string[],
  exprValues: Record<string, unknown>,
): Promise<boolean> {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: PROJECTS_TABLE,
        Key: { projectId },
        UpdateExpression: `SET ${updateParts.join(", ")}`,
        ConditionExpression: "exportMetadataJob.jobId = :expectedJobId",
        ExpressionAttributeValues: {
          ...exprValues,
          ":expectedJobId": jobId,
        },
      }),
    );
    return true;
  } catch (err: unknown) {
    const name = err instanceof Error ? (err as { name?: string }).name : "";
    if (name === "ConditionalCheckFailedException") {
      console.warn(
        `[ExportMetadata] Job ${jobId} superseded before metadata write on ${projectId}`,
      );
      return false;
    }
    throw err;
  }
}

/** Returns false if a newer job superseded this one. */
async function updateExportMetadataJob(
  projectId: string,
  jobId: string,
  patch: Partial<ExportMetadataJob> & { status: ExportMetadataJob["status"] },
): Promise<boolean> {
  const values: Record<string, unknown> = {
    ":status": patch.status,
    ":updatedAt": new Date().toISOString(),
    ":expectedJobId": jobId,
  };
  const parts = ["exportMetadataJob.#status = :status", "updatedAt = :updatedAt"];

  if (patch.completedAt) {
    parts.push("exportMetadataJob.completedAt = :completedAt");
    values[":completedAt"] = patch.completedAt;
  }
  if (patch.error !== undefined) {
    parts.push("exportMetadataJob.#error = :error");
    values[":error"] = patch.error;
  }
  if (patch.segmentErrors !== undefined) {
    parts.push("exportMetadataJob.segmentErrors = :segmentErrors");
    values[":segmentErrors"] = patch.segmentErrors;
  }
  if (patch.segmentWarnings !== undefined) {
    parts.push("exportMetadataJob.segmentWarnings = :segmentWarnings");
    values[":segmentWarnings"] = patch.segmentWarnings;
  }

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: PROJECTS_TABLE,
        Key: { projectId },
        UpdateExpression: `SET ${parts.join(", ")}`,
        ConditionExpression: "exportMetadataJob.jobId = :expectedJobId",
        ExpressionAttributeNames: {
          "#status": "status",
          ...(patch.error !== undefined ? { "#error": "error" } : {}),
        },
        ExpressionAttributeValues: values,
      }),
    );
    return true;
  } catch (err: unknown) {
    const name = err instanceof Error ? (err as { name?: string }).name : "";
    if (name === "ConditionalCheckFailedException") {
      console.warn(
        `[ExportMetadata] Job ${jobId} superseded on project ${projectId}, skipping status update`,
      );
      return false;
    }
    throw err;
  }
}

async function buildMetadataResponse(
  targetSegments: ProjectSegment[],
  existingCache: StoredSegmentMetadata[],
  generatedIds: string[],
  cachedIds: string[],
  errors: Array<{ segmentId: string; error: string }>,
  projectThumbnailKey: string | undefined,
  projectThumbnailUrl: string | null,
  warnings?: Array<{ segmentId: string; code: string; message: string }>,
) {
  const cacheById = new Map(existingCache.map((e) => [e.segmentId, e]));

  const responseSegments = await Promise.all(
    targetSegments.map(async (seg) => {
      const stored = cacheById.get(seg.id);
      if (!stored) return null;
      const thumbnailUrl = await signThumbnailKey(stored.thumbnailKey);
      const { thumbnailKey: _tk, ...rest } = stored;
      return {
        ...rest,
        thumbnailUrl,
      };
    }),
  );

  if (!projectThumbnailUrl) {
    projectThumbnailUrl = await signThumbnailKey(projectThumbnailKey);
  }

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      segments: responseSegments.filter(Boolean),
      generated: generatedIds,
      cached: cachedIds,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings?.length ? warnings : undefined,
      projectThumbnailUrl,
    }),
  };
}

/**
 * The IQ agent owns the cut while it runs, and writes delivery metadata itself
 * as it wraps up. Letting a Pegasus job run alongside it would spend money
 * describing bounds that are still moving, and the two writers would race for
 * the same `segmentMetadata` list.
 *
 * Fails open on purpose. This is a courtesy interlock, not a correctness one —
 * a project with no agent thread, or a DynamoDB blip, must not make Export
 * unusable.
 */
async function agentRunBlockingExport(
  projectId: string,
): Promise<{ runId: string; stage: string } | null> {
  if (!process.env.AGENT_THREADS_TABLE) return null;
  try {
    const run = await getActiveAgentRun(projectId);
    if (!run) return null;
    return { runId: run.runId, stage: run.stage };
  } catch (err) {
    console.warn(
      "[ExportMetadata] Could not check for an active agent run, allowing export:",
      err,
    );
    return null;
  }
}

async function chainRemainingSegments(
  projectId: string,
  jobId: string,
  body: RequestBody,
  remainingSegmentIds: string[],
): Promise<void> {
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: SELF_FUNCTION_NAME,
      InvocationType: "Event",
      Payload: JSON.stringify({
        isAsyncJob: true,
        projectId,
        jobId,
        body: { ...body, segmentIds: remainingSegmentIds },
      } satisfies AsyncJobPayload),
    }),
  );
  console.log(
    `[ExportMetadata] Job ${jobId} chained ${remainingSegmentIds.length} more segments`,
  );
}

async function executeExportMetadataJob(
  payload: AsyncJobPayload,
): Promise<void> {
  const { projectId, jobId, body } = payload;

  try {
    const updated = await updateExportMetadataJob(projectId, jobId, {
      status: "generating",
    });
    if (!updated) return;

    const fpOptions = fingerprintOptions(body);
    const includeThumbnails = fpOptions.includeThumbnails;

    const projectRes = await docClient.send(
      new GetCommand({
        TableName: PROJECTS_TABLE,
        Key: { projectId },
      }),
    );

    const project = projectRes.Item;
    if (!project) {
      throw new Error("Project not found");
    }

    const segments: ProjectSegment[] = project.segments || [];
    const assetId = project.assetId as string;
    if (!assetId) {
      throw new Error("Project has no assetId");
    }

    const validIds = new Set(segments.map((s) => s.id));
    const requestedIds = body.segmentIds?.length
      ? new Set(body.segmentIds)
      : validIds;

    const targetSegments = segments.filter((s) => requestedIds.has(s.id));
    const prunedCache = pruneSegmentMetadata(
      (project.segmentMetadata || []) as StoredSegmentMetadata[],
      validIds,
    );
    const cacheById = new Map(prunedCache.map((e) => [e.segmentId, e]));

    const staleSegments = targetSegments.filter((seg) =>
      isSegmentMetadataIncomplete(
        cacheById.get(seg.id),
        seg.startTime,
        seg.endTime,
        fpOptions,
      ),
    );

    if (staleSegments.length === 0) {
      await updateExportMetadataJob(projectId, jobId, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
      return;
    }

    const batch = staleSegments.slice(0, SEGMENTS_PER_INVOCATION);
    const remaining = staleSegments.slice(SEGMENTS_PER_INVOCATION);

    const existingJob = project.exportMetadataJob as ExportMetadataJob | undefined;
    const priorErrors = existingJob?.segmentErrors ?? [];
    const priorWarnings = existingJob?.segmentWarnings ?? [];

    const secret = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: SECRET_ARN }),
    );
    const apiKey = secret.SecretString || "";
    if (!apiKey) throw new Error("Empty TwelveLabs API key");

    const twelvelabsWrapper = createTwelveLabsWrapper(apiKey, ASSETS_TABLE);
    const asset = await twelvelabsWrapper.getAssetInfo(assetId);
    const client = new TwelveLabs({ apiKey });

    const sourceKey =
      asset.s3Key ||
      (asset.s3VideoUrl?.startsWith("s3://")
        ? asset.s3VideoUrl.replace("s3://", "").split("/").slice(1).join("/")
        : undefined);

    let transcript: TranscriptSegment[] = [];
    if (asset.transcriptionUrl) {
      try {
        transcript = await fetchTranscriptFromS3(asset.transcriptionUrl);
        console.log(
          `[ExportMetadata] Loaded transcript (${transcript.length} segments) for enrichment`,
        );
      } catch (err) {
        console.warn(
          "[ExportMetadata] Transcript fetch failed, using Pegasus descriptions only:",
          err,
        );
      }
    }

    const videoTitle =
      (typeof project.title === "string" && project.title.trim()) ||
      undefined;

    const generatedUpdates: StoredSegmentMetadata[] = [];
    const errors: Array<{ segmentId: string; error: string }> = [];
    const warnings: Array<{
      segmentId: string;
      code: string;
      message: string;
    }> = [];

    await mapWithConcurrency(batch, MAX_CONCURRENCY, async (seg) => {
      try {
        if (segmentSpansMultipleChunks(asset, seg.startTime, seg.endTime)) {
          warnings.push({
            segmentId: seg.id,
            code: "CHUNK_SPAN",
            message:
              "Segment spans multiple video chunks; metadata reflects the dominant chunk only.",
          });
        }

        const clip = resolveClipForSegment(asset, seg.startTime, seg.endTime);
        const existing = cacheById.get(seg.id);
        const missingOptions = computeMissingMetadataOptions(
          existing,
          fpOptions,
          seg.startTime,
          seg.endTime,
        );
        if (!missingOptions) return;

        let parsed: ParsedSegmentMetadata = await generateSegmentMetadata(
          client,
          clip,
          missingOptions,
        );

        if (
          transcript.length > 0 &&
          parsed.descriptions &&
          missingOptions.includeDescriptions !== false
        ) {
          parsed = await enrichSegmentDescriptions({
            pegasus: parsed,
            transcript,
            segmentStart: seg.startTime,
            segmentEnd: seg.endTime,
            videoTitle,
            options: missingOptions,
          });
        }

        const contentHash = computeSegmentMetadataFingerprint(
          seg.startTime,
          seg.endTime,
        );

        const entry: StoredSegmentMetadata = mergeSegmentMetadataEntry(
          existing,
          {
            segmentId: seg.id,
            contentHash,
            descriptions: parsed.descriptions,
            tags: parsed.tags,
            generatedAt: new Date().toISOString(),
          },
        );

        if (includeThumbnails && sourceKey) {
          const thumbKey = `thumbnails/projects/${projectId}/${seg.id}.jpg`;
          await extractFrameToS3({
            sourceBucket: BUCKET_NAME,
            sourceKey,
            timestampSec: segmentThumbnailTimestamp(seg.startTime),
            destBucket: BUCKET_NAME,
            destKey: thumbKey,
          });
          entry.thumbnailKey = thumbKey;
        }

        generatedUpdates.push(entry);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[ExportMetadata] Segment ${seg.id} failed:`, msg);
        errors.push({ segmentId: seg.id, error: msg });
      }
    });

    let projectThumbnailKey: string | undefined = project.thumbnailKey;

    // Refresh project cover only on the final batch
    if (remaining.length === 0 && includeThumbnails && sourceKey) {
      const coverFingerprint = computeProjectThumbnailFingerprint(segments);
      const shouldRefreshProjectThumb =
        generatedUpdates.length > 0 ||
        !project.thumbnailKey ||
        !project.thumbnailContentHash ||
        project.thumbnailContentHash !== coverFingerprint;

      if (shouldRefreshProjectThumb) {
        const cover = await ensureProjectCoverThumbnail({
          projectId,
          segments,
          asset,
          bucketName: BUCKET_NAME,
          projectsTable: PROJECTS_TABLE,
          existingThumbnailKey: project.thumbnailKey,
          existingThumbnailContentHash: project.thumbnailContentHash,
          presignTtlSec: PRESIGN_TTL_SEC,
        });
        if (cover) {
          projectThumbnailKey = cover.thumbnailKey;
        }
      }
    }

    // `prunedCache` is minutes old by now — Pegasus and FFmpeg happened in
    // between — and this write replaces the whole list. Re-reading means an IQ
    // agent run, or the next batch of a chained job, does not have its rows
    // erased by a merge base from before it wrote them.
    const mergeBase = await readCurrentSegmentMetadata(projectId, validIds).catch(
      () => prunedCache,
    );
    const mergedMetadata = mergeStoredMetadata(mergeBase, generatedUpdates);

    const updateParts = ["segmentMetadata = :meta", "updatedAt = :updatedAt"];
    const exprValues: Record<string, unknown> = {
      ":meta": mergedMetadata,
      ":updatedAt": new Date().toISOString(),
    };

    if (projectThumbnailKey) {
      updateParts.push("thumbnailKey = :thumbKey");
      exprValues[":thumbKey"] = projectThumbnailKey;
      const coverHash = computeProjectThumbnailFingerprint(segments);
      if (coverHash) {
        updateParts.push("thumbnailContentHash = :thumbHash");
        exprValues[":thumbHash"] = coverHash;
      }
    }

    if (generatedUpdates.length > 0 || projectThumbnailKey) {
      const wrote = await writeProjectMetadataIfJobActive(
        projectId,
        jobId,
        updateParts,
        exprValues,
      );
      if (!wrote) return;
    }

    const allErrors = [...priorErrors, ...errors];
    const allWarnings = [...priorWarnings, ...warnings];

    if (remaining.length > 0) {
      await updateExportMetadataJob(projectId, jobId, {
        status: "generating",
        segmentErrors: allErrors.length > 0 ? allErrors : undefined,
        segmentWarnings: allWarnings.length > 0 ? allWarnings : undefined,
      });
      await chainRemainingSegments(
        projectId,
        jobId,
        body,
        remaining.map((s) => s.id),
      );
      console.log(
        `[ExportMetadata] Job ${jobId} batch done: ${generatedUpdates.length} generated, ${remaining.length} queued`,
      );
      return;
    }

    const completedAt = new Date().toISOString();
    const finalCache = mergeStoredMetadata(mergeBase, generatedUpdates);
    const anySucceeded = targetSegments.some((seg) => {
      const cached = finalCache.find((m) => m.segmentId === seg.id);
      return (
        !!cached &&
        !allErrors.some((e) => e.segmentId === seg.id) &&
        !isSegmentMetadataIncomplete(cached, seg.startTime, seg.endTime, fpOptions)
      );
    });
    const status = anySucceeded ? "completed" : "failed";

    await updateExportMetadataJob(projectId, jobId, {
      status,
      completedAt,
      error: !anySucceeded
        ? allErrors.map((e) => `${e.segmentId}: ${e.error}`).join("; ")
        : allErrors.length > 0
          ? `${allErrors.length} segment(s) failed`
          : undefined,
      segmentErrors: allErrors.length > 0 ? allErrors : undefined,
      segmentWarnings: allWarnings.length > 0 ? allWarnings : undefined,
    });

    console.log(
      `[ExportMetadata] Job ${jobId} ${status}: ${generatedUpdates.length} generated, ${allErrors.length} errors`,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[ExportMetadata] Job ${jobId} failed:`, error);
    await updateExportMetadataJob(projectId, jobId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: msg,
    });
  }
}

const handleApiRequest: APIGatewayProxyHandler = async (event) => {
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  try {
    const projectId = event.pathParameters?.projectId;
    if (!projectId) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Missing projectId" }),
      };
    }

    const body: RequestBody = JSON.parse(event.body || "{}");

    const projectRes = await docClient.send(
      new GetCommand({
        TableName: PROJECTS_TABLE,
        Key: { projectId },
      }),
    );

    if (!projectRes.Item) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Project not found" }),
      };
    }

    const project = projectRes.Item;
    const segments: ProjectSegment[] = project.segments || [];
    const fpOptions = fingerprintOptions(body);
    const validIds = new Set(segments.map((s) => s.id));

    const requestedIds = body.segmentIds?.length
      ? new Set(body.segmentIds)
      : validIds;
    const targetSegments = segments.filter((s) => requestedIds.has(s.id));

    if (targetSegments.length === 0) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "No matching segments" }),
      };
    }

    const prunedCache = pruneSegmentMetadata(
      (project.segmentMetadata || []) as StoredSegmentMetadata[],
      validIds,
    );
    const cacheById = new Map(prunedCache.map((e) => [e.segmentId, e]));

    const staleSegments = targetSegments.filter((seg) =>
      isSegmentMetadataIncomplete(
        cacheById.get(seg.id),
        seg.startTime,
        seg.endTime,
        fpOptions,
      ),
    );

    const cachedIds = targetSegments
      .filter((seg) => !staleSegments.some((s) => s.id === seg.id))
      .map((s) => s.id);

    if (staleSegments.length === 0) {
      return buildMetadataResponse(
        targetSegments,
        prunedCache,
        [],
        cachedIds,
        [],
        project.thumbnailKey,
        null,
      );
    }

    // Checked only once there is work to do: reading back metadata the agent
    // has already written is always fine, even mid-run.
    const activeAgentRun = await agentRunBlockingExport(projectId);
    if (activeAgentRun) {
      return {
        statusCode: 409,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error:
            "The IQ agent is still working on this cut. Metadata will be ready when it finishes.",
          code: "agent_run_active",
          agentRunId: activeAgentRun.runId,
          agentStage: activeAgentRun.stage,
        }),
      };
    }

    const existingJob = project.exportMetadataJob as
      | ExportMetadataJob
      | undefined;
    if (
      existingJob &&
      (existingJob.status === "pending" ||
        existingJob.status === "generating") &&
      existingJob.startedAt
    ) {
      const ageMs = Date.now() - new Date(existingJob.startedAt).getTime();
      if (ageMs < IN_FLIGHT_JOB_MAX_MS) {
        return {
          statusCode: 202,
          headers: CORS_HEADERS,
          body: JSON.stringify({
            message: "Export metadata generation already in progress",
            jobId: existingJob.jobId,
            status: existingJob.status,
          }),
        };
      }
    }

    const jobId = randomUUID();
    const startedAt = new Date().toISOString();
    const staleCutoff = new Date(
      Date.now() - IN_FLIGHT_JOB_MAX_MS,
    ).toISOString();

    try {
      await docClient.send(
        new UpdateCommand({
          TableName: PROJECTS_TABLE,
          Key: { projectId },
          UpdateExpression: "SET exportMetadataJob = :job, updatedAt = :u",
          ConditionExpression:
            "attribute_not_exists(exportMetadataJob) OR exportMetadataJob.#status IN (:completed, :failed) OR exportMetadataJob.startedAt < :staleCutoff",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":job": {
              status: "pending",
              jobId,
              startedAt,
            } as ExportMetadataJob,
            ":u": startedAt,
            ":completed": "completed",
            ":failed": "failed",
            ":staleCutoff": staleCutoff,
          },
        }),
      );
    } catch (err: unknown) {
      const name = err instanceof Error ? (err as { name?: string }).name : "";
      if (name === "ConditionalCheckFailedException") {
        const refreshed = await docClient.send(
          new GetCommand({
            TableName: PROJECTS_TABLE,
            Key: { projectId },
            ProjectionExpression: "exportMetadataJob",
          }),
        );
        const active = refreshed.Item?.exportMetadataJob as
          | ExportMetadataJob
          | undefined;
        if (
          active &&
          (active.status === "pending" || active.status === "generating")
        ) {
          return {
            statusCode: 202,
            headers: CORS_HEADERS,
            body: JSON.stringify({
              message: "Export metadata generation already in progress",
              jobId: active.jobId,
              status: active.status,
            }),
          };
        }
      }
      throw err;
    }

    const payload: AsyncJobPayload = {
      isAsyncJob: true,
      projectId,
      jobId,
      body,
    };

    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: SELF_FUNCTION_NAME,
        InvocationType: "Event",
        Payload: JSON.stringify(payload),
      }),
    );

    console.log(
      `[ExportMetadata] Started async job ${jobId} for project ${projectId} (${staleSegments.length} stale segments)`,
    );

    return {
      statusCode: 202,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        message: "Export metadata generation started",
        jobId,
        status: "pending",
      }),
    };
  } catch (error) {
    console.error("generateExportMetadata error:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error:
          error instanceof Error ? error.message : "Internal server error",
      }),
    };
  }
};

export const handler: Handler = async (event, context, callback) => {
  if (event.isAsyncJob) {
    await executeExportMetadataJob(event as AsyncJobPayload);
    return;
  }
  return handleApiRequest(event, context, callback);
};
