import { Handler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { spawn } from "child_process";
import { createWriteStream, createReadStream, promises as fs } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import path from "path";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const s3Client = new S3Client({});

const TABLE_NAME = process.env.TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;

// Chunk duration in seconds (55 minutes to stay under 60-min 12labs limit)
const CHUNK_DURATION_SECONDS = 55 * 60;
// Overlap between chunks to avoid missing content at boundaries
const CHUNK_OVERLAP_SECONDS = 30;

export interface SplitVideoEvent {
  assetId: string;
  s3Key: string;
  bucket: string;
  duration: number;
}

export interface ChunkInfo {
  chunkIndex: number;
  s3Key: string;
  startOffset: number; // Start time in the original video (seconds)
  endOffset: number; // End time in the original video (seconds)
  duration: number; // Actual chunk duration (seconds)
}

export interface SplitVideoResult {
  assetId: string;
  chunks: ChunkInfo[];
  totalChunks: number;
}

/**
 * Get video duration using ffprobe
 */
async function getVideoDuration(inputPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ]);

    let stdout = "";
    let stderr = "";

    ffprobe.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    ffprobe.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffprobe.on("close", (code) => {
      if (code === 0) {
        const duration = parseFloat(stdout.trim());
        if (isNaN(duration)) {
          reject(new Error(`Could not parse duration from: ${stdout}`));
        } else {
          resolve(duration);
        }
      } else {
        reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
      }
    });

    ffprobe.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Validate that a video file has proper codec parameters using ffprobe
 * Returns true if valid, false if pixel format is missing/unspecified
 */
async function validateVideoFile(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ffprobe = spawn("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=pix_fmt",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);

    let stdout = "";
    ffprobe.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    ffprobe.on("close", (code) => {
      const pixFmt = stdout.trim();
      // Valid if we got a pixel format and it's not empty/unknown
      const isValid =
        code === 0 &&
        pixFmt.length > 0 &&
        pixFmt !== "none" &&
        pixFmt !== "unknown";
      console.log(`Video validation: pix_fmt=${pixFmt}, valid=${isValid}`);
      resolve(isValid);
    });

    ffprobe.on("error", () => {
      resolve(false);
    });
  });
}

/**
 * Split a video into a chunk using FFmpeg
 * - First chunk (startTime=0): Re-encode with ultrafast to fix missing codec params
 * - Other chunks: Stream copy (fast)
 * This handles videos with corrupted headers at the start (common with VLC, old formats)
 */
