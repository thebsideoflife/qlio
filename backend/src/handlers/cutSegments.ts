/**
 * cutSegments — FFmpeg Docker Lambda handler
 *
 * Downloads the source video once, cuts each segment into a frame-accurate
 * clip, uploads clips to S3, then kicks off a Remotion render per clip.
 *
 * Invoked internally by renderVideo via Lambda.InvokeCommand.
 */
import { captionGroupingOptions } from "../utils/caption-grouping";
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
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { renderMediaOnLambda } from "@remotion/lambda/client";
import type { AwsRegion } from "@remotion/lambda";
import { spawn } from "child_process";
import { createWriteStream, createReadStream, promises as fs } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import path from "path";
import {
  captionsFromParsedTranscript,
  captionsOverlappingRange,
  parseTranscriptJson,
  shiftCaptionsBy,
} from "../utils/transcript-format";
import { extractClip, probeClipTiming } from "../utils/videoClip";
import {
  rebaseFramingKeyframesToClip,
  segmentFrameBounds,
} from "../utils/segmentFrameBounds";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});
const s3Client = new S3Client({});
const lambdaClient = new LambdaClient({});

const RENDER_JOBS_TABLE = process.env.RENDER_JOBS_TABLE!;
const MEDIA_BUCKET = process.env.MEDIA_BUCKET!;
const REMOTION_SERVE_URL = process.env.REMOTION_SERVE_URL!;
const REMOTION_FUNCTION_NAME = process.env.REMOTION_FUNCTION_NAME!;
const AWS_REGION_NAME = process.env.AWS_REGION_NAME!;
const CUT_WORKER_COUNT = 5;
// Remotion render Lambdas are deployed at 240s
// (`remotion-render-...-240sec`). delayRender must stay below that so a
// hung media fetch fails cleanly instead of SIGKILL. 180s leaves ~60s to
// render the 300-frame chunk after a large clip has loaded.
const DELAY_RENDER_TIMEOUT_MS = 180_000;

interface CutSegmentsEvent {
  jobId: string;
  segmentIds?: string[];
  worker?: boolean;
}

interface RenderSegment {
  id: string;
  startTime: number;
  endTime: number;
  title: string;
  framing?: Record<string, unknown>;
}

interface SegmentRender {
  segmentId: string;
  title: string;
  renderId: string;
  bucketName: string;
  outputKey: string;
  status: "rendering";
}

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

const DEFAULT_SOURCE_ASPECT = 16 / 9;

function parseFrameRate(raw: string | undefined): number | null {
  if (!raw || raw === "0/0") return null;
  const parts = raw.split("/");
  if (parts.length === 2) {
    const n = Number(parts[0]);
    const d = Number(parts[1]);
    if (n > 0 && d > 0) return n / d;
  }
  const v = Number(raw);
  return v > 0 ? v : null;
}

/** Same snap as the editor so Remotion's frame grid matches preview. */
const CANONICAL_FPS = [
  24000 / 1001,
  24,
  25,
  30000 / 1001,
  30,
  50,
  60000 / 1001,
  60,
  120000 / 1001,
  120,
];
const CANONICAL_FPS_MAX_DELTA = 0.012;

function canonicalizeFps(fps: number): number {
  let best = fps;
  let bestDelta = CANONICAL_FPS_MAX_DELTA;
  for (const candidate of CANONICAL_FPS) {
    const delta = Math.abs(fps - candidate);
    if (delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }
  return best;
}

/** Source width/height and fps from the downloaded file so Remotion matches the editor. */
function probeSourceVideo(inputPath: string): Promise<{
  aspect: number;
  fps: number;
}> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,r_frame_rate,avg_frame_rate",
      "-of", "json",
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
      try {
        const parsed = JSON.parse(stdout) as {
          streams?: Array<{
            width?: number;
            height?: number;
            r_frame_rate?: string;
            avg_frame_rate?: string;
          }>;
        };
        const stream = parsed.streams?.[0];
        const width = Number(stream?.width);
        const height = Number(stream?.height);
        if (!(width > 0) || !(height > 0)) {
          reject(new Error(`Could not parse dimensions from: ${stdout}`));
          return;
        }
        const fps =
          parseFrameRate(stream?.avg_frame_rate) ??
          parseFrameRate(stream?.r_frame_rate);
        if (!(fps && fps > 0)) {
          reject(new Error(`Could not parse frame rate from: ${stdout}`));
          return;
        }
        resolve({ aspect: width / height, fps: canonicalizeFps(fps) });
      } catch (error) {
        reject(error);
      }
    });
    ffprobe.on("error", reject);
  });
}

