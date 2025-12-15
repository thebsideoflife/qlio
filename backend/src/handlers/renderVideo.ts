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
const docClient = DynamoDBDocumentClient.from(client);
const lambdaClient = new LambdaClient({});

const RENDER_JOBS_TABLE = process.env.RENDER_JOBS_TABLE!;
const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const MEDIA_BUCKET = process.env.MEDIA_BUCKET!;
const REMOTION_SERVE_URL = process.env.REMOTION_SERVE_URL;
const REMOTION_FUNCTION_NAME = process.env.REMOTION_FUNCTION_NAME;
const STITCH_FUNCTION_NAME = process.env.STITCH_FUNCTION_NAME;

interface RenderRequest {
  segments: Array<{
    id: string;
    startTime: number;
    endTime: number;
    title: string;
  }>;
  captions: Array<{
    id: string;
    startTime: number;
    endTime: number;
    text: string;
    words: Array<{ start: number; end: number; value: string }>;
  }>;
  captionSettings: {
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
  };
  outputFormat?: "mp4" | "webm";
  quality?: "draft" | "standard" | "high";
}

/**
 * Adjusts caption timings to match the stitched video.
 * When segments are extracted and concatenated, captions need to be
 * remapped from their original video timestamps to the new timeline.
 */
function adjustCaptionsForStitchedVideo(
  captions: RenderRequest["captions"],
  segments: RenderRequest["segments"]
): RenderRequest["captions"] {
  if (segments.length === 0) return captions;

  // Build a timeline mapping: for each segment, track where it starts in the output
  const timeline: Array<{
    originalStart: number;
    originalEnd: number;
    outputStart: number;
  }> = [];

  let outputTime = 0;
  for (const segment of segments) {
    timeline.push({
      originalStart: segment.startTime,
      originalEnd: segment.endTime,
      outputStart: outputTime,
    });
    outputTime += segment.endTime - segment.startTime;
  }

  // Adjust each caption to the new timeline
  return captions
    .map((caption) => {
      // Find which segment(s) this caption belongs to
      for (const seg of timeline) {
        // Caption starts within this segment
        if (
          caption.startTime >= seg.originalStart &&
          caption.startTime < seg.originalEnd
        ) {
          const offsetInSegment = caption.startTime - seg.originalStart;
          const newStart = seg.outputStart + offsetInSegment;

          // Calculate new end time (clamp to segment boundary)
          const captionDuration = caption.endTime - caption.startTime;
          const maxDurationInSegment = seg.originalEnd - caption.startTime;
          const actualDuration = Math.min(
            captionDuration,
            maxDurationInSegment
          );
          const newEnd = newStart + actualDuration;

          // Adjust word timings too
          const adjustedWords = caption.words.map((word) => ({
            ...word,
            start: newStart + (word.start - caption.startTime),
            end: newStart + (word.end - caption.startTime),
          }));

          return {
            ...caption,
            startTime: newStart,
            endTime: newEnd,
            words: adjustedWords,
          };
        }
      }
      // Caption doesn't fall within any segment - exclude it
      return null;
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);
}

export const handler: APIGatewayProxyHandler = async (event) => {
  // Auth check
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

  let body: RenderRequest;
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

  // Get project to find video URL
  const projectResult = await docClient.send(
    new GetCommand({
      TableName: PROJECTS_TABLE,
      Key: { projectId },
    })
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

  // Fetch the asset to get the video URL
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

  const assetResult = await docClient.send(
    new GetCommand({
      TableName: ASSETS_TABLE,
      Key: { assetId: project.assetId },
    })
  );

  if (!assetResult.Item) {
    return {
      statusCode: 404,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Asset not found" }),
    };
  }

  const asset = assetResult.Item;

  // Get presigned URL for the source video using the s3 utility
  if (!asset.s3VideoUrl) {
    console.error("Asset has no s3VideoUrl:", {
      projectId,
      assetId: project.assetId,
      assetKeys: Object.keys(asset),
    });
    return {
      statusCode: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        error: "Asset has no video file (s3VideoUrl missing)",
      }),
    };
  }

  const { presignS3Uri } = await import("../utils/s3");
  const presignedVideoUrl = await presignS3Uri(asset.s3VideoUrl);

  if (!presignedVideoUrl) {
    console.error("Failed to generate presigned URL for:", {
      projectId,
      assetId: project.assetId,
      s3VideoUrl: asset.s3VideoUrl,
    });
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        error: "Failed to generate video URL",
        details: `Could not presign S3 URI: ${asset.s3VideoUrl}`,
      }),
    };
  }

  console.log("Generated presigned video URL for rendering:", {
    projectId,
    assetId: project.assetId,
    s3Uri: asset.s3VideoUrl,
    presignedUrlLength: presignedVideoUrl.length,
    presignedUrlPrefix: presignedVideoUrl.substring(0, 50) + "...",
  });

  // Create render job
  const jobId = uuidv4();
  const now = new Date().toISOString();
  const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60; // 7 days TTL

  // Calculate total duration from segments (or use full video duration)
  const segments = body.segments || [];
  const hasSegments = segments.length > 0;
  const totalDuration = hasSegments
    ? segments.reduce((sum, s) => sum + (s.endTime - s.startTime), 0)
    : asset.duration || 0;

  const estimatedFrames = Math.round(totalDuration * 30); // 30 fps

  // Determine if we need FFmpeg stitching
  // Stitch if: we have segments AND the stitch function is configured
  const needsStitching = hasSegments && STITCH_FUNCTION_NAME;

  const renderJob = {
    jobId,
    projectId,
    status: needsStitching ? "pending_stitch" : "pending",
    createdAt: now,
    updatedAt: now,
    expiresAt,
    progress: 0,
    totalDuration,
    estimatedFrames,
    needsStitching,
    // Store original S3 URI for stitching Lambda
    sourceS3Uri: asset.s3VideoUrl,
    inputProps: {
      // For stitched videos, Remotion gets the stitched video with no segments
      // For non-stitched, Remotion gets the original video with segments
      videoUrl: presignedVideoUrl,
      segments: needsStitching ? [] : segments, // Clear segments if stitching
      captions: needsStitching
        ? adjustCaptionsForStitchedVideo(body.captions || [], segments)
        : body.captions || [],
      captionSettings: body.captionSettings,
    },
    // Store original segments for stitching Lambda
    originalSegments: segments,
    outputFormat: body.outputFormat || "mp4",
    quality: body.quality || "standard",
    outputKey: `renders/${projectId}/${jobId}.${body.outputFormat || "mp4"}`,
  };

  // Validate inputProps before storing
  console.log("Render job configuration:", {
    jobId,
    needsStitching,
    hasVideoUrl: !!renderJob.inputProps.videoUrl,
    videoUrlLength: renderJob.inputProps.videoUrl?.length,
    originalSegmentsCount: segments.length,
    remotionSegmentsCount: renderJob.inputProps.segments.length,
    captionsCount: renderJob.inputProps.captions.length,
    captionSettingsEnabled: renderJob.inputProps.captionSettings?.enabled,
    totalDuration,
  });

  // Store render job
  await docClient.send(
    new PutCommand({
      TableName: RENDER_JOBS_TABLE,
      Item: renderJob,
    })
  );

  // If we need stitching, invoke the stitch Lambda asynchronously
  if (needsStitching && STITCH_FUNCTION_NAME) {
    console.log(`Invoking stitch Lambda for job ${jobId}`);

    try {
      await lambdaClient.send(
        new InvokeCommand({
          FunctionName: STITCH_FUNCTION_NAME,
          InvocationType: "Event", // Async invocation
          Payload: JSON.stringify({
            pathParameters: { jobId },
            headers: event.headers, // Pass auth headers
          }),
        })
      );

      console.log(`Stitch Lambda invoked for job ${jobId}`);

      return {
        statusCode: 202,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({
          jobId,
          status: "pending_stitch",
          message:
            "Render job created. Video segments are being stitched before caption rendering.",
          totalDuration,
          segmentCount: segments.length,
        }),
      };
    } catch (error) {
      console.error("Failed to invoke stitch Lambda:", error);
      // Fall through to direct Remotion render as fallback
      console.log("Falling back to direct Remotion render");
    }
  }

  // Check if Remotion is configured
  if (!REMOTION_SERVE_URL || !REMOTION_FUNCTION_NAME) {
    console.log("Remotion not configured. Job created but not started:", jobId);
    return {
      statusCode: 202,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        jobId,
        status: "pending",
        message:
          "Render job created. Remotion Lambda needs to be deployed to process renders.",
      }),
    };
  }

  // Direct Remotion render (no stitching needed)
  return await startRemotionRender(jobId, renderJob, body.outputFormat);
};