async function extractChunk(
  inputPath: string,
  outputPath: string,
  startTime: number,
  duration: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args: string[] = [];

    // First chunk often has missing codec parameters due to edit lists or bad headers
    // Re-encode only chunk 0; stream copy for the rest (fast)
    const isFirstChunk = startTime === 0;

    // Input options
    // -ignore_editlist fixes "Missing key frame" issues from VLC-encoded videos
    args.push("-ignore_editlist", "1");
    args.push("-ss", startTime.toString());
    args.push("-i", inputPath);
    args.push("-t", duration.toString());

    if (isFirstChunk) {
      // Re-encode first chunk to ensure proper codec parameters
      // ultrafast is ~10-15x realtime on Lambda (55min chunk ≈ 4-5min to encode)
      args.push("-c:v", "libx264");
      args.push("-preset", "ultrafast");
      args.push("-crf", "18"); // High quality
      args.push("-pix_fmt", "yuv420p"); // Explicit pixel format
      args.push("-profile:v", "high");
      args.push("-level", "4.0");
      console.log(
        "First chunk: re-encoding video to fix potential codec issues"
      );
    } else {
      // Stream copy for subsequent chunks (instant)
      args.push("-c:v", "copy");
      console.log("Subsequent chunk: using stream copy (fast)");
    }

    // Audio: always re-encode to AAC for compatibility (source may have MP2/MP3)
    args.push("-c:a", "aac");
    args.push("-b:a", "128k");
    args.push("-ar", "44100");

    // Output options
    args.push("-avoid_negative_ts", "make_zero");
    args.push("-movflags", "+faststart");
    args.push("-y", outputPath);

    console.log(`Extracting chunk: start=${startTime}s, duration=${duration}s`);
    console.log("FFmpeg args:", args.join(" "));

    const ffmpeg = spawn("ffmpeg", args);

    let stderr = "";
    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.includes("time=") || line.includes("frame=")) {
          console.log("FFmpeg progress:", line.trim());
        }
      }
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        console.log(`Chunk extraction completed: ${outputPath}`);
        resolve();
      } else {
        console.error("FFmpeg failed with code:", code);
        console.error("FFmpeg stderr:", stderr);
        reject(new Error(`FFmpeg exited with code ${code}`));
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
 * Calculate chunk boundaries for splitting a video
 */
function calculateChunks(totalDuration: number): ChunkInfo[] {
  const chunks: ChunkInfo[] = [];
  let currentStart = 0;
  let chunkIndex = 0;

  while (currentStart < totalDuration) {
    // Calculate end time for this chunk
    const chunkEnd = Math.min(
      currentStart + CHUNK_DURATION_SECONDS,
      totalDuration
    );
    const chunkDuration = chunkEnd - currentStart;

    chunks.push({
      chunkIndex,
      s3Key: "", // Will be filled in during processing
      startOffset: currentStart,
      endOffset: chunkEnd,
      duration: chunkDuration,
    });

    // Move to next chunk start, accounting for overlap
    // (overlap means next chunk starts a bit before this one ends)
    currentStart = chunkEnd - CHUNK_OVERLAP_SECONDS;

    // Avoid tiny final chunks - if remaining is less than 2 minutes, extend previous chunk
    if (totalDuration - currentStart < 120 && currentStart < totalDuration) {
      // Extend the last chunk to include the remainder
      const lastChunk = chunks[chunks.length - 1];
      lastChunk.endOffset = totalDuration;
      lastChunk.duration = lastChunk.endOffset - lastChunk.startOffset;
      break;
    }

    chunkIndex++;
  }

  return chunks;
}

/**
 * Lambda handler for splitting long videos into chunks for 12labs indexing.
 * This is invoked by startIndexing when a video exceeds 60 minutes.
 */
export const handler: Handler<SplitVideoEvent, SplitVideoResult> = async (
  event
) => {
  const { assetId, s3Key, bucket, duration } = event;

  console.log(`Starting video split for asset ${assetId}`);
  console.log(`Source: s3://${bucket}/${s3Key}, Duration: ${duration}s`);

  // Update asset status to SPLITTING
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { assetId },
      UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "SPLITTING",
        ":updatedAt": new Date().toISOString(),
      },
    })
  );

  try {
    // Check file size before downloading (Lambda has 10GB /tmp limit)
    const MAX_FILE_SIZE = 8 * 1024 * 1024 * 1024; // 8GB
    const headResponse = await s3Client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: s3Key })
    );
    const fileSize = headResponse.ContentLength || 0;

    if (fileSize > MAX_FILE_SIZE) {
      throw new Error(
        `Source video too large (${Math.round(
          fileSize / 1024 / 1024 / 1024
        )}GB). Maximum supported size is 8GB.`
      );
    }

    console.log(`Source video size: ${Math.round(fileSize / 1024 / 1024)}MB`);

    // Create temp directory for processing
    const tmpDir = `/tmp/${assetId}`;
    await fs.mkdir(tmpDir, { recursive: true });

    const inputPath = path.join(tmpDir, "input.mp4");

    // Download source video
    console.log("Downloading source video...");
    await downloadFromS3(bucket, s3Key, inputPath);

    // Get actual duration from the video file (more reliable than passed duration)
    let actualDuration = duration;
    try {
      actualDuration = await getVideoDuration(inputPath);
      console.log(`Actual video duration from ffprobe: ${actualDuration}s`);
    } catch (err) {
      console.warn("Failed to get duration from ffprobe, using provided:", err);
    }

    // Calculate chunk boundaries
    const chunks = calculateChunks(actualDuration);
    console.log(`Splitting into ${chunks.length} chunks:`, chunks);

    // Pre-calculate S3 keys for all chunks - include assetId in filename for uniqueness in 12labs
    for (const chunk of chunks) {
      chunk.s3Key = `chunks/${assetId}/${assetId}-chunk-${chunk.chunkIndex}.mp4`;
    }

    // Update DynamoDB with chunk metadata BEFORE uploading
    // This ensures the S3 trigger can find the chunk info
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { assetId },
        UpdateExpression:
          "SET isChunked = :isChunked, chunkCount = :chunkCount, chunks = :chunks, #status = :status, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":isChunked": true,
          ":chunkCount": chunks.length,
          ":chunks": chunks.map((c) => ({
            chunkIndex: c.chunkIndex,
            s3Key: c.s3Key,
            startOffset: c.startOffset,
            endOffset: c.endOffset,
            duration: c.duration,
          })),
          ":status": "SPLITTING",
          ":updatedAt": new Date().toISOString(),
        },
      })
    );

    console.log("Chunk metadata saved to DynamoDB");

    // Process each chunk - extract and upload
    for (const chunk of chunks) {
      const chunkLocalPath = path.join(
        tmpDir,
        `${assetId}-chunk-${chunk.chunkIndex}.mp4`
      );

      // Extract chunk
      await extractChunk(
        inputPath,
        chunkLocalPath,
        chunk.startOffset,
        chunk.duration
      );

      // Upload chunk to S3 - this triggers startIndexing via S3 notification
      await uploadToS3(chunkLocalPath, BUCKET_NAME, chunk.s3Key);

      // Clean up local chunk file to save space
      await fs.unlink(chunkLocalPath);
    }

    // Update status to indicate splitting is complete
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { assetId },
        UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "SPLIT_COMPLETE",
          ":updatedAt": new Date().toISOString(),
        },
      })
    );

    // Cleanup temp directory
    await fs.rm(tmpDir, { recursive: true, force: true });

    console.log(`Video split complete for asset ${assetId}`);
    console.log(
      `Chunks uploaded to S3 - S3 trigger will invoke startIndexing for each chunk`
    );

    return {
      assetId,
      chunks,
      totalChunks: chunks.length,
    };
  } catch (error) {
    console.error("Video splitting failed:", error);

    // Update asset with failure status
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { assetId },
        UpdateExpression:
          "SET #status = :status, #error = :error, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status", "#error": "error" },
        ExpressionAttributeValues: {
          ":status": "SPLIT_FAILED",
          ":error": `Splitting failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          ":updatedAt": new Date().toISOString(),
        },
      })
    );

    throw error;
  }
};