function partitionSegments(segments: RenderSegment[]): string[][] {
  const bins = Array.from(
    { length: Math.min(CUT_WORKER_COUNT, segments.length) },
    () => ({ duration: 0, ids: [] as string[] }),
  );

  for (const segment of [...segments].sort(
    (a, b) =>
      b.endTime - b.startTime - (a.endTime - a.startTime),
  )) {
    const bin = bins.reduce((least, current) =>
      current.duration < least.duration ? current : least,
    );
    bin.ids.push(segment.id);
    bin.duration += segment.endTime - segment.startTime;
  }

  console.log(
    "Exact-cut worker groups:",
    bins.map(({ ids, duration }) => ({ ids, duration })),
  );
  return bins.map((bin) => bin.ids);
}

async function invokeCutWorkers(
  jobId: string,
  segments: RenderSegment[],
): Promise<SegmentRender[]> {
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!functionName) {
    throw new Error("AWS_LAMBDA_FUNCTION_NAME is unavailable");
  }

  const workerResults = await Promise.all(
    partitionSegments(segments).map(async (segmentIds) => {
      const response = await lambdaClient.send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: "RequestResponse",
          Payload: Buffer.from(
            JSON.stringify({ jobId, segmentIds, worker: true }),
          ),
        }),
      );
      const payload = response.Payload
        ? Buffer.from(response.Payload).toString("utf8")
        : "";
      if (response.FunctionError) {
        throw new Error(
          `Exact-cut worker failed (${response.FunctionError}): ${payload}`,
        );
      }
      const parsed = JSON.parse(payload) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error(`Exact-cut worker returned invalid payload: ${payload}`);
      }
      return parsed as SegmentRender[];
    }),
  );

  return workerResults.flat();
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler: Handler<
  CutSegmentsEvent,
  SegmentRender[] | void
