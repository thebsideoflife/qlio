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
  aeoWantsIabTopics,
  computeMissingMetadataOptions,
  computeSegmentMetadataFingerprint,
  generateSegmentMetadata,
  isSegmentMetadataIncomplete,
  mergeSegmentMetadataEntry,
  pruneSegmentMetadata,
  resolveClipForSegment,
  segmentSpansMultipleChunks,
  pegasusOptionsFor,
  segmentThumbnailTimestamp,
  type ExportMetadataOptions,
  type ParsedSegmentMetadata,
} from "../services/export-metadata";
import {
  aeoHasModelWork,
  generateSegmentAeo,
} from "../services/aeo-metadata";
import {
  computeShowInfoHash,
  normalizeShowInfo,
  type ShowInfo,
} from "../services/show-info";
import type { IabTaxonomyTags } from "../services/iab-content-taxonomy";
import type { StoredSegmentMetadata } from "../types/segment-metadata";
import { mapWithConcurrency } from "../utils/concurrency";
import { extractFrameToS3 } from "../utils/thumbnailExtract";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  exportFlags,
  exportThumbnail,
  pickSceneThumbnail,
  probeSource,
  THUMBNAIL_PICK_VERSION,
  type SourceInfo,
} from "../services/thumbnails/pick";
import { runSetPass, setFingerprint, type SetPassScene, type StoredThumbnailSet } from "../services/thumbnails/setPass";
import { proxyKeyForAsset } from "../services/reframe-proxy";
import { toThumbnailReview } from "../utils/thumbnail-review";
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
const s3Client = new S3Client({});

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
  showInfoHash: string,
): ExportMetadataOptions & { includeThumbnails: boolean } {
  const opts = body.options ?? {};
  return {
    ...opts,
    includeThumbnails: opts.includeThumbnails !== false,
    // The stored show info decides staleness, never the client's copy.
    ...(opts.aeo ? { aeo: { ...opts.aeo, showInfoHash } } : {}),
  };
}

async function readShowInfo(assetId: string | undefined): Promise<ShowInfo> {
  if (!assetId) return {};
  const result = await docClient.send(
    new GetCommand({
      TableName: ASSETS_TABLE,
      Key: { assetId },
      ProjectionExpression: "showInfo",
    }),
  );
  return normalizeShowInfo(result.Item?.showInfo);
}

