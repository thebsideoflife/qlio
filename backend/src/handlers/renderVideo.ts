import type { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { renderMediaOnLambda } from "@remotion/lambda/client";
import type { AwsRegion } from "@remotion/lambda";
import { checkAuth } from "../utils/auth";
import { v4 as uuidv4 } from "uuid";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});
const s3Client = new S3Client({});

const RENDER_JOBS_TABLE = process.env.RENDER_JOBS_TABLE!;
const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const REMOTION_SERVE_URL = process.env.REMOTION_SERVE_URL;
const REMOTION_FUNCTION_NAME = process.env.REMOTION_FUNCTION_NAME;
const AWS_REGION_NAME = process.env.AWS_REGION_NAME;

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

interface SegmentRender {
  segmentId: string;
  title: string;
  renderId: string;
  bucketName: string;
  outputKey: string; // Exact S3 key - no parsing needed
  status: "rendering" | "completed" | "failed";
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

/**
 * Filters captions to only those within a segment's time range.
 */
function filterCaptions(
  captions: CaptionLine[],
  segmentStart: number,
  segmentEnd: number
): CaptionLine[] {
  return captions.filter(
    (c) => c.startTime >= segmentStart && c.startTime < segmentEnd
  );
}

function sanitizeFilename(title: string): string {
  return (
    title
      .replace(/[^a-zA-Z0-9\s-_]/g, "")
      .replace(/\s+/g, "_")
      .substring(0, 50)
      .trim() || "segment"
  );
}

function parseS3Uri(uri: string): { bucket: string; key: string } {
  const match = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`Invalid S3 URI: ${uri}`);
  return { bucket: match[1], key: match[2] };
}

function getCompositionId(aspectRatio: AspectRatio): string {
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
    new GetCommand({ TableName: PROJECTS_TABLE, Key: { projectId } })
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
    })
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

  // Read project data
  let segments: Segment[] = project.segments || [];
  const captionSettings: CaptionSettings =
    project.captionSettings || DEFAULT_CAPTION_SETTINGS;
  const globalFraming: GlobalFramingSettings =
    project.globalFraming || DEFAULT_GLOBAL_FRAMING;

  // Filter to specific segments if segmentIds provided
  if (body.segmentIds && body.segmentIds.length > 0) {
    const requestedIds = new Set(body.segmentIds);
    segments = segments.filter((s) => requestedIds.has(s.id));
    console.log(
      `Filtering to ${segments.length} of ${
        project.segments?.length || 0
      } segments`
    );
  }

  // Generate captions from transcription
  let captions: CaptionLine[] = [];
  if (asset.transcriptionUrl && captionSettings.enabled) {
    try {
      const { presignS3Uri } = await import("../utils/s3");
      const transcriptionUrl = await presignS3Uri(asset.transcriptionUrl);
      if (transcriptionUrl) {
        const response = await fetch(transcriptionUrl);
        const data = await response.json();
        const jsonData = data as Record<string, unknown>;
        const words: CaptionWord[] = Array.isArray(data)
          ? (data as CaptionWord[])
          : (jsonData.data as CaptionWord[]) ||
            (jsonData.transcription as CaptionWord[]) ||
            [];
        captions = groupWordsIntoCaptions(words);
        console.log(`Generated ${captions.length} caption lines`);
      }
    } catch (error) {
      console.error("Failed to load transcription:", error);
    }
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
    0
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

  // Check Remotion config
  if (!REMOTION_SERVE_URL || !REMOTION_FUNCTION_NAME || !AWS_REGION_NAME) {
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Remotion not configured" }),
    };
  }

  const jobId = uuidv4();
  const outputFormat = body.outputFormat || "mp4";

  // Create render job
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
  };

  await docClient.send(
    new PutCommand({ TableName: RENDER_JOBS_TABLE, Item: renderJob })
  );

  try {
    // Generate presigned URL for the original video (7 days)
    const { bucket, key } = parseS3Uri(asset.s3VideoUrl);
    const videoUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: 604800 }
    );

    const compositionId = getCompositionId(globalFraming.aspectRatio);

    // Spawn all Remotion renders in parallel
    console.log(
      `Starting ${segments.length} Remotion renders for job ${jobId}`
    );

    const renderPromises = segments.map(async (segment) => {
      const segmentCaptions = filterCaptions(
        captions,
        segment.startTime,
        segment.endTime
      );

      const segmentFraming: SegmentFraming = segment.framing || {
        aspectRatio: globalFraming.aspectRatio,
        mode: "crop",
        focusX: 0.5,
        focusY: 0.5,
        isAiGenerated: false,
      };

      const sanitizedTitle = sanitizeFilename(segment.title);
      const outName = `${jobId}/${sanitizedTitle}.${outputFormat}`;

      const renderResponse = await renderMediaOnLambda({
        region: AWS_REGION_NAME as AwsRegion,
        functionName: REMOTION_FUNCTION_NAME,
        serveUrl: REMOTION_SERVE_URL,
        composition: compositionId,
        inputProps: {
          videoUrl,
          segments: [
            {
              id: segment.id,
              startTime: segment.startTime,
              endTime: segment.endTime,
              title: segment.title,
              framing: segmentFraming,
            },
          ],
          captions: segmentCaptions,
          captionSettings,
          globalFraming: {
            ...globalFraming,
            enabled: true,
          },
        },
        codec: outputFormat === "webm" ? "vp8" : "h264",
        outName,
        privacy: "no-acl",
        framesPerLambda: 300,
        imageFormat: "jpeg",
        jpegQuality: 80,
        concurrencyPerLambda: 1,
      });

      const outputKey = `renders/${renderResponse.renderId}/${outName}`;
      return {
        segmentId: segment.id,
        title: segment.title,
        renderId: renderResponse.renderId,
        bucketName: renderResponse.bucketName,
        outputKey,
        status: "rendering" as const,
      };
    });

    const segmentRenders: SegmentRender[] = await Promise.all(renderPromises);

    // Update job with segment renders
    await docClient.send(
      new UpdateCommand({
        TableName: RENDER_JOBS_TABLE,
        Key: { jobId },
        UpdateExpression:
          "SET segmentRenders = :segmentRenders, updatedAt = :updatedAt",
        ExpressionAttributeValues: {
          ":segmentRenders": segmentRenders,
          ":updatedAt": new Date().toISOString(),
        },
      })
    );

    console.log(
      `Started ${segmentRenders.length} Remotion renders for job ${jobId}`
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
  } catch (error) {
    console.error("Render job failed:", error);

    await docClient.send(
      new UpdateCommand({
        TableName: RENDER_JOBS_TABLE,
        Key: { jobId },
        UpdateExpression:
          "SET #status = :status, #error = :error, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status", "#error": "error" },
        ExpressionAttributeValues: {
          ":status": "failed",
          ":error": `Render failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          ":updatedAt": new Date().toISOString(),
        },
      })
    );

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        error: "Render job failed",
        details: error instanceof Error ? error.message : String(error),
      }),
    };
  }
};
