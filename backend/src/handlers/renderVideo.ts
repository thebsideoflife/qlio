import type { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { checkAuth } from "../utils/auth";
import { resolveRenderTranscriptCandidates } from "../utils/transcript-source";
import {
  DEFAULT_CAPTION_SETTINGS,
  mergeCaptionSettings,
  type CaptionSettings,
  type CaptionSettingsPatch,
} from "../utils/caption-settings";
import { v4 as uuidv4 } from "uuid";
import {
  computeSegmentRenderFingerprint,
  RENDER_PIPELINE_VERSION,
} from "../utils/segmentRenderFingerprint";
import {
  isRenderJobExpired,
  planSegmentReuse,
  type StoredRender,
} from "../utils/renderReuse";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});
const lambdaClient = new LambdaClient({});
const s3Client = new S3Client({ maxAttempts: 5 });

const RENDER_JOBS_TABLE = process.env.RENDER_JOBS_TABLE!;
const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const STITCH_FUNCTION_NAME = process.env.STITCH_FUNCTION_NAME!;
const MAX_SEGMENTS = 60;

// Types
type AspectRatio = "9:16" | "1:1" | "16:9";

interface GlobalFramingSettings {
  aspectRatio: AspectRatio;
  enabled: boolean;
  // Square-top portrait mode (mirrors zeevee/src/remotion/types). When true,
  // CaptionedVideo renders the source as a 1:1 square at the top of the
  // portrait frame. Only honored when enabled === true.
  squareTop?: boolean;
}

interface SegmentFraming {
  aspectRatio: AspectRatio;
  mode: "crop" | "fit";
  focusX: number;
  focusY: number;
  isAiGenerated: boolean;
}

interface Segment {
  id: string;
  startTime: number;
  endTime: number;
  title: string;
  framing?: SegmentFraming;
}

const DEFAULT_GLOBAL_FRAMING: GlobalFramingSettings = {
  aspectRatio: "9:16",
  enabled: true,
  squareTop: false,
};

// Square-top portrait mode always renders the 9:16 portrait composition,
// regardless of the stored aspect ratio.
function getCompositionId(
  aspectRatio: AspectRatio,
  squareTop?: boolean,
): string {
  if (squareTop) return "CaptionedVideoPortrait";
  switch (aspectRatio) {
    case "16:9":
      return "CaptionedVideo";
    case "1:1":
      return "CaptionedVideoSquare";
    default:
      return "CaptionedVideoPortrait";
  }
}

/**
 * The project's in-flight export, if any. A project runs at most one export at
 * a time and `activeRenderJobId` always names it, so every running job is one
 * the export page can find and poll to completion.
 */
async function findRunningJob(
  activeRenderJobId: unknown,
): Promise<{ jobId: string; segmentCount: number } | null> {
  if (typeof activeRenderJobId !== "string" || !activeRenderJobId) return null;
  const result = await docClient.send(
    new GetCommand({
      TableName: RENDER_JOBS_TABLE,
      Key: { jobId: activeRenderJobId },
      ProjectionExpression: "jobId, #status, createdAt, segmentRenders",
      ExpressionAttributeNames: { "#status": "status" },
    }),
  );
  const job = result.Item;
  if (!job || job.status !== "rendering") return null;
  // Past the ceiling it's failed on its next poll; never let it block.
  if (isRenderJobExpired(job.createdAt)) return null;
  return {
    jobId: activeRenderJobId,
    segmentCount: Array.isArray(job.segmentRenders)
      ? job.segmentRenders.length
      : 0,
  };
}

function exportInProgressResponse(running: {
  jobId: string;
  segmentCount: number;
}) {
  return {
    statusCode: 409,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify({
      error: "An export is already running for this project",
      code: "EXPORT_IN_PROGRESS",
      jobId: running.jobId,
      status: "rendering",
      segmentCount: running.segmentCount,
      renderPipelineVersion: RENDER_PIPELINE_VERSION,
    }),
  };
}

