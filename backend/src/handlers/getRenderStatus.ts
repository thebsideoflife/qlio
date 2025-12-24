import type { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { checkAuth } from "../utils/auth";
import { getRenderProgress } from "@remotion/lambda/client";
import type { AwsRegion } from "@remotion/lambda";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const s3Client = new S3Client({});

const RENDER_JOBS_TABLE = process.env.RENDER_JOBS_TABLE!;
const REMOTION_FUNCTION_NAME = process.env.REMOTION_FUNCTION_NAME;
const AWS_REGION_NAME = process.env.AWS_REGION_NAME;

export const handler: APIGatewayProxyHandler = async (event) => {
  // Auth check
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
    })
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

  console.log(`Render status check for ${jobId}:`, {
    status: job.status,
    progress: job.progress || 0,
    renderId: job.renderId,
  });

  // Check if render is stuck (> 6 hours)
  const MAX_RENDER_TIME = 6 * 60 * 60 * 1000; // 6 hours
  if (job.status === "rendering") {
    const renderStartTime = new Date(job.createdAt).getTime();
    const now = Date.now();

    if (now - renderStartTime > MAX_RENDER_TIME) {
      console.error(`Render timeout for job ${jobId} - exceeded 6 hours`);
      // Mark as failed
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
            ":error": "Render timeout - exceeded 6 hours",
            ":updatedAt": new Date().toISOString(),
          },
        })
      );
      job.status = "failed";
      job.error = "Render timeout";
    }
  }

  // If job is rendering, check actual progress from Remotion Lambda
  if (
    job.status === "rendering" &&
    job.renderId &&
    REMOTION_FUNCTION_NAME &&
    AWS_REGION_NAME
  ) {
    try {
      console.log(
        `Checking render progress for ${jobId} (renderId: ${job.renderId})`
      );

      const renderProgress = await getRenderProgress({
        bucketName: job.bucketName,
        renderId: job.renderId,
        functionName: REMOTION_FUNCTION_NAME,
        region: AWS_REGION_NAME as AwsRegion,
      });

      console.log(`Render progress for ${jobId}:`, {
        overallProgress: renderProgress.overallProgress,
        done: renderProgress.done,
        fatalErrorEncountered: renderProgress.fatalErrorEncountered,
        errors: renderProgress.errors,
      });

      // Check for fatal errors from Remotion
      if (renderProgress.fatalErrorEncountered) {
        // Extract error details from Remotion
        const rawError =
          renderProgress.errors?.[0]?.message ||
          "Render failed with fatal error";

        // Map technical errors to user-friendly messages
        let userFriendlyError = rawError;
        if (
          rawError.includes("Concurrency limit") ||
          rawError.includes("Rate Exceeded")
        ) {
          userFriendlyError =
            "Server is busy with too many renders. Please try again in a few minutes.";
        } else if (
          rawError.includes("timeout") ||
          rawError.includes("Timeout")
        ) {
          userFriendlyError =
            "Render timed out. Try rendering a shorter video.";
        } else if (rawError.includes("memory") || rawError.includes("Memory")) {
          userFriendlyError =
            "Video is too large to process. Try a shorter segment.";
        }

        console.error(`Render ${jobId} failed with fatal error:`, rawError);

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
              ":error": userFriendlyError,
              ":updatedAt": new Date().toISOString(),
            },
          })
        );

        job.status = "failed";
        job.error = userFriendlyError;
      } else if (renderProgress.done) {
        // Render completed! Update to completed status
        const outputFile = renderProgress.outputFile;

        console.log(`Render ${jobId} completed! Output: ${outputFile}`);

        await docClient.send(
          new UpdateCommand({
            TableName: RENDER_JOBS_TABLE,
            Key: { jobId },
            UpdateExpression:
              "SET #status = :status, progress = :progress, outputUrl = :outputUrl, completedAt = :completedAt, updatedAt = :updatedAt",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":status": "completed",
              ":progress": 100,
              ":outputUrl": outputFile,
              ":completedAt": new Date().toISOString(),
              ":updatedAt": new Date().toISOString(),
            },
          })
        );

        job.status = "completed";
        job.progress = 100;
        job.outputUrl = outputFile;
      } else {
        // Still rendering, update progress
        const newProgress = Math.round(renderProgress.overallProgress * 100);

        await docClient.send(
          new UpdateCommand({
            TableName: RENDER_JOBS_TABLE,
            Key: { jobId },
            UpdateExpression:
              "SET progress = :progress, updatedAt = :updatedAt",
            ExpressionAttributeValues: {
              ":progress": newProgress,
              ":updatedAt": new Date().toISOString(),
            },
          })
        );

        job.progress = newProgress;
      }
    } catch (error) {
      console.error("Error checking render progress:", error);
      // Continue with cached status from DynamoDB
    }
  }

  // Generate presigned download URL and S3 URI if completed
  let downloadUrl: string | undefined;
  let outputS3Uri: string | undefined;
  if (job.status === "completed" && job.outputUrl) {
    // outputUrl from Remotion is already a full URL, but we should presign it
    // Extract bucket and key from the URL or use stored values
    if (job.renderId && job.bucketName && job.jobId) {
      try {
        const extension = job.outputFormat || "mp4";
        // Use jobId for the filename - matches outName in renderVideo.ts
        const key = `renders/${job.renderId}/${job.jobId}.${extension}`;

        console.log(`Generating presigned URL for job ${jobId}:`, {
          bucket: job.bucketName,
          key,
        });

        const command = new GetObjectCommand({
          Bucket: job.bucketName,
          Key: key,
        });
        downloadUrl = await getSignedUrl(s3Client, command, {
          expiresIn: 43200, // 12 hours - gives user time to download
        });
        // Also return S3 URI for persistent storage
        outputS3Uri = `s3://${job.bucketName}/${key}`;
        console.log(`Successfully generated presigned URL for job ${jobId}`);
      } catch (error) {
        console.error(
          "Error generating presigned URL for job",
          jobId,
          ":",
          error
        );
      }
    }
  }

  // Calculate effective progress including stitching phase
  let effectiveProgress = job.progress || 0;
  let statusMessage: string | undefined;

  if (job.status === "pending_stitch") {
    statusMessage = "Preparing video segments...";
    effectiveProgress = 0;
  } else if (job.status === "stitching") {
    statusMessage = "Stitching video segments...";
    effectiveProgress = 5; // Show some progress during stitching
  } else if (job.status === "rendering") {
    // If we had stitching, rendering starts at 10%
    if (job.needsStitching) {
      effectiveProgress = 10 + Math.round((job.progress || 0) * 0.9);
    }
  }

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
      progress: effectiveProgress,
      statusMessage,
      totalDuration: job.totalDuration,
      needsStitching: job.needsStitching,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
      error: job.error,
      downloadUrl,
      outputS3Uri,
    }),
  };
};
