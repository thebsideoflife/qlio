/**
 * cutSegments — FFmpeg Docker Lambda handler
 *
 * Downloads the source video once, cuts each segment into a small clip
 * using stream copy (no re-encoding), uploads clips to S3, then kicks
 * off a Remotion render per clip.
 *
 * Invoked internally by renderVideo via Lambda.InvokeCommand.
 */
import { Handler } from "aws-lambda";
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
import {
  groupWordsIntoCaptions,
  parseTranscriptJson,
} from "../utils/transcript-format";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});
const s3Client = new S3Client({});

const RENDER_JOBS_TABLE = process.env.RENDER_JOBS_TABLE!;
const MEDIA_BUCKET = process.env.MEDIA_BUCKET!;
const REMOTION_SERVE_URL = process.env.REMOTION_SERVE_URL!;
const REMOTION_FUNCTION_NAME = process.env.REMOTION_FUNCTION_NAME!;
const AWS_REGION_NAME = process.env.AWS_REGION_NAME!;

// ---------------------------------------------------------------------------
// FFmpeg helpers (pattern from splitVideo.ts)
// ---------------------------------------------------------------------------

async function downloadFromS3(
  bucket: string,
  key: string,
  localPath: string,
): Promise<void> {
  console.log(`Downloading s3://${bucket}/${key} to ${localPath}`);
  const response = await s3Client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!response.Body) throw new Error("Empty response body from S3");
  const writeStream = createWriteStream(localPath);
  await pipeline(response.Body as Readable, writeStream);
  const stats = await fs.stat(localPath);
  console.log(`Downloaded ${stats.size} bytes`);
}

async function uploadToS3(
  localPath: string,
  bucket: string,
  key: string,
): Promise<void> {
  const stats = await fs.stat(localPath);
  const readStream = createReadStream(localPath);
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: readStream,
      ContentType: "video/mp4",
    }),
  );
  console.log(`Uploaded ${stats.size} bytes to s3://${bucket}/${key}`);
}

function extractClip(
  inputPath: string,
  outputPath: string,
  startTime: number,
  duration: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-ignore_editlist", "1",
      "-ss", startTime.toString(),
      "-i", inputPath,
      "-t", duration.toString(),
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
      "-avoid_negative_ts", "make_zero",
      "-movflags", "+faststart",
      "-y", outputPath,
    ];

    console.log(`Cutting clip: start=${startTime}s, duration=${duration}s`);
    const ffmpeg = spawn("ffmpeg", args);

    let stderr = "";
    ffmpeg.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    ffmpeg.on("close", (code) => {
      if (code === 0) { resolve(); return; }
      console.error("FFmpeg stderr:", stderr);
      reject(new Error(`FFmpeg exited with code ${code}`));
    });
    ffmpeg.on("error", reject);
  });
}

const DEFAULT_SOURCE_ASPECT = 16 / 9;