export const handler: APIGatewayProxyHandler = async (event) => {
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  const projectId = event.pathParameters?.projectId;
  if (!projectId) {
    return {
      statusCode: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Missing projectId" }),
    };
  }

  let body: {
    outputFormat?: "mp4" | "webm";
    quality?: string;
    segmentIds?: string[];
    captionSettings?: CaptionSettingsPatch;
    segments?: Segment[];
    globalFraming?: GlobalFramingSettings;
    /** Render even when a matching render is already stored. */
    force?: boolean;
  };
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  // Get project
  const projectResult = await docClient.send(
    new GetCommand({ TableName: PROJECTS_TABLE, Key: { projectId } }),
  );
  if (!projectResult.Item) {
    return {
      statusCode: 404,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Project not found" }),
    };
  }

  const project = projectResult.Item;
  if (!project.assetId) {
    return {
      statusCode: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Project has no associated asset" }),
    };
  }

  // Get asset
  const assetResult = await docClient.send(
    new GetCommand({
      TableName: ASSETS_TABLE,
      Key: { assetId: project.assetId },
    }),
  );
  if (!assetResult.Item?.s3VideoUrl) {
    return {
      statusCode: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Asset has no video file" }),
    };
  }

  const asset = assetResult.Item;

  // Capture the editor's preview inputs in the render job. An older autosave
  // can finish after Export's flush and otherwise change the DB read below.
  let segments: Segment[] = Array.isArray(body.segments)
    ? body.segments
    : project.segments || [];
  const captionSettings: CaptionSettings = mergeCaptionSettings(
    mergeCaptionSettings(DEFAULT_CAPTION_SETTINGS, project.captionSettings),
    body.captionSettings,
  );
  const globalFraming: GlobalFramingSettings =
    body.globalFraming || project.globalFraming || DEFAULT_GLOBAL_FRAMING;

  // Filter to specific segments if segmentIds provided
  if (body.segmentIds && body.segmentIds.length > 0) {
    const requestedIds = new Set(body.segmentIds);
    const totalSegments = segments.length;
    segments = segments.filter((s) => requestedIds.has(s.id));
    console.log(
      `Filtering to ${segments.length} of ${
        totalSegments
      } segments`,
    );
  }

  // Validate we have segments to render
  if (segments.length === 0) {
    return {
      statusCode: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "No segments to render" }),
    };
  }

  const transcriptionVersion =
    typeof asset.transcriptionVersion === "string"
      ? asset.transcriptionVersion
      : undefined;

  // Reuse stored renders whose inputs still match. The server decides, so a
  // browser running an older bundle can't force needless re-renders.
  const plan = body.force
    ? { reuse: [], render: segments }
    : planSegmentReuse(
        segments,
        project.segmentRenders as StoredRender[] | undefined,
        (segment) =>
          computeSegmentRenderFingerprint(
            segment,
            captionSettings,
            globalFraming,
            transcriptionVersion,
          ),
      );
  const reused = (
    await Promise.all(
      plan.reuse.map(async (item) => {
        try {
          await s3Client.send(
            new HeadObjectCommand({
              Bucket: item.stored.bucket,
              Key: item.stored.key,
            }),
          );
          return item;
        } catch {
          return null;
        }
      }),
    )
  ).filter((item): item is NonNullable<typeof item> => item !== null);
  const reusedIds = new Set(reused.map((item) => item.segment.id));
  const segmentsToRender = segments.filter((s) => !reusedIds.has(s.id));
  console.log(
    `Render plan: reuse ${reused.length}, render ${segmentsToRender.length}`,
  );

  // Hand back the running export instead of starting a second one (another
  // tab, a double click, or a scene re-render while an export is running).
  // A request that renders nothing needs no slot, so it is never blocked.
  if (segmentsToRender.length > 0) {
    const running = await findRunningJob(project.activeRenderJobId);
    if (running) return exportInProgressResponse(running);
  }

  // Validate limits
  const totalDuration = segmentsToRender.reduce(
    (sum, s) => sum + (s.endTime - s.startTime),
    0,
  );

  // Render load is bounded by total duration below; the count cap only guards
  // against runaway requests. Each segment adds ~2 Remotion Lambdas (orchestrator
  // + chunk rounding); at the duration cap 60 keeps a render under ~850 of the
  // account's 1,000 concurrent Lambdas.
  if (segmentsToRender.length > MAX_SEGMENTS) {
    return {
      statusCode: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        error: `Too many segments (max ${MAX_SEGMENTS})`,
      }),
    };
  }
  if (totalDuration > 7200) {
    return {
      statusCode: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        error: "Total duration too long (max 120 minutes)",
      }),
    };
  }

  const jobId = uuidv4();
  const outputFormat = body.outputFormat || "mp4";
  const compositionId = getCompositionId(
    globalFraming.aspectRatio,
    globalFraming.enabled && globalFraming.squareTop,
  );

  // Create render job with all data the cutSegments handler needs
  const translations =
    asset.translations && typeof asset.translations === "object"
      ? (asset.translations as Record<string, string>)
      : {};
  const transcriptionCandidates = resolveRenderTranscriptCandidates({
    assetId: typeof asset.assetId === "string" ? asset.assetId : project.assetId,
    activeLanguage: captionSettings.activeLanguage,
    originalLanguage:
      typeof asset.originalLanguage === "string"
        ? asset.originalLanguage
        : undefined,
    transcriptionVersion:
      typeof asset.transcriptionVersion === "string"
        ? asset.transcriptionVersion
        : undefined,
    translations,
    transcriptionUrl:
      typeof asset.transcriptionUrl === "string"
        ? asset.transcriptionUrl
        : null,
  });
  const transcriptionS3Uri = transcriptionCandidates[0] || null;
  console.log(
    `Render ${jobId} captions: language=${captionSettings.activeLanguage || "original"} uris=${transcriptionCandidates.join(",")}`,
  );

  const now = new Date().toISOString();
  const renderJob = {
    jobId,
    renderPipelineVersion: RENDER_PIPELINE_VERSION,
    projectId,
    status: "rendering" as "rendering" | "completed",
    createdAt: now,
    updatedAt: now,
    expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
    progress: 0,
    totalDuration,
    outputFormat,
    compositionId,
    sourceS3Uri: asset.s3VideoUrl,
    transcriptionS3Uri,
    transcriptionCandidates,
    transcriptionVersion,
    segments,
    captionSettings,
    globalFraming,
    // Reused scenes are done already; the rest wait for cutSegments to
    // replace their placeholder with a Remotion render ID.
    segmentRenders: segments.map((segment) => {
      const reuse = reused.find((item) => item.segment.id === segment.id);
      return reuse
        ? {
            segmentId: segment.id,
            title: segment.title,
            renderId: "",
            bucketName: reuse.stored.bucket!,
            outputKey: reuse.stored.key!,
            status: "completed" as const,
            reused: true,
            attempts: 0,
          }
        : {
            segmentId: segment.id,
            title: segment.title,
            renderId: "",
            bucketName: "",
            outputKey: "",
            status: "rendering" as const,
            attempts: 1,
            launchRequestedAt: now,
          };
    }),
    rev: 0,
  };
  if (segmentsToRender.length === 0) {
    renderJob.status = "completed";
    renderJob.progress = 100;
  }

  await docClient.send(
    new PutCommand({ TableName: RENDER_JOBS_TABLE, Item: renderJob }),
  );

  if (segmentsToRender.length === 0) {
    return {
      statusCode: 202,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        jobId,
        status: "completed",
        segmentCount: segments.length,
        reusedCount: reused.length,
        renderPipelineVersion: RENDER_PIPELINE_VERSION,
        message: "All selected scenes are already rendered",
      }),
    };
  }

  // Claim the project's single export slot. The condition makes the check
  // above atomic: if another request claimed it since we read the project,
  // this job never launches and the caller attaches to the winner.
  const previousActiveJobId =
    typeof project.activeRenderJobId === "string"
      ? project.activeRenderJobId
      : null;
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: PROJECTS_TABLE,
        Key: { projectId },
        UpdateExpression: "SET activeRenderJobId = :jobId, updatedAt = :now",
        // An empty slot is always claimable: the previous job may have
        // finished and released it since we read the project.
        ConditionExpression: previousActiveJobId
          ? "attribute_not_exists(activeRenderJobId) OR activeRenderJobId = :previous"
          : "attribute_not_exists(activeRenderJobId)",
        ExpressionAttributeValues: {
          ":jobId": jobId,
          ":now": new Date().toISOString(),
          ...(previousActiveJobId ? { ":previous": previousActiveJobId } : {}),
        },
      }),
    );
  } catch (error) {
    if ((error as { name?: string }).name !== "ConditionalCheckFailedException") {
      throw error;
    }
    await docClient.send(
      new UpdateCommand({
        TableName: RENDER_JOBS_TABLE,
        Key: { jobId },
        UpdateExpression:
          "SET #status = :failed, #error = :error, updatedAt = :now",
        ExpressionAttributeNames: { "#status": "status", "#error": "error" },
        ExpressionAttributeValues: {
          ":failed": "failed",
          ":error": "Superseded by a concurrent export",
          ":now": new Date().toISOString(),
        },
      }),
    );
    const latest = await docClient.send(
      new GetCommand({
        TableName: PROJECTS_TABLE,
        Key: { projectId },
        ProjectionExpression: "activeRenderJobId",
      }),
    );
    const winner = await findRunningJob(latest.Item?.activeRenderJobId);
    if (winner) return exportInProgressResponse(winner);
    return {
      statusCode: 409,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        error: "Another export just started for this project. Try again.",
      }),
    };
  }

  // Invoke FFmpeg Lambda to cut clips and start Remotion renders
  console.log(
    `Invoking cutSegments for job ${jobId} with ${segmentsToRender.length} segments`,
  );

  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: STITCH_FUNCTION_NAME,
      InvocationType: "Event", // async — don't wait
      Payload: JSON.stringify({
        jobId,
        segmentIds: segmentsToRender.map((s) => s.id),
      }),
    }),
  );

  return {
    statusCode: 202,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify({
      jobId,
      status: "rendering",
      segmentCount: segments.length,
      reusedCount: reused.length,
      renderPipelineVersion: RENDER_PIPELINE_VERSION,
      message: `Started ${segmentsToRender.length} segment renders`,
    }),
  };
};
