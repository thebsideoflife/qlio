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
  startOffset: number; // Intended start time in the original video (seconds)
  endOffset: number; // End time in the original video (seconds)
  duration: number; // Expected chunk duration (seconds)
  actualDuration?: number; // Actual duration after FFmpeg extraction (for precise timing)
  actualStartOffset?: number; // Calculated from endOffset - actualDuration (for transcription alignment)
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
 * Split a video into a chunk using FFmpeg with stream copy.
 * Uses bitstream filter to inject SPS/PPS at keyframes, fixing codec parameter issues
 * without expensive re-encoding.
 */
async function extractChunk(
  inputPath: string,
  outputPath: string,
  startTime: number,
  duration: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args: string[] = [];

    // Input options
    // -ignore_editlist fixes "Missing key frame" issues from VLC-encoded videos
    args.push("-ignore_editlist", "1");
    args.push("-ss", startTime.toString());
    args.push("-i", inputPath);
    args.push("-t", duration.toString());

    // Stream copy video (instant, no re-encoding)
    args.push("-c:v", "copy");

    // Audio: re-encode to AAC for compatibility (source may have MP2/MP3)
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
    let fileSize: number;

    try {
      const headResponse = await s3Client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: s3Key })
      );
      fileSize = headResponse.ContentLength || 0;
    } catch (headErr: any) {
      // Handle missing file gracefully - don't retry
      if (
        headErr.name === "NotFound" ||
        headErr.$metadata?.httpStatusCode === 404
      ) {
        console.error(`Source file not found: s3://${bucket}/${s3Key}`);
        await docClient.send(
          new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { assetId },
            UpdateExpression:
              "SET #status = :status, #error = :error, updatedAt = :updatedAt",
            ExpressionAttributeNames: {
              "#status": "status",
              "#error": "error",
            },
            ExpressionAttributeValues: {
              ":status": "SPLIT_FAILED",
              ":error":
                "Source video file not found - it may have been deleted",
              ":updatedAt": new Date().toISOString(),
            },
          })
        );
        // Return instead of throw to prevent Lambda retry
        return {
          assetId,
          chunks: [],
          totalChunks: 0,
        };
      }
      throw headErr;
    }

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

      // Probe actual duration to calculate precise start offset
      // FFmpeg seeks to nearest keyframe, so actual start may differ from intended
      try {
        const actualDuration = await getVideoDuration(chunkLocalPath);
        chunk.actualDuration = actualDuration;

        // Chunk 0 always starts at 0 (can't go before beginning of video)
        // Other chunks: calculate from endOffset - actualDuration
        if (chunk.chunkIndex === 0) {
          chunk.actualStartOffset = 0;
        } else {
          chunk.actualStartOffset = chunk.endOffset - actualDuration;
        }

        console.log(
          `Chunk ${chunk.chunkIndex}: intended start=${
            chunk.startOffset
          }s, actual start=${chunk.actualStartOffset.toFixed(2)}s (diff=${(
            chunk.startOffset - chunk.actualStartOffset
          ).toFixed(2)}s)`
        );
      } catch (err) {
        console.warn(
          `Could not probe chunk ${chunk.chunkIndex} duration:`,
          err
        );
        // Fall back to intended offset
        chunk.actualStartOffset = chunk.startOffset;
        chunk.actualDuration = chunk.duration;
      }

      // Upload chunk to S3 - this triggers startIndexing via S3 notification
      await uploadToS3(chunkLocalPath, BUCKET_NAME, chunk.s3Key);

      // Clean up local chunk file to save space
      await fs.unlink(chunkLocalPath);
    }

    // Update DynamoDB with actual timing info before marking complete
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { assetId },
        UpdateExpression: "SET chunks = :chunks, updatedAt = :updatedAt",
        ExpressionAttributeValues: {
          ":chunks": chunks.map((c) => ({
            chunkIndex: c.chunkIndex,
            s3Key: c.s3Key,
            startOffset: c.startOffset,
            endOffset: c.endOffset,
            duration: c.duration,
            actualDuration: c.actualDuration,
            actualStartOffset: c.actualStartOffset,
          })),
          ":updatedAt": new Date().toISOString(),
        },
      })
    );

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
