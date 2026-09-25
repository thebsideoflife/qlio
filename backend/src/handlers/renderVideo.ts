import type { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { checkAuth } from "../utils/auth";
import { resolveRenderTranscriptCandidates } from "../utils/transcript-source";
import {
  DEFAULT_CAPTION_SETTINGS,
  mergeCaptionSettings,
  type CaptionSettings,
  type CaptionSettingsPatch,
} from "../utils/caption-settings";
import { v4 as uuidv4 } from "uuid";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});
const lambdaClient = new LambdaClient({});

const RENDER_JOBS_TABLE = process.env.RENDER_JOBS_TABLE!;
const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const STITCH_FUNCTION_NAME = process.env.STITCH_FUNCTION_NAME!;

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

  // Read project data. Client captionSettings win when the editor just
  // toggled language / edits and autosave has not flushed yet.
  let segments: Segment[] = project.segments || [];
  const captionSettings: CaptionSettings = mergeCaptionSettings(
    mergeCaptionSettings(DEFAULT_CAPTION_SETTINGS, project.captionSettings),
    body.captionSettings,
  );
  const globalFraming: GlobalFramingSettings =
    project.globalFraming || DEFAULT_GLOBAL_FRAMING;

  // Filter to specific segments if segmentIds provided
  if (body.segmentIds && body.segmentIds.length > 0) {
    const requestedIds = new Set(body.segmentIds);
    segments = segments.filter((s) => requestedIds.has(s.id));
    console.log(
      `Filtering to ${segments.length} of ${
        project.segments?.length || 0
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

  // Validate limits
  const totalDuration = segments.reduce(
    (sum, s) => sum + (s.endTime - s.startTime),
    0,
  );

  if (segments.length > 30) {
    return {
      statusCode: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Too many segments (max 30)" }),
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
    globalFraming.squareTop,
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

  const renderJob = {
    jobId,
    projectId,
    status: "rendering",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
    progress: 0,
    totalDuration,
    outputFormat,
    compositionId,
    sourceS3Uri: asset.s3VideoUrl,
    transcriptionS3Uri,
    transcriptionCandidates,
    transcriptionVersion:
      typeof asset.transcriptionVersion === "string"
        ? asset.transcriptionVersion
        : undefined,
    segments,
    captionSettings,
    globalFraming,
  };

  await docClient.send(
    new PutCommand({ TableName: RENDER_JOBS_TABLE, Item: renderJob }),
  );

  // Track active render job on project for refresh recovery
  await docClient.send(
    new UpdateCommand({
      TableName: PROJECTS_TABLE,
      Key: { projectId },
      UpdateExpression: "SET activeRenderJobId = :jobId, updatedAt = :now",
      ExpressionAttributeValues: {
        ":jobId": jobId,
        ":now": new Date().toISOString(),
      },
    }),
  );

  // Invoke FFmpeg Lambda to cut clips and start Remotion renders
  console.log(
    `Invoking cutSegments for job ${jobId} with ${segments.length} segments`,
  );

  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: STITCH_FUNCTION_NAME,
      InvocationType: "Event", // async — don't wait
      Payload: JSON.stringify({ jobId }),
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
      message: `Started ${segments.length} segment renders`,
    }),
  };
};
