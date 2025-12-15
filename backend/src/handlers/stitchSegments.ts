import type { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { renderMediaOnLambda } from "@remotion/lambda/client";
import type { AwsRegion } from "@remotion/lambda";
import { spawn } from "child_process";
import { createWriteStream, createReadStream, promises as fs } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import path from "path";

// Note: checkAuth is not imported - this Lambda is invoked internally

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const s3Client = new S3Client({});

const RENDER_JOBS_TABLE = process.env.RENDER_JOBS_TABLE!;
const MEDIA_BUCKET = process.env.MEDIA_BUCKET!;
const REMOTION_SERVE_URL = process.env.REMOTION_SERVE_URL;
const REMOTION_FUNCTION_NAME = process.env.REMOTION_FUNCTION_NAME;
const AWS_REGION_NAME = process.env.AWS_REGION_NAME;

interface Segment {
  id: string;
  startTime: number;
  endTime: number;
  title: string;
}

/**
 * Runs FFmpeg to stitch multiple segments from a source video into a single output.
 * Uses filter_complex with trim and setpts filters for frame-accurate cutting.
 */
async function runFFmpeg(
  inputPath: string,
  segments: Segment[],
  outputPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Build filter_complex for frame-accurate segment extraction and concatenation
    // Each segment: trim to exact times, reset timestamps with setpts
    const filterParts: string[] = [];
    const concatInputs: string[] = [];

    segments.forEach((segment, i) => {
      const start = segment.startTime;
      const end = segment.endTime;

      // Video filter: trim to exact frames, reset PTS
      filterParts.push(
        `[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${i}]`
      );
      // Audio filter: atrim to exact times, reset PTS
      filterParts.push(
        `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${i}]`
      );

      concatInputs.push(`[v${i}][a${i}]`);
    });

    // Concatenate all segments
    const concatFilter = `${concatInputs.join("")}concat=n=${
      segments.length
    }:v=1:a=1[outv][outa]`;
    filterParts.push(concatFilter);

    const filterComplex = filterParts.join(";");

    // FFmpeg arguments for frame-accurate stitching
    const args = [
      "-i",
      inputPath,
      "-filter_complex",
      filterComplex,
      "-map",
      "[outv]",
      "-map",
      "[outa]",
      // Re-encode for frame accuracy (required for non-keyframe cuts)
      "-c:v",
      "libx264",
      "-preset",
      "veryfast", // Prioritize speed - Remotion will re-encode anyway
      "-crf",
      "23", // Good quality, faster than 18
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      // Ensure compatibility
      "-movflags",
      "+faststart",
      "-y", // Overwrite output
      outputPath,
    ];

    console.log("Running FFmpeg with args:", args.join(" "));

    const ffmpeg = spawn("ffmpeg", args);

    let stderr = "";
    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
      // Log progress lines (they contain time= which shows progress)
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.includes("time=") || line.includes("frame=")) {
          console.log("FFmpeg progress:", line.trim());
        }
      }
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        console.log("FFmpeg completed successfully");
        resolve();
      } else {
        console.error("FFmpeg failed with code:", code);
        console.error("FFmpeg stderr:", stderr);
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`));
      }
    });

    ffmpeg.on("error", (err) => {
      console.error("FFmpeg spawn error:", err);
      reject(err);
    });
  });
}

/**
 * Downloads a file from S3 to local filesystem
 */
async function downloadFromS3(
  bucket: string,
  key: string,
  localPath: string
): Promise<void> {
  console.log(`Downloading s3://${bucket}/${key} to ${localPath}`);

  const response = await s3Client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );

  if (!response.Body) {
    throw new Error("Empty response body from S3");
  }

  const writeStream = createWriteStream(localPath);
  await pipeline(response.Body as Readable, writeStream);

  const stats = await fs.stat(localPath);
  console.log(`Downloaded ${stats.size} bytes to ${localPath}`);
}

/**
 * Uploads a file from local filesystem to S3
 */
async function uploadToS3(
  localPath: string,
  bucket: string,
  key: string
): Promise<void> {
  console.log(`Uploading ${localPath} to s3://${bucket}/${key}`);

  const stats = await fs.stat(localPath);
  const readStream = createReadStream(localPath);

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: readStream,
      ContentType: "video/mp4",
    })
  );

  console.log(`Uploaded ${stats.size} bytes to S3`);
}

/**
 * Parses an S3 URI (s3://bucket/key) into bucket and key components
 */
function parseS3Uri(uri: string): { bucket: string; key: string } {
  const match = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`Invalid S3 URI: ${uri}`);
  }
  return { bucket: match[1], key: match[2] };
}