/** Union of two IAB tag sets, keeping labels aligned with ids. */
function unionIab(
  a: IabTaxonomyTags | undefined,
  b: IabTaxonomyTags | undefined,
): IabTaxonomyTags | undefined {
  if (!a?.cat?.length) return b;
  if (!b?.cat?.length) return a;
  const cat: string[] = [];
  const labels: string[] = [];
  for (const source of [a, b]) {
    source.cat.forEach((id, i) => {
      if (cat.includes(id)) return;
      cat.push(id);
      labels.push(source.labels?.[i] ?? id);
    });
  }
  return { cattax: a.cattax, cat, labels };
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
      const { thumbnailKey: _tk, thumbnailPick, ...rest } = stored;
      const thumbnailReview = await toThumbnailReview(thumbnailPick, signThumbnailKey);
      return {
        ...rest,
        thumbnailUrl,
        ...(thumbnailReview ? { thumbnailReview } : {}),
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

    const showInfo = await readShowInfo(assetId);
    const fpOptions = fingerprintOptions(body, computeShowInfoHash(showInfo));
    const includeThumbnails = fpOptions.includeThumbnails;

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

    // Thumbnail Runbook picker: one presigned source and probe per invocation.
    // Candidates are pulled from the 360p reframe proxy when it exists (same
    // frame grid, much less to decode); the final frame comes from the source.
    const sceneNumberById = new Map(
      [...segments]
        .sort((a, b) => a.startTime - b.startTime)
        .map((s, i) => [s.id, i + 1] as const),
    );
    let sourceUrlPromise: Promise<string | null> | null = null;
    const getSourceUrl = () =>
      (sourceUrlPromise ??= sourceKey
        ? presignS3Uri(`s3://${BUCKET_NAME}/${sourceKey}`, 3600)
        : Promise.resolve(null));
    let sourceInfoPromise: Promise<SourceInfo> | null = null;
    const getSourceInfo = async () => {
      const url = await getSourceUrl();
      if (!url) throw new Error("Source video not found");
      return (sourceInfoPromise ??= probeSource(url));
    };
    let analysisUrlPromise: Promise<string | null> | null = null;
    const getAnalysisUrl = () =>
      (analysisUrlPromise ??= (async () => {
        const key = proxyKeyForAsset(assetId);
        try {
          await s3Client.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
          return await presignS3Uri(`s3://${BUCKET_NAME}/${key}`, 3600);
        } catch {
          return getSourceUrl();
        }
      })());
    const transcriptWords = transcript.map((t) => ({
      start: t.startTime,
      end: t.endTime,
      text: t.text,
    }));

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

        const existing = cacheById.get(seg.id);
        const missingOptions = computeMissingMetadataOptions(
          existing,
          fpOptions,
          seg.startTime,
          seg.endTime,
        );
        if (!missingOptions) return;

        // Pegasus only for what needs eyes on the clip. A scene missing just
        // its AEO fields (or thumbnail) never re-watches the video.
        let parsed: ParsedSegmentMetadata = {};
        const pegasusOptions = pegasusOptionsFor(missingOptions);
        if (pegasusOptions) {
          const clip = resolveClipForSegment(asset, seg.startTime, seg.endTime);
          parsed = await generateSegmentMetadata(client, clip, pegasusOptions);

          if (
            transcript.length > 0 &&
            parsed.descriptions &&
            pegasusOptions.includeDescriptions !== false
          ) {
            parsed = await enrichSegmentDescriptions({
              pegasus: parsed,
              transcript,
              segmentStart: seg.startTime,
              segmentEnd: seg.endTime,
              videoTitle,
              options: pegasusOptions,
            });
          }
        }

        const contentHash = computeSegmentMetadataFingerprint(
          seg.startTime,
          seg.endTime,
        );
        const sameBounds = existing?.contentHash === contentHash;

        // AEO reads the scene's descriptions, so it runs after them. A failure
        // here is reported but does not discard the descriptions just made.
        const wantTopics = aeoWantsIabTopics(missingOptions);
        let aeoUpdate: StoredSegmentMetadata["aeo"];
        if (aeoHasModelWork(missingOptions.aeo, wantTopics)) {
          try {
            const result = await generateSegmentAeo({
              options: missingOptions.aeo ?? {},
              wantIabTopics: wantTopics,
              show: showInfo,
              videoTitle,
              sceneTitle: seg.title,
              transcript,
              segmentStart: seg.startTime,
              segmentEnd: seg.endTime,
              descriptions: {
                ...(sameBounds ? existing?.descriptions : undefined),
                ...parsed.descriptions,
              },
              tags: {
                ...(sameBounds ? existing?.tags : undefined),
                ...parsed.tags,
              },
            });
            if (missingOptions.aeo) {
              aeoUpdate = {
                ...result.aeo,
                showInfoHash: missingOptions.aeo.showInfoHash ?? "",
              };
            }
            if (result.iab) {
              parsed.tags = {
                ...parsed.tags,
                iab: unionIab(parsed.tags?.iab, result.iab),
              };
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[ExportMetadata] AEO for segment ${seg.id} failed:`, msg);
            errors.push({
              segmentId: seg.id,
              error: `Search & AEO metadata failed: ${msg}`,
            });
          }
        }

        const entry: StoredSegmentMetadata = mergeSegmentMetadataEntry(
          existing,
          {
            segmentId: seg.id,
            contentHash,
            descriptions: parsed.descriptions,
            tags: parsed.tags,
            aeo: aeoUpdate,
            generatedAt: new Date().toISOString(),
          },
        );

        if (missingOptions.includeThumbnails && sourceKey) {
          const thumbKey = `thumbnails/projects/${projectId}/${seg.id}.jpg`;
          const legacyFrame = () =>
            extractFrameToS3({
              sourceBucket: BUCKET_NAME,
              sourceKey,
              timestampSec: segmentThumbnailTimestamp(seg.startTime),
              destBucket: BUCKET_NAME,
              destKey: thumbKey,
            });
          try {
            const sourceUrl = await getSourceUrl();
            const analysisUrl = await getAnalysisUrl();
            if (!sourceUrl || !analysisUrl) throw new Error("Source video not found");
            const desc = { ...(sameBounds ? existing?.descriptions : undefined), ...parsed.descriptions };
            const pick = await pickSceneThumbnail({
              analysisUrl,
              bucket: BUCKET_NAME,
              projectId,
              segmentId: seg.id,
              contentHash,
              sceneNumber: sceneNumberById.get(seg.id) ?? 0,
              sceneTitle: seg.title ?? "",
              sceneStart: seg.startTime,
              sceneEnd: seg.endTime,
              showTitle: showInfo.series || videoTitle || null,
              descriptions: [desc.paragraph || desc.two_sentences || desc.short || ""].filter(Boolean),
              transcriptWords,
            });
            const best = pick.candidates[pick.chosen];
            if (best) {
              pick.exported = await exportThumbnail({
                sourceUrl,
                source: await getSourceInfo(),
                time: best.time,
                face: best.face,
                bucket: BUCKET_NAME,
                key: thumbKey,
              });
              pick.flags.push(...exportFlags(pick.exported));
            } else {
              await legacyFrame();
              warnings.push({
                segmentId: seg.id,
                code: "THUMBNAIL_NEEDS_PICK",
                message: "No frame in this scene passed the thumbnail rules; it shows the frame 1 s in until someone picks one.",
              });
            }
            entry.thumbnailPick = pick;
            entry.thumbnailVersion = THUMBNAIL_PICK_VERSION;
            entry.thumbnailKey = thumbKey;
          } catch (err) {
            // Keep the scene exportable; version 1 means the picker retries next time.
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[ExportMetadata] Thumbnail pick for ${seg.id} failed:`, msg);
            await legacyFrame();
            entry.thumbnailKey = thumbKey;
            entry.thumbnailVersion = 1;
            warnings.push({
              segmentId: seg.id,
              code: "THUMBNAIL_PICK_FAILED",
              message: `Thumbnail selection failed (${msg}); used the frame 1 s in.`,
            });
          }
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

    // Thumbnail Runbook Step 6b/6c: balance the whole set once every scene has
    // its candidates, and only when they changed since the last pass.
    let thumbnailSet: StoredThumbnailSet | undefined;
    if (remaining.length === 0 && includeThumbnails && sourceKey) {
      const setScenes: SetPassScene[] = [];
      for (const seg of segments) {
        const m = mergedMetadata.find((x) => x.segmentId === seg.id);
        const pick = m?.thumbnailPick;
        if (!m || !pick || !m.thumbnailKey || pick.contentHash !== m.contentHash || pick.candidates.length === 0) continue;
        setScenes.push({ segmentId: seg.id, sceneNumber: sceneNumberById.get(seg.id) ?? 0, pick, thumbnailKey: m.thumbnailKey });
      }
      const previous = project.thumbnailSet as StoredThumbnailSet | undefined;
      if (setScenes.length >= 2 && previous?.fingerprint !== setFingerprint(setScenes)) {
        try {
          const sourceUrl = await getSourceUrl();
          if (!sourceUrl) throw new Error("Source video not found");
          const result = await runSetPass({
            scenes: setScenes,
            bucket: BUCKET_NAME,
            sourceUrl,
            source: await getSourceInfo(),
          });
          for (let i = 0; i < mergedMetadata.length; i++) {
            const updated = result.picks.get(mergedMetadata[i].segmentId);
            if (updated) mergedMetadata[i] = { ...mergedMetadata[i], thumbnailPick: updated };
          }
          thumbnailSet = result.set;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[ExportMetadata] Thumbnail set pass failed:", msg);
          warnings.push({
            segmentId: setScenes[0].segmentId,
            code: "THUMBNAIL_SET_FAILED",
            message: `Balancing the thumbnail set failed (${msg}); each scene keeps its own best frame.`,
          });
        }
      }
    }

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

    if (thumbnailSet) {
      updateParts.push("thumbnailSet = :thumbSet");
      exprValues[":thumbSet"] = thumbnailSet;
    }

    if (generatedUpdates.length > 0 || projectThumbnailKey || thumbnailSet) {
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

/**
 * POST /projects/{projectId}/thumbnail-choice {segmentId, candidate}
 * Human review (runbook Step 8): use another scored candidate, usually the
 * runner-up, as the scene's thumbnail. Re-exports the 1920×1080 image.
 */
async function handleThumbnailChoice(
  projectId: string,
  body: { segmentId?: string; candidate?: number },
) {
  const respond = (statusCode: number, payload: unknown) => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(payload),
  });
  const projectRes = await docClient.send(
    new GetCommand({ TableName: PROJECTS_TABLE, Key: { projectId }, ConsistentRead: true }),
  );
  const project = projectRes.Item;
  if (!project) return respond(404, { error: "Project not found" });
  const list = (project.segmentMetadata || []) as StoredSegmentMetadata[];
  const index = list.findIndex((m) => m.segmentId === body.segmentId);
  const entry = list[index];
  const pick = entry?.thumbnailPick;
  const k = Number(body.candidate);
  if (!entry || !pick || !entry.thumbnailKey || !(k >= 0 && k < pick.candidates.length)) {
    return respond(400, { error: "No such thumbnail candidate" });
  }
  if (k !== pick.chosen) {
    const assetRes = await docClient.send(
      new GetCommand({ TableName: ASSETS_TABLE, Key: { assetId: project.assetId } }),
    );
    const asset = assetRes.Item ?? {};
    const sourceKey =
      (typeof asset.s3Key === "string" && asset.s3Key) ||
      (typeof asset.s3VideoUrl === "string" && asset.s3VideoUrl.startsWith("s3://")
        ? asset.s3VideoUrl.replace("s3://", "").split("/").slice(1).join("/")
        : "");
    if (!sourceKey) return respond(400, { error: "Source video not found" });
    const sourceUrl = await presignS3Uri(`s3://${BUCKET_NAME}/${sourceKey}`, 3600);
    if (!sourceUrl) return respond(400, { error: "Source video not found" });
    const candidate = pick.candidates[k];
    const previous = pick.chosen;
    pick.exported = await exportThumbnail({
      sourceUrl,
      source: await probeSource(sourceUrl),
      time: candidate.time,
      face: candidate.face,
      bucket: BUCKET_NAME,
      key: entry.thumbnailKey,
    });
    pick.chosen = k;
    pick.runnerUp = previous;
    pick.flags = [
      ...pick.flags.filter((f) => !f.startsWith("human review:")),
      `human review: swapped to the frame at ${candidate.time.toFixed(2)}s`,
    ];
    await docClient.send(
      new UpdateCommand({
        TableName: PROJECTS_TABLE,
        Key: { projectId },
        UpdateExpression: `SET segmentMetadata[${index}].thumbnailPick = :pick, updatedAt = :now`,
        ConditionExpression: `segmentMetadata[${index}].segmentId = :sid`,
        ExpressionAttributeValues: {
          ":pick": pick,
          ":now": new Date().toISOString(),
          ":sid": entry.segmentId,
        },
      }),
    );
  }
  const { thumbnailKey: _tk, thumbnailPick: _tp, ...rest } = entry;
  return respond(200, {
    segment: {
      ...rest,
      thumbnailUrl: await signThumbnailKey(entry.thumbnailKey),
      thumbnailReview: await toThumbnailReview(pick, signThumbnailKey),
    },
  });
}

const handleApiRequest: APIGatewayProxyHandler = async (event) => {
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  const rawPath = String((event as { rawPath?: string }).rawPath ?? event.path ?? "");
  if (rawPath.endsWith("/thumbnail-choice")) {
    const projectId = event.pathParameters?.projectId;
    if (!projectId) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "Missing projectId" }) };
    }
    try {
      return await handleThumbnailChoice(projectId, JSON.parse(event.body || "{}"));
    } catch (err) {
      console.error("[ExportMetadata] thumbnail choice failed", err);
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: err instanceof Error ? err.message : "Thumbnail swap failed" }),
      };
    }
  }

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
    const showInfo = body.options?.aeo
      ? await readShowInfo(project.assetId as string | undefined)
      : {};
    const fpOptions = fingerprintOptions(body, computeShowInfoHash(showInfo));
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
