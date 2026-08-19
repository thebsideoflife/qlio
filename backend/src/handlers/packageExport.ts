import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Handler,
} from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { PassThrough, type Readable } from "stream";
import archiver from "archiver";
import { checkAuth } from "../utils/auth";
import {
  buildExportPackageLayout,
  exportPackageObjectKey,
  localizeExportMetadataDocument,
} from "../utils/exportPackageLayout";
import { computeExportPackageFingerprint } from "../utils/exportPackageFingerprint";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});
const lambdaClient = new LambdaClient({});

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const MEDIA_BUCKET = process.env.BUCKET_NAME!;
const RENDERS_BUCKET = process.env.RENDERS_BUCKET!;
const SELF_FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME!;
const PRESIGN_TTL_SEC = 43_200;
const IN_FLIGHT_JOB_MAX_MS = 15 * 60 * 1000;

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

type PackageStatus = "pending" | "packaging" | "completed" | "failed";

interface ExportPackageJob {
  status: PackageStatus;
  jobId: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
  warnings?: string[];
  bucket?: string;
  key?: string;
  filename?: string;
  fingerprint?: string;
}

interface RequestBody {
  segmentIds?: string[];
  includeThumbnails?: boolean;
  includePoster?: boolean;
  projectTitle?: string;
  metadataDocument?: {
    projectThumbnailUrl?: string | null;
    scenes: Array<{ segmentId: string; thumbnailUrl?: string | null }>;
    [key: string]: unknown;
  } | null;
}

interface AsyncJobPayload {
  kind: "package-export-worker";
  projectId: string;
  jobId: string;
  body: RequestBody;
  fingerprint: string;
  renderSnapshot: StoredSegmentRender[];
}

interface StoredSegmentRender {
  segmentId: string;
  title?: string;
  bucket: string;
  key: string;
  renderedAt?: string;
  contentHash?: string;
  sourceBucket?: string;
  sourceKey?: string;
}

interface StoredSegmentMetadata {
  segmentId: string;
  thumbnailKey?: string;
}

function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}

async function presignPackage(
  bucket: string,
  key: string,
  filename: string,
): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, "")}"`,
    }),
    { expiresIn: PRESIGN_TTL_SEC },
  );
}

async function objectExists(bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function readJob(projectId: string): Promise<ExportPackageJob | undefined> {
  const result = await dynamo.send(
    new GetCommand({
      TableName: PROJECTS_TABLE,
      Key: { projectId },
      ProjectionExpression: "exportPackageJob",
    }),
  );
  return result.Item?.exportPackageJob as ExportPackageJob | undefined;
}

async function writeJob(
  projectId: string,
  job: ExportPackageJob,
  expectedJobId?: string,
): Promise<void> {
  await dynamo.send(
    new UpdateCommand({
      TableName: PROJECTS_TABLE,
      Key: { projectId },
      UpdateExpression: "SET exportPackageJob = :job, updatedAt = :now",
      ...(expectedJobId
        ? {
            ConditionExpression: "exportPackageJob.jobId = :expectedJobId",
            ExpressionAttributeValues: {
              ":job": job,
              ":now": new Date().toISOString(),
              ":expectedJobId": expectedJobId,
            },
          }
        : {
            ExpressionAttributeValues: {
              ":job": job,
              ":now": new Date().toISOString(),
            },
          }),
    }),
  );
}

async function jobResponse(job: ExportPackageJob) {
  let downloadUrl: string | undefined;
  if (job.status === "completed" && job.bucket && job.key && job.filename) {
    downloadUrl = await presignPackage(job.bucket, job.key, job.filename);
  }
  return {
    status: job.status,
    jobId: job.jobId,
    filename: job.filename,
    downloadUrl,
    error: job.error,
    warnings: job.warnings,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
}

async function handleGet(
  projectId: string,
): Promise<APIGatewayProxyResult> {
  const job = await readJob(projectId);
  if (!job) return json(404, { error: "No export package job found" });
  return json(200, await jobResponse(job));
}

async function handleStart(
  projectId: string,
  body: RequestBody,
): Promise<APIGatewayProxyResult> {
  const project = (
    await dynamo.send(
      new GetCommand({ TableName: PROJECTS_TABLE, Key: { projectId } }),
    )
  ).Item;
  if (!project) return json(404, { error: "Project not found" });

  const effectiveBody: RequestBody = {
    ...body,
    projectTitle:
      body.projectTitle ||
      (typeof project.title === "string" ? project.title : "Untitled"),
  };
  const renderSnapshot = (project.segmentRenders || []) as StoredSegmentRender[];
  const fingerprint = computeExportPackageFingerprint(
    effectiveBody,
    renderSnapshot,
  );
  const existing = project.exportPackageJob as ExportPackageJob | undefined;
  if (
    existing?.status === "completed" &&
    existing.fingerprint === fingerprint &&
    existing.bucket &&
    existing.key &&
    (await objectExists(existing.bucket, existing.key))
  ) {
    return json(200, await jobResponse(existing));
  }
  if (
    existing &&
    (existing.status === "pending" || existing.status === "packaging") &&
    existing.fingerprint === fingerprint &&
    existing.startedAt &&
    Date.now() - new Date(existing.startedAt).getTime() < IN_FLIGHT_JOB_MAX_MS
  ) {
    return json(202, await jobResponse(existing));
  }

  const jobId = randomUUID();
  const startedAt = new Date().toISOString();
  const job: ExportPackageJob = {
    status: "pending",
    jobId,
    startedAt,
    fingerprint,
  };
  await writeJob(projectId, job);

  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: SELF_FUNCTION_NAME,
      InvocationType: "Event",
      Payload: JSON.stringify({
        kind: "package-export-worker",
        projectId,
        jobId,
        body: effectiveBody,
        fingerprint,
        renderSnapshot,
      } satisfies AsyncJobPayload),
    }),
  );

  return json(202, await jobResponse(job));
}

