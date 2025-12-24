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
import { v4 as uuidv4 } from "uuid";
import { renderMediaOnLambda } from "@remotion/lambda/client";
import type { AwsRegion } from "@remotion/lambda";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});
const lambdaClient = new LambdaClient({});

const RENDER_JOBS_TABLE = process.env.RENDER_JOBS_TABLE!;
const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const REMOTION_SERVE_URL = process.env.REMOTION_SERVE_URL;
const REMOTION_FUNCTION_NAME = process.env.REMOTION_FUNCTION_NAME;
const STITCH_FUNCTION_NAME = process.env.STITCH_FUNCTION_NAME;

// Types
type AspectRatio = "9:16" | "1:1" | "16:9";

interface CaptionWord {
  start: number;
  end: number;
  value: string;
}

interface CaptionLine {
  id: string;
  startTime: number;
  endTime: number;
  text: string;
  words: CaptionWord[];
}

interface CaptionSettings {
  enabled: boolean;
  style: {
    fontSize: number;
    fontFamily: string;
    color: string;
    backgroundColor: string;
    position: { x: number; y: number };
    maxWidth: number;
    highlightColor?: string;
  };
}

interface GlobalFramingSettings {
  aspectRatio: AspectRatio;
  enabled: boolean;
}

interface Segment {
  id: string;
  startTime: number;
  endTime: number;
  title: string;
  framing?: {
    aspectRatio: AspectRatio;
    mode: "crop" | "fit";
    focusX: number;
    focusY: number;
    isAiGenerated: boolean;
  };
}

const DEFAULT_CAPTION_SETTINGS: CaptionSettings = {
  enabled: true,
  style: {
    fontSize: 2,
    fontFamily: "Inter, system-ui, sans-serif",
    color: "#ffffff",
    backgroundColor: "rgba(0, 0, 0, 0.8)",
    position: { x: 50, y: 85 },
    maxWidth: 95,
    highlightColor: "#fbbf24",
  },
};

const DEFAULT_GLOBAL_FRAMING: GlobalFramingSettings = {
  aspectRatio: "9:16",
  enabled: true,
};

/**
 * Groups word-level transcript into caption lines.
 */
function groupWordsIntoCaptions(words: CaptionWord[]): CaptionLine[] {
  if (!words?.length) return [];

  const captions: CaptionLine[] = [];
  let currentWords: CaptionWord[] = [];
  let lineStartTime = words[0].start;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const prevWord = i > 0 ? words[i - 1] : null;

    // Break on: 8+ words, 3+ seconds, or pause > 0.3s
    const shouldBreak =
      currentWords.length >= 8 ||
      (currentWords.length > 0 && word.end - lineStartTime > 3) ||
      (prevWord && word.start - prevWord.end > 0.3);

    if (shouldBreak && currentWords.length > 0) {
      captions.push({
        id: `caption-${captions.length}`,
        startTime: lineStartTime,
        endTime: currentWords[currentWords.length - 1].end,
        text: currentWords.map((w) => w.value).join(" "),
        words: [...currentWords],
      });
      currentWords = [];
      lineStartTime = word.start;
    }
    currentWords.push(word);
  }

  if (currentWords.length > 0) {
    captions.push({
      id: `caption-${captions.length}`,
      startTime: lineStartTime,
      endTime: currentWords[currentWords.length - 1].end,
      text: currentWords.map((w) => w.value).join(" "),
      words: currentWords,
    });
  }

  return captions;
}

function getCompositionId(aspectRatio: AspectRatio): string {
  switch (aspectRatio) {
    case "16:9": return "CaptionedVideo";
    case "1:1": return "CaptionedVideoSquare";
    default: return "CaptionedVideoPortrait";
  }
}

