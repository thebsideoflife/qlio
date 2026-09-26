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
} from "@aws-sdk/client-s3";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { renderMediaOnLambda } from "@remotion/lambda/client";
import type { AwsRegion } from "@remotion/lambda";
import { spawn } from "child_process";
import { createWriteStream, promises as fs } from "fs";
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
import { uploadClipToS3 } from "../utils/uploadClipToS3";
import {
  rebaseFramingKeyframesToClip,
  segmentFrameBounds,
} from "../utils/segmentFrameBounds";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});
// S3 returns occasional 500 InternalError under load; one bad GET must not
// sink a whole export.
const s3Client = new S3Client({ maxAttempts: 6 });
const lambdaClient = new LambdaClient({});

const RENDER_JOBS_TABLE = process.env.RENDER_JOBS_TABLE!;
const MEDIA_BUCKET = process.env.MEDIA_BUCKET!;
const REMOTION_SERVE_URL = process.env.REMOTION_SERVE_URL!;
const REMOTION_FUNCTION_NAME = process.env.REMOTION_FUNCTION_NAME!;
const AWS_REGION_NAME = process.env.AWS_REGION_NAME!;
const CUT_WORKER_COUNT = 10;
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
  status: "rendering" | "failed";
  error?: string;
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

async function invokeCutWorker(
  jobId: string,
  segmentIds: string[],
): Promise<SegmentRender[]> {
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!functionName) {
    throw new Error("AWS_LAMBDA_FUNCTION_NAME is unavailable");
  }
  const response = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify({ jobId, segmentIds, worker: true })),
    }),
  );
  const payload = response.Payload
    ? Buffer.from(response.Payload).toString("utf8")
    : "";
  if (response.FunctionError) {
    throw new Error(`Exact-cut worker failed (${response.FunctionError}): ${payload}`);
  }
  const parsed = JSON.parse(payload) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Exact-cut worker returned invalid payload: ${payload}`);
  }
  return parsed as SegmentRender[];
}

/**
 * Run every worker group to completion. A failed group is retried once, then
 * its scenes are reported as failed — the other groups' renders still count.
 */
async function invokeCutWorkers(
  jobId: string,
  segments: RenderSegment[],
): Promise<SegmentRender[]> {
  const groups = partitionSegments(segments);
  const results = await Promise.all(
    groups.map(async (segmentIds) => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          return await invokeCutWorker(jobId, segmentIds);
        } catch (error) {
          lastError = error;
          console.error(
            `Exact-cut worker for ${segmentIds.join(",")} failed (attempt ${attempt}):`,
            error,
          );
        }
      }
      return failedRenders(
        segments.filter((segment) => segmentIds.includes(segment.id)),
        lastError,
      );
    }),
  );
  return results.flat();
}

function failedRenders(
  segments: RenderSegment[],
  error: unknown,
): SegmentRender[] {
  const message = error instanceof Error ? error.message : String(error);
  return segments.map((segment) => ({
    segmentId: segment.id,
    title: segment.title,
    renderId: "",
    bucketName: "",
    outputKey: "",
    status: "failed" as const,
    error: `Cut failed: ${message}`.slice(0, 2000),
  }));
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
  // A cancelled, timed-out or finished job must never be revived.
  if (job.status !== "rendering") {
    console.log(`cutSegments: job ${jobId} is ${job.status}; nothing to do`);
    return event.worker ? [] : undefined;
  }

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
    let segmentRenders: SegmentRender[];
    try {
      segmentRenders = await invokeCutWorkers(jobId, segments);
    } catch (error) {
      console.error("cutSegments coordinator failed:", error);
      segmentRenders = failedRenders(segments, error);
    }
    await mergeJobRenders(jobId, segmentRenders);
    console.log(
      `cutSegments: launched ${segmentRenders.filter((r) => r.status === "rendering").length} of ${segments.length} Remotion renders for job ${jobId}`,
    );
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
    let loaded = uris.length === 0;
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
        loaded = true;
        break;
      } catch (error) {
        console.error(`Failed to load transcription ${uri}:`, error);
      }
    }
    // Rendering without burned-in captions would look like success. Fail so
    // the scene is retried instead.
    if (!loaded) {
      const error = new Error("Could not load captions transcript");
      if (event.worker) throw error;
      await mergeJobRenders(jobId, failedRenders(segments, error));
      return;
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
      await uploadClipToS3(s3Client, clipPath, MEDIA_BUCKET, clipKey);

      const clipUrl = await getSignedUrl(
        s3Client,
        new GetObjectCommand({ Bucket: MEDIA_BUCKET, Key: clipKey }),
        { expiresIn: 604800 },
      );
      clipUrls.set(segment.id, clipUrl);

      // Free disk space
      await fs.unlink(clipPath);
    }

    // Cutting takes minutes; the user may have cancelled meanwhile. Don't
    // spend Remotion capacity on a job nobody is waiting for.
    if (!(await jobIsRendering(jobId))) {
      console.log(`cutSegments: job ${jobId} ended while cutting; not launching`);
      return event.worker ? [] : undefined;
    }

    // 4. Kick off Remotion renders per clip
    console.log(`Starting ${segments.length} Remotion renders`);
    const segmentRenders: SegmentRender[] = await Promise.all(
      segments.map(async (segment: any): Promise<SegmentRender> => {
       try {
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
          // Chunk-level retries for Lambda throttling/capacity blips; whole
          // scene retries live in getRenderStatus.
          maxRetries: 3,
        });

        return {
          segmentId: segment.id,
          title: segment.title,
          renderId: renderResponse.renderId,
          bucketName: renderResponse.bucketName,
          outputKey: `renders/${renderResponse.renderId}/${outName}`,
          status: "rendering" as const,
        };
       } catch (error) {
        // One scene failing to launch must not drop its siblings' renders.
        console.error(`Remotion launch failed for ${segment.id}:`, error);
        return failedRenders([segment], error)[0];
       }
      }),
    );

    if (event.worker) {
      console.log(
        `cutSegments worker: launched ${segmentRenders.length} Remotion renders for job ${jobId}`,
      );
      return segmentRenders;
    }

    await mergeJobRenders(jobId, segmentRenders);
    console.log(`cutSegments: launched ${segmentRenders.length} Remotion renders for job ${jobId}`);
  } catch (error) {
    console.error("cutSegments failed:", error);
    if (event.worker) throw error;
    await mergeJobRenders(jobId, failedRenders(segments, error));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Replace these scenes' entries on the job, keeping every other scene
 * (reused renders, other workers, earlier retries). Versioned so it never
 * overwrites a concurrent status-poll write.
 */
export async function mergeJobRenders(
  jobId: string,
  renders: SegmentRender[],
): Promise<void> {
  const now = new Date().toISOString();
  for (let attempt = 0; attempt < 10; attempt++) {
    const { Item: job } = await docClient.send(
      new GetCommand({ TableName: RENDER_JOBS_TABLE, Key: { jobId } }),
    );
    if (!job) throw new Error(`Job ${jobId} not found`);
    // Never write a cancelled/timed-out/finished job back to "rendering".
    if (job.status !== "rendering") {
      console.log(`cutSegments: job ${jobId} is ${job.status}; dropping renders`);
      return;
    }
    const byId = new Map<string, Record<string, unknown>>(
      ((job.segmentRenders || []) as Array<Record<string, unknown>>).map(
        (entry) => [entry.segmentId as string, entry],
      ),
    );
    for (const render of renders) {
      const previous = byId.get(render.segmentId);
      byId.set(render.segmentId, {
        ...render,
        attempts: (previous?.attempts as number | undefined) ?? 1,
        ...(render.status === "rendering" ? { launchedAt: now } : {}),
      });
    }
    const rev = typeof job.rev === "number" ? job.rev : null;
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: RENDER_JOBS_TABLE,
          Key: { jobId },
          UpdateExpression:
            "SET segmentRenders = :segmentRenders, #status = :status, updatedAt = :updatedAt, rev = :nextRev",
          ConditionExpression: `${
            rev === null ? "attribute_not_exists(rev)" : "rev = :rev"
          } AND #status = :status`,
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":segmentRenders": Array.from(byId.values()),
            ":status": "rendering",
            ":updatedAt": now,
            ":nextRev": (rev ?? 0) + 1,
            ...(rev === null ? {} : { ":rev": rev }),
          },
        }),
      );
      return;
    } catch (error) {
      if ((error as { name?: string }).name !== "ConditionalCheckFailedException") {
        throw error;
      }
    }
  }
  throw new Error(`Could not record renders for job ${jobId}`);
}

async function jobIsRendering(jobId: string): Promise<boolean> {
  const { Item } = await docClient.send(
    new GetCommand({
      TableName: RENDER_JOBS_TABLE,
      Key: { jobId },
      ProjectionExpression: "#status",
      ExpressionAttributeNames: { "#status": "status" },
    }),
  );
  return Item?.status === "rendering";
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