/**
 * Starts a Remotion Lambda render for the given job.
 * This is called either directly (no segments) or after stitching completes.
 */
async function startRemotionRender(
  jobId: string,
  renderJob: {
    inputProps: {
      videoUrl: string;
      segments: RenderRequest["segments"];
      captions: RenderRequest["captions"];
      captionSettings: RenderRequest["captionSettings"];
    };
    totalDuration: number;
    estimatedFrames: number;
  },
  outputFormat?: "mp4" | "webm"
) {
  console.log("Starting Remotion Lambda render:", {
    jobId,
    composition: "CaptionedVideo",
    functionName: REMOTION_FUNCTION_NAME,
    serveUrl: REMOTION_SERVE_URL,
    inputPropsPreview: {
      videoUrl: renderJob.inputProps.videoUrl.substring(0, 80) + "...",
      segmentsCount: renderJob.inputProps.segments.length,
      captionsCount: renderJob.inputProps.captions.length,
    },
  });

  try {
    // Final validation before sending to Remotion Lambda
    if (
      !renderJob.inputProps.videoUrl ||
      renderJob.inputProps.videoUrl.trim() === ""
    ) {
      throw new Error(
        "videoUrl is empty or undefined - cannot render without source video"
      );
    }

    // Optimized framesPerLambda for speed (per Remotion best practices)
    // 10 min video = 18,000 frames at 30fps
    // With framesPerLambda=150, that's ~120 workers (fits in 1,000 concurrency limit)
    // This allows ~6-8 parallel video renders without throttling
    const framesPerLambda = 150; // ~5 seconds per worker = massive parallelism

    console.log("Render configuration:", {
      jobId,
      framesPerLambda,
      estimatedFrames: renderJob.estimatedFrames,
      estimatedWorkers: Math.ceil(renderJob.estimatedFrames / framesPerLambda),
      totalDuration: renderJob.totalDuration,
    });

    // Calculate actual frame count from video duration
    const totalFrames = Math.ceil(renderJob.totalDuration * 30); // 30 fps

    const renderResponse = await renderMediaOnLambda({
      region: process.env.AWS_REGION_NAME as AwsRegion,
      functionName: REMOTION_FUNCTION_NAME!,
      serveUrl: REMOTION_SERVE_URL!,
      composition: "CaptionedVideo",
      inputProps: renderJob.inputProps,
      codec: outputFormat === "webm" ? "vp8" : "h264",
      outName: `${jobId}.${outputFormat || "mp4"}`,
      privacy: "no-acl", // Avoid S3 ACL issues - we generate presigned URLs for access
      framesPerLambda,
      frameRange: [0, totalFrames - 1], // Render only the actual video frames
      // Speed optimizations
      imageFormat: "jpeg",
      jpegQuality: 80,
      concurrencyPerLambda: 1, // Keep at 1 to avoid memory leaks and timeouts
    });

    console.log("Remotion render started:", {
      jobId,
      renderId: renderResponse.renderId,
      bucketName: renderResponse.bucketName,
      cloudWatchLogs: renderResponse.cloudWatchLogs,
      folderInS3Console: renderResponse.folderInS3Console,
    });

    // Update job with rendering status and renderId for tracking
    await docClient.send(
      new UpdateCommand({
        TableName: RENDER_JOBS_TABLE,
        Key: { jobId },
        UpdateExpression:
          "SET #status = :status, renderId = :renderId, bucketName = :bucketName, updatedAt = :updatedAt",
        ExpressionAttributeNames: {
          "#status": "status",
        },
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
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        jobId,
        status: "rendering",
        renderId: renderResponse.renderId,
        message: "Render started successfully",
      }),
    };
  } catch (error) {
    console.error("Remotion render failed:", error);

    // Update job with failure status
    await docClient.send(
      new UpdateCommand({
        TableName: RENDER_JOBS_TABLE,
        Key: { jobId },
        UpdateExpression:
          "SET #status = :status, #error = :error, updatedAt = :updatedAt",
        ExpressionAttributeNames: {
          "#status": "status",
          "#error": "error",
        },
        ExpressionAttributeValues: {
          ":status": "failed",
          ":error": error instanceof Error ? error.message : String(error),
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
        error: "Render failed",
        details: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}