/**
 * Lambda handler for stitching video segments.
 * This is called internally by renderVideo after creating the job.
 * No auth check needed - this is an internal Lambda invocation.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
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

  console.log(`Starting segment stitching for job ${jobId}`);

  // Get the render job
  const jobResult = await docClient.send(
    new GetCommand({
      TableName: RENDER_JOBS_TABLE,
      Key: { jobId },
    })
  );

  if (!jobResult.Item) {
    return {
      statusCode: 404,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Render job not found" }),
    };
  }

  const job = jobResult.Item;
  // Read from originalSegments, NOT inputProps.segments (which is empty when stitching)
  const segments: Segment[] = job.originalSegments || [];

  if (segments.length === 0) {
    console.log("No segments to stitch, skipping preprocessing");
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        jobId,
        status: "skipped",
        message: "No segments to stitch",
      }),
    };
  }

  // Update job status to "stitching"
  await docClient.send(
    new UpdateCommand({
      TableName: RENDER_JOBS_TABLE,
      Key: { jobId },
      UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "stitching",
        ":updatedAt": new Date().toISOString(),
      },
    })
  );

  try {
    // Parse the source video S3 URI from the job
    // The videoUrl in inputProps is a presigned URL, we need the original S3 URI
    const sourceS3Uri = job.sourceS3Uri;
    if (!sourceS3Uri) {
      throw new Error("Job missing sourceS3Uri");
    }

    const { bucket: sourceBucket, key: sourceKey } = parseS3Uri(sourceS3Uri);

    // Create temp directory for processing
    const tmpDir = `/tmp/${jobId}`;
    await fs.mkdir(tmpDir, { recursive: true });

    const inputPath = path.join(tmpDir, "input.mp4");
    const outputPath = path.join(tmpDir, "stitched.mp4");

    // Download source video
    console.log("Downloading source video...");
    await downloadFromS3(sourceBucket, sourceKey, inputPath);

    // Calculate total output duration for logging
    const totalDuration = segments.reduce(
      (sum, s) => sum + (s.endTime - s.startTime),
      0
    );
    console.log(
      `Stitching ${
        segments.length
      } segments, total duration: ${totalDuration.toFixed(2)}s`
    );

    // Run FFmpeg to stitch segments
    console.log("Running FFmpeg...");
    await runFFmpeg(inputPath, segments, outputPath);

    // Upload stitched video to S3
    const stitchedKey = `stitched/${jobId}.mp4`;
    await uploadToS3(outputPath, MEDIA_BUCKET, stitchedKey);

    // Generate presigned URL for the stitched video
    const stitchedUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: MEDIA_BUCKET,
        Key: stitchedKey,
      }),
      { expiresIn: 43200 } // 12 hours
    );

    // Update job with stitched video info and update inputProps.videoUrl
    await docClient.send(
      new UpdateCommand({
        TableName: RENDER_JOBS_TABLE,
        Key: { jobId },
        UpdateExpression:
          "SET stitchedS3Uri = :stitchedUri, #inputProps.videoUrl = :stitchedUrl, updatedAt = :updatedAt",
        ExpressionAttributeNames: {
          "#inputProps": "inputProps",
        },
        ExpressionAttributeValues: {
          ":stitchedUri": `s3://${MEDIA_BUCKET}/${stitchedKey}`,
          ":stitchedUrl": stitchedUrl,
          ":updatedAt": new Date().toISOString(),
        },
      })
    );

    // Cleanup temp files
    await fs.rm(tmpDir, { recursive: true, force: true });

    console.log(`Segment stitching complete for job ${jobId}`);

    // Now trigger Remotion render with the stitched video
    if (!REMOTION_SERVE_URL || !REMOTION_FUNCTION_NAME || !AWS_REGION_NAME) {
      console.log("Remotion not configured, stopping after stitch");
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({
          jobId,
          status: "stitched",
          message: "Stitching complete. Remotion not configured.",
          stitchedS3Uri: `s3://${MEDIA_BUCKET}/${stitchedKey}`,
          totalDuration,
          segmentCount: segments.length,
        }),
      };
    }

    console.log(`Starting Remotion render for stitched job ${jobId}`);

    // Get the updated job with stitched video URL
    const updatedJobResult = await docClient.send(
      new GetCommand({
        TableName: RENDER_JOBS_TABLE,
        Key: { jobId },
      })
    );
    const updatedJob = updatedJobResult.Item!;

    // Optimized framesPerLambda for speed (per Remotion best practices)
    // 10 min video = 18,000 frames at 30fps
    // With framesPerLambda=150, that's ~120 workers (fits in 1,000 concurrency limit)
    // This allows ~6-8 parallel video renders without throttling
    const framesPerLambda = 150; // ~5 seconds per worker = massive parallelism

    console.log("Remotion render configuration:", {
      jobId,
      totalDuration,
      framesPerLambda,
      estimatedWorkers: Math.ceil((totalDuration * 30) / framesPerLambda),
      videoUrl: stitchedUrl.substring(0, 80) + "...",
    });

    // Calculate actual frame count from stitched video duration
    const totalFrames = Math.ceil(totalDuration * 30); // 30 fps

    const renderResponse = await renderMediaOnLambda({
      region: AWS_REGION_NAME as AwsRegion,
      functionName: REMOTION_FUNCTION_NAME,
      serveUrl: REMOTION_SERVE_URL,
      composition: "CaptionedVideo",
      inputProps: {
        videoUrl: stitchedUrl,
        segments: [], // No segments - video is already stitched
        captions: updatedJob.inputProps?.captions || [],
        captionSettings: updatedJob.inputProps?.captionSettings,
      },
      codec: updatedJob.outputFormat === "webm" ? "vp8" : "h264",
      outName: `${jobId}.${updatedJob.outputFormat || "mp4"}`,
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
    });

    // Update job with rendering status
    await docClient.send(
      new UpdateCommand({
        TableName: RENDER_JOBS_TABLE,
        Key: { jobId },
        UpdateExpression:
          "SET #status = :status, renderId = :renderId, bucketName = :bucketName, updatedAt = :updatedAt",
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
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        jobId,
        status: "rendering",
        renderId: renderResponse.renderId,
        stitchedS3Uri: `s3://${MEDIA_BUCKET}/${stitchedKey}`,
        totalDuration,
        segmentCount: segments.length,
      }),
    };
  } catch (error) {
    console.error("Segment stitching failed:", error);

    // Update job with failure status
    await docClient.send(
      new UpdateCommand({
        TableName: RENDER_JOBS_TABLE,
        Key: { jobId },
        UpdateExpression:
          "SET #status = :status, #error = :error, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status", "#error": "error" },
        ExpressionAttributeValues: {
          ":status": "failed",
          ":error": `Stitching failed: ${
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
        error: "Segment stitching failed",
        details: error instanceof Error ? error.message : String(error),
      }),
    };
  }
};