async function appendS3Object(
  archive: archiver.Archiver,
  bucket: string,
  key: string,
  zipPath: string,
  store: boolean,
): Promise<void> {
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!obj.Body) throw new Error(`Empty object s3://${bucket}/${key}`);
  const body = obj.Body as Readable;
  await new Promise<void>((resolve, reject) => {
    body.once("error", reject);
    body.once("end", resolve);
    archive.append(body, { name: zipPath, store });
  });
}

async function runWorker(event: AsyncJobPayload): Promise<void> {
  const { projectId, jobId, body, fingerprint, renderSnapshot } = event;
  const warnings: string[] = [];

  const markFailed = async (error: string) => {
    await writeJob(
      projectId,
      {
        status: "failed",
        jobId,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error,
        warnings,
        fingerprint,
      },
      jobId,
    ).catch((err) => console.error("[packageExport] failed to mark failed", err));
  };

  try {
    await writeJob(
      projectId,
      {
        status: "packaging",
        jobId,
        startedAt: new Date().toISOString(),
        fingerprint,
      },
      jobId,
    );

    const project = (
      await dynamo.send(
        new GetCommand({ TableName: PROJECTS_TABLE, Key: { projectId } }),
      )
    ).Item;
    if (!project) {
      await markFailed("Project not found");
      return;
    }

    const segments = (project.segments || []) as Array<{
      id: string;
      title?: string;
    }>;
    const requested = new Set(
      (body.segmentIds?.length ? body.segmentIds : segments.map((s) => s.id)),
    );
    const selected = segments.filter((s) => requested.has(s.id));
    if (selected.length === 0) {
      await markFailed("No scenes selected");
      return;
    }

    const renders = new Map(
      renderSnapshot.map((render) => [render.segmentId, render]),
    );
    const metadata = new Map(
      ((project.segmentMetadata || []) as StoredSegmentMetadata[]).map((m) => [
        m.segmentId,
        m,
      ]),
    );

    const projectTitle =
      body.projectTitle ||
      (typeof project.title === "string" ? project.title : "Untitled");
    const includeThumbnails = body.includeThumbnails !== false;
    const includePoster = body.includePoster !== false;
    const layout = buildExportPackageLayout({
      projectTitle,
      scenes: selected.map((s) => ({
        segmentId: s.id,
        title: s.title || "scene",
      })),
    });

    const zipKey = exportPackageObjectKey(projectId, jobId);
    const zipStream = new PassThrough();
    const archive = archiver("zip", { zlib: { level: 0 } });
    archive.on("warning", (err) => {
      if (err.code === "ENOENT") warnings.push(err.message);
      else throw err;
    });
    archive.pipe(zipStream);

    const upload = new Upload({
      client: s3,
      params: {
        Bucket: RENDERS_BUCKET,
        Key: zipKey,
        Body: zipStream,
        ContentType: "application/zip",
        ContentDisposition: `attachment; filename="${layout.zipFilename.replace(/"/g, "")}"`,
      },
    });
    const uploadDone = upload.done();

    let requiredVideos = 0;
    for (const scene of layout.scenes) {
      const render = renders.get(scene.segmentId);
      const renderBucket = render?.sourceBucket || render?.bucket;
      const renderKey = render?.sourceKey || render?.key;
      if (!renderBucket || !renderKey) {
        warnings.push(`No rendered video for ${scene.videoFilename}`);
        continue;
      }
      await appendS3Object(
        archive,
        renderBucket,
        renderKey,
        scene.videoPath,
        true,
      );
      requiredVideos += 1;
    }
    if (requiredVideos === 0) {
      archive.abort();
      zipStream.destroy();
      await upload.abort().catch(() => undefined);
      await markFailed("No rendered scene videos are ready to download.");
      return;
    }

    const includedThumbs = new Set<string>();
    if (includeThumbnails) {
      for (const scene of layout.scenes) {
        const key = metadata.get(scene.segmentId)?.thumbnailKey;
        if (!key) continue;
        try {
          await appendS3Object(
            archive,
            MEDIA_BUCKET,
            key,
            scene.thumbnailPath,
            false,
          );
          includedThumbs.add(scene.segmentId);
        } catch (err) {
          warnings.push(
            `Skipped ${scene.thumbnailFilename}: ${err instanceof Error ? err.message : "download failed"}`,
          );
        }
      }

      const posterKey =
        typeof project.thumbnailKey === "string" ? project.thumbnailKey : null;
      if (includePoster && posterKey) {
        try {
          await appendS3Object(
            archive,
            MEDIA_BUCKET,
            posterKey,
            layout.posterPath,
            false,
          );
        } catch (err) {
          warnings.push(
            `Skipped poster: ${err instanceof Error ? err.message : "download failed"}`,
          );
        }
      }
    }

    if (body.metadataDocument) {
      const localized = localizeExportMetadataDocument(
        body.metadataDocument,
        layout,
        {
          includePoster: includePoster && Boolean(project.thumbnailKey),
          includeThumbnails,
          includedThumbnailSegmentIds: includedThumbs,
        },
      );
      archive.append(JSON.stringify(localized, null, 2), {
        name: `${layout.rootFolder}/${layout.metadataFilename}`,
      });
    }

    await archive.finalize();
    await uploadDone;

    await writeJob(
      projectId,
      {
        status: "completed",
        jobId,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        bucket: RENDERS_BUCKET,
        key: zipKey,
        filename: layout.zipFilename,
        fingerprint,
        warnings: warnings.length ? warnings : undefined,
      },
      jobId,
    );
    console.log(
      `[packageExport] wrote s3://${RENDERS_BUCKET}/${zipKey} (${layout.zipFilename})`,
    );
  } catch (err) {
    console.error("[packageExport] worker failed", err);
    await markFailed(err instanceof Error ? err.message : "Packaging failed");
  }
}

async function handleApi(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  const projectId = event.pathParameters?.projectId;
  if (!projectId) return json(400, { error: "Missing projectId" });

  const method = event.requestContext?.http?.method || event.httpMethod;
  if (method === "GET") return handleGet(projectId);

  let body: RequestBody = {};
  try {
    body = JSON.parse(event.body || "{}") as RequestBody;
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  return handleStart(projectId, body);
}

export const handler: Handler<
  APIGatewayProxyEvent | AsyncJobPayload,
  APIGatewayProxyResult | void
> = async (event) => {
  if (event && typeof event === "object" && "kind" in event) {
    if ((event as AsyncJobPayload).kind === "package-export-worker") {
      await runWorker(event as AsyncJobPayload);
      return;
    }
  }
  return handleApi(event as APIGatewayProxyEvent);
};