/** Source width/height from the downloaded file so Remotion framing matches the editor. */
function getVideoAspect(inputPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=p=0",
      inputPath,
    ]);

    let stdout = "";
    let stderr = "";
    ffprobe.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    ffprobe.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    ffprobe.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
        return;
      }
      const [widthStr, heightStr] = stdout.trim().split(",");
      const width = parseFloat(widthStr);
      const height = parseFloat(heightStr);
      if (!(width > 0) || !(height > 0)) {
        reject(new Error(`Could not parse dimensions from: ${stdout}`));
        return;
      }
      resolve(width / height);
    });
    ffprobe.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler: Handler<{ jobId: string }, void> = async (event) => {
  const { jobId } = event;
  console.log(`cutSegments: starting for job ${jobId}`);

  // 1. Read job from DynamoDB
  const jobResult = await docClient.send(
    new GetCommand({ TableName: RENDER_JOBS_TABLE, Key: { jobId } }),
  );
  const job = jobResult.Item;
  if (!job) throw new Error(`Job ${jobId} not found`);

  const {
    sourceS3Uri,
    transcriptionS3Uri,
    segments,
    captionSettings,
    globalFraming,
    outputFormat,
    compositionId,
  } = job;

  if (!segments?.length) throw new Error("No segments in job");

  // 2. Load captions directly from S3 (no need to store in DynamoDB)
  let captions: any[] = [];
  if (transcriptionS3Uri && captionSettings?.enabled) {
    try {
      const { presignS3Uri } = await import("../utils/s3");
      const presignedUrl = await presignS3Uri(transcriptionS3Uri);
      if (presignedUrl) {
        const response = await fetch(presignedUrl);
        const data = await response.json() as unknown;
        const parsed = parseTranscriptJson(data);
        captions =
          parsed.kind === "translation"
            ? parsed.lines
            : groupWordsIntoCaptions(parsed.words);
        console.log(`Loaded ${captions.length} caption lines from S3`);
      }
    } catch (error) {
      console.error("Failed to load transcription, continuing without captions:", error);
    }
  }

  // 3. Download source video
  const { bucket, key } = parseS3Uri(sourceS3Uri);
  const tmpDir = `/tmp/${jobId}`;
  await fs.mkdir(tmpDir, { recursive: true });
  const inputPath = path.join(tmpDir, "source.mp4");
  await downloadFromS3(bucket, key, inputPath);

  let sourceAspect = DEFAULT_SOURCE_ASPECT;
  try {
    sourceAspect = await getVideoAspect(inputPath);
    console.log(`Source aspect: ${sourceAspect}`);
  } catch (err) {
    console.warn("Failed to probe source aspect, defaulting to 16:9:", err);
  }

  try {
    // 3. Cut each segment and upload clip
    const clipUrls: Map<string, string> = new Map();

    for (const segment of segments) {
      const duration = segment.endTime - segment.startTime;
      const clipPath = path.join(tmpDir, `${segment.id}.mp4`);
      await extractClip(inputPath, clipPath, segment.startTime, duration);

      const clipKey = `clips/${jobId}/${segment.id}.mp4`;
      await uploadToS3(clipPath, MEDIA_BUCKET, clipKey);

      const clipUrl = await getSignedUrl(
        s3Client,
        new GetObjectCommand({ Bucket: MEDIA_BUCKET, Key: clipKey }),
        { expiresIn: 604800 },
      );
      clipUrls.set(segment.id, clipUrl);

      // Free disk space
      await fs.unlink(clipPath);
    }

    // 4. Kick off Remotion renders per clip
    console.log(`Starting ${segments.length} Remotion renders`);
    const segmentRenders = await Promise.all(
      segments.map(async (segment: any) => {
        const clipUrl = clipUrls.get(segment.id)!;
        const duration = segment.endTime - segment.startTime;

        // Adjust captions to clip-relative time (clip starts at 0)
        const segmentCaptions = (captions || []).filter(
          (c: any) => c.startTime >= segment.startTime && c.startTime < segment.endTime,
        ).map((c: any) => ({
          ...c,
          startTime: c.startTime - segment.startTime,
          endTime: c.endTime - segment.startTime,
          words: c.words?.map((w: any) => ({
            ...w,
            start: w.start - segment.startTime,
            end: w.end - segment.startTime,
          })),
        }));

        const segmentFraming = segment.framing || {
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
            videoUrl: clipUrl,
            segments: [{
              id: segment.id,
              startTime: 0,
              endTime: duration,
              title: segment.title,
              framing: segmentFraming,
            }],
            captions: segmentCaptions,
            captionSettings,
            globalFraming: { ...globalFraming, enabled: true },
            sourceAspect,
          },
          codec: outputFormat === "webm" ? "vp8" : "h264",
          outName,
          privacy: "no-acl",
          framesPerLambda: 300,
          imageFormat: "jpeg",
          jpegQuality: 80,
          concurrencyPerLambda: 1,
        });

        return {
          segmentId: segment.id,
          title: segment.title,
          renderId: renderResponse.renderId,
          bucketName: renderResponse.bucketName,
          outputKey: `renders/${renderResponse.renderId}/${outName}`,
          status: "rendering" as const,
        };
      }),
    );

    // 5. Update job with render IDs
    await docClient.send(
      new UpdateCommand({
        TableName: RENDER_JOBS_TABLE,
        Key: { jobId },
        UpdateExpression:
          "SET segmentRenders = :segmentRenders, #status = :status, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":segmentRenders": segmentRenders,
          ":status": "rendering",
          ":updatedAt": new Date().toISOString(),
        },
      }),
    );

    console.log(`cutSegments: launched ${segmentRenders.length} Remotion renders for job ${jobId}`);
  } catch (error) {
    console.error("cutSegments failed:", error);
    await docClient.send(
      new UpdateCommand({
        TableName: RENDER_JOBS_TABLE,
        Key: { jobId },
        UpdateExpression:
          "SET #status = :status, #error = :error, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status", "#error": "error" },
        ExpressionAttributeValues: {
          ":status": "failed",
          ":error": `Cut/render failed: ${error instanceof Error ? error.message : String(error)}`,
          ":updatedAt": new Date().toISOString(),
        },
      }),
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function parseS3Uri(uri: string): { bucket: string; key: string } {
  const match = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`Invalid S3 URI: ${uri}`);
  return { bucket: match[1], key: match[2] };
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