> = async (event) => {
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
    transcriptionCandidates,
    originalTranscriptionS3Uri,
    segments: jobSegments,
    captionSettings,
    globalFraming,
    outputFormat,
    compositionId,
  } = job;

  if (!Array.isArray(jobSegments) || jobSegments.length === 0) {
    throw new Error("No segments in job");
  }
  const requestedIds = event.segmentIds
    ? new Set(event.segmentIds)
    : null;
  const segments = (jobSegments as RenderSegment[]).filter(
    (segment) => !requestedIds || requestedIds.has(segment.id),
  );
  if (segments.length === 0) {
    throw new Error("No requested segments in job");
  }

  // The account caps this function at 3008MB (~1.7 vCPUs). Fan large exact
  // re-encodes across a few synchronous workers, then publish all render IDs
  // atomically so status polling never observes a partial list.
  if (!event.worker && segments.length > 1) {
    try {
      const segmentRenders = await invokeCutWorkers(jobId, segments);
      await updateJobWithRenders(jobId, segmentRenders);
      console.log(
        `cutSegments: launched ${segmentRenders.length} Remotion renders for job ${jobId}`,
      );
    } catch (error) {
      console.error("cutSegments coordinator failed:", error);
      await markJobFailed(jobId, error);
    }
    return;
  }

  // 2. Load captions from the current Whisper transcript (or its translation).
  // Same grouping + overlap rules as the editor — never a leftover TL file.
  let captions: ReturnType<typeof captionsFromParsedTranscript> = [];
  if (captionSettings?.enabled) {
    const uris = [
      ...(Array.isArray(transcriptionCandidates) ? transcriptionCandidates : []),
      transcriptionS3Uri,
      originalTranscriptionS3Uri,
    ].filter(
      (uri, index, list): uri is string =>
        typeof uri === "string" && uri.length > 0 && list.indexOf(uri) === index,
    );
    const { presignS3Uri } = await import("../utils/s3");
    for (const uri of uris) {
      try {
        const presignedUrl = await presignS3Uri(uri);
        if (!presignedUrl) continue;
        const response = await fetch(presignedUrl);
        if (!response.ok) {
          throw new Error(`Transcript fetch failed (${response.status}) for ${uri}`);
        }
        const data = (await response.json()) as unknown;
        const parsed = parseTranscriptJson(data);
        captions = captionsFromParsedTranscript(
          parsed,
          parsed.kind === "original" ? captionSettings.wordEdits : undefined,
          captionGroupingOptions(captionSettings.style, globalFraming?.aspectRatio),
        );
        console.log(
          `Loaded ${captions.length} caption lines from ${uri} (${parsed.kind})`,
        );
        break;
      } catch (error) {
        console.error(`Failed to load transcription ${uri}:`, error);
      }
    }
  }

  // 3. Download source video
  const { bucket, key } = parseS3Uri(sourceS3Uri);
  const tmpDir = `/tmp/${jobId}`;
  await fs.mkdir(tmpDir, { recursive: true });
  const inputPath = path.join(tmpDir, "source.mp4");
  await downloadFromS3(bucket, key, inputPath);

  let sourceAspect = DEFAULT_SOURCE_ASPECT;
  let sourceFps: number | undefined;
  try {
    const probed = await probeSourceVideo(inputPath);
    sourceAspect = probed.aspect;
    sourceFps = probed.fps;
    console.log(`Source aspect: ${sourceAspect}, fps: ${sourceFps}`);
  } catch (err) {
    console.warn("Failed to probe source video:", err);
  }

  try {
    // 3. Cut each segment and upload clip
    const clipUrls: Map<string, string> = new Map();

    // Clip start times and Remotion durations share one half-open frame range
    // so off-grid legacy bounds cannot produce a one-frame trim mismatch.
    // Captions + framing must use the same snapped clip clock as FFmpeg.
    const clipDurations = new Map<string, number>();
    const clipStarts = new Map<string, number>();
    const clipStartFrames = new Map<string, number>();

    for (const segment of segments) {
      const clipPath = path.join(tmpDir, `${segment.id}.mp4`);
      const bounds =
        sourceFps != null && sourceFps > 0
          ? segmentFrameBounds(segment.startTime, segment.endTime, sourceFps)
          : null;
      const duration =
        bounds?.durationSec ?? segment.endTime - segment.startTime;
      const startTime =
        bounds != null
          ? bounds.startFrame / (sourceFps as number)
          : segment.startTime;
      clipDurations.set(segment.id, duration);
      clipStarts.set(segment.id, startTime);
      if (bounds) clipStartFrames.set(segment.id, bounds.startFrame);

      await extractClip(
        inputPath,
        clipPath,
        startTime,
        duration,
        "accurate",
        sourceFps,
      );
      try {
        const { videoStartSec, audioStartSec, durationSec, nbFrames } =
          await probeClipTiming(clipPath);
        const avGap =
          videoStartSec != null && audioStartSec != null
            ? audioStartSec - videoStartSec
            : null;
        const durationError =
          durationSec != null ? durationSec - duration : null;
        console.log(
          `Clip ${segment.id} timing: videoStart=${videoStartSec ?? "?"}s audioStart=${audioStartSec ?? "?"}s avGap=${avGap ?? "?"}s duration=${durationSec ?? "?"}s durationError=${durationError ?? "?"}s nbFrames=${nbFrames ?? "?"} expectedFrames=${bounds?.durationInFrames ?? "?"}`,
        );
      } catch (probeErr) {
        console.warn(`Clip ${segment.id} ffprobe failed:`, probeErr);
      }

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
        const duration =
          clipDurations.get(segment.id) ??
          segment.endTime - segment.startTime;
        const clipStart =
          clipStarts.get(segment.id) ?? segment.startTime;
        const clipEnd = clipStart + duration;

        // Shift onto the snapped clip clock (same origin FFmpeg used), not the
        // raw stored segment.startTime — otherwise captions drift by up to ½ frame.
        const segmentCaptions = shiftCaptionsBy(
          captionsOverlappingRange(captions, clipStart, clipEnd),
          -clipStart,
        );

        const rawFraming = segment.framing || {
          aspectRatio: globalFraming.aspectRatio,
          mode: "crop",
          focusX: 0.5,
          focusY: 0.5,
          isAiGenerated: false,
        };
        const clipStartFrame = clipStartFrames.get(segment.id);
        const segmentFraming =
          clipStartFrame != null && sourceFps != null && sourceFps > 0
            ? {
                ...rawFraming,
                keyframes: rebaseFramingKeyframesToClip(
                  rawFraming.keyframes,
                  segment.startTime,
                  clipStartFrame,
                  sourceFps,
                ),
              }
            : rawFraming;

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
            globalFraming,
            sourceAspect,
            sourceFps,
          },
          codec: outputFormat === "webm" ? "vp8" : "h264",
          outName,
          privacy: "no-acl",
          timeoutInMilliseconds: DELAY_RENDER_TIMEOUT_MS,
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

    if (event.worker) {
      console.log(
        `cutSegments worker: launched ${segmentRenders.length} Remotion renders for job ${jobId}`,
      );
      return segmentRenders;
    }

    await updateJobWithRenders(jobId, segmentRenders);
    console.log(`cutSegments: launched ${segmentRenders.length} Remotion renders for job ${jobId}`);
  } catch (error) {
    console.error("cutSegments failed:", error);
    if (event.worker) throw error;
    await markJobFailed(jobId, error);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function updateJobWithRenders(
  jobId: string,
  segmentRenders: SegmentRender[],
): Promise<void> {
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
}

async function markJobFailed(jobId: string, error: unknown): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: RENDER_JOBS_TABLE,
      Key: { jobId },
      UpdateExpression:
        "SET #status = :status, #error = :error, updatedAt = :updatedAt",
      ExpressionAttributeNames: { "#status": "status", "#error": "error" },
      ExpressionAttributeValues: {
        ":status": "failed",
        ":error": `Cut/render failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        ":updatedAt": new Date().toISOString(),
      },
    }),
  );
}

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