export const handler: APIGatewayProxyHandler = async (event) => {
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  const projectId = event.pathParameters?.projectId;
  if (!projectId) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Missing projectId" }),
    };
  }

  let body: { outputFormat?: "mp4" | "webm"; quality?: string };
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  // Get project
  const projectResult = await docClient.send(
    new GetCommand({ TableName: PROJECTS_TABLE, Key: { projectId } })
  );
  if (!projectResult.Item) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Project not found" }),
    };
  }

  const project = projectResult.Item;
  if (!project.assetId) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Project has no associated asset" }),
    };
  }

  // Get asset
  const assetResult = await docClient.send(
    new GetCommand({ TableName: ASSETS_TABLE, Key: { assetId: project.assetId } })
  );
  if (!assetResult.Item?.s3VideoUrl) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Asset has no video file" }),
    };
  }

  const asset = assetResult.Item;
  const { presignS3Uri } = await import("../utils/s3");
  const presignedVideoUrl = await presignS3Uri(asset.s3VideoUrl);

  if (!presignedVideoUrl) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Failed to generate video URL" }),
    };
  }

  // Read project data
  const segments: Segment[] = project.segments || [];
  const captionSettings: CaptionSettings = project.captionSettings || DEFAULT_CAPTION_SETTINGS;
  const globalFraming: GlobalFramingSettings = project.globalFraming || DEFAULT_GLOBAL_FRAMING;

  // Generate captions from transcription
  let captions: CaptionLine[] = [];
  if (asset.transcriptionUrl && captionSettings.enabled) {
    try {
      const transcriptionUrl = await presignS3Uri(asset.transcriptionUrl);
      if (transcriptionUrl) {
        const response = await fetch(transcriptionUrl);
        const data = await response.json();
        const jsonData = data as Record<string, unknown>;
        const words: CaptionWord[] = Array.isArray(data) 
          ? data as CaptionWord[]
          : (jsonData.data as CaptionWord[]) || (jsonData.transcription as CaptionWord[]) || [];
        captions = groupWordsIntoCaptions(words);
        console.log(`Generated ${captions.length} caption lines`);
      }
    } catch (error) {
      console.error("Failed to load transcription:", error);
    }
  }

  // Validate limits
  const totalDuration = segments.length > 0
    ? segments.reduce((sum, s) => sum + (s.endTime - s.startTime), 0)
    : asset.duration || 0;

  if (segments.length > 10) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Too many segments (max 10)" }),
    };
  }
  if (totalDuration > 600) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Video too long (max 10 minutes)" }),
    };
  }

  // Create render job
  const jobId = uuidv4();
  const needsStitching = segments.length > 0 && STITCH_FUNCTION_NAME;
  const compositionId = getCompositionId(globalFraming.aspectRatio);

  const renderJob = {
    jobId,
    projectId,
    status: needsStitching ? "pending_stitch" : "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
    progress: 0,
    totalDuration,
    sourceS3Uri: asset.s3VideoUrl,
    originalSegments: segments,
    inputProps: {
      videoUrl: presignedVideoUrl,
      captions,
      captionSettings,
      globalFraming,
    },
    compositionId,
    outputFormat: body.outputFormat || "mp4",
  };

  await docClient.send(new PutCommand({ TableName: RENDER_JOBS_TABLE, Item: renderJob }));

  // If stitching needed, invoke stitch Lambda
  if (needsStitching) {
    console.log(`Invoking stitch Lambda for job ${jobId}`);
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: STITCH_FUNCTION_NAME,
        InvocationType: "Event",
        Payload: JSON.stringify({ pathParameters: { jobId } }),
      })
    );

    return {
      statusCode: 202,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        jobId,
        status: "pending_stitch",
        message: "Stitching segments before rendering",
      }),
    };
  }

  // No stitching - render directly
  if (!REMOTION_SERVE_URL || !REMOTION_FUNCTION_NAME) {
    return {
      statusCode: 202,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ jobId, status: "pending", message: "Remotion not configured" }),
    };
  }

  try {
    const renderResponse = await renderMediaOnLambda({
      region: process.env.AWS_REGION_NAME as AwsRegion,
      functionName: REMOTION_FUNCTION_NAME,
      serveUrl: REMOTION_SERVE_URL,
      composition: compositionId,
      inputProps: {
        videoUrl: presignedVideoUrl,
        segments: [],
        captions,
        captionSettings,
        globalFraming,
      },
      codec: body.outputFormat === "webm" ? "vp8" : "h264",
      outName: `${jobId}.${body.outputFormat || "mp4"}`,
      privacy: "no-acl",
      framesPerLambda: 150,
      imageFormat: "jpeg",
      jpegQuality: 80,
      concurrencyPerLambda: 1,
    });

    await docClient.send(
      new UpdateCommand({
        TableName: RENDER_JOBS_TABLE,
        Key: { jobId },
        UpdateExpression: "SET #status = :status, renderId = :renderId, bucketName = :bucketName, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "rendering",
          ":renderId": renderResponse.renderId,
          ":bucketName": renderResponse.bucketName,
          ":updatedAt": new Date().toISOString(),
        },
      })
    );

    return {
      statusCode: 202,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ jobId, status: "rendering", renderId: renderResponse.renderId }),
    };
  } catch (error) {
    console.error("Render failed:", error);
    await docClient.send(
      new UpdateCommand({
        TableName: RENDER_JOBS_TABLE,
        Key: { jobId },
        UpdateExpression: "SET #status = :status, #error = :error, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status", "#error": "error" },
        ExpressionAttributeValues: {
          ":status": "failed",
          ":error": error instanceof Error ? error.message : String(error),
          ":updatedAt": new Date().toISOString(),
        },
      })
    );

    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Render failed", details: error instanceof Error ? error.message : String(error) }),
    };
  }
};
