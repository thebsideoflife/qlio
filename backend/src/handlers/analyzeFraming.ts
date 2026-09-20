import { APIGatewayProxyHandler, Handler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import { checkAuth } from "../utils/auth";
import { sporelabsAnalyzeVideo } from "../services/sporelabs";

const execFileAsync = promisify(execFile);

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const lambdaClient = new LambdaClient({});
const s3Client = new S3Client({});

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const BUCKET_NAME = process.env.BUCKET_NAME!;
const SELF_FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME;
const FFMPEG_PATH = "/opt/bin/ffmpeg";

// Dynamic concurrency based on segment duration to avoid OOM
const MAX_CONCURRENCY = 5;
const LONG_SEGMENT_THRESHOLD_SEC = 120; // Segments > 2 min are "long"

function getConcurrencyLimit(segments: SegmentDescriptor[]): number {
  const maxDuration = Math.max(
    ...segments.map((s) => s.endTime - s.startTime),
  );
  // Long segments (>2 min): limit to 2 parallel to avoid OOM
  // Medium segments (1-2 min): limit to 3 parallel
  // Short segments (<1 min): full concurrency
  if (maxDuration > LONG_SEGMENT_THRESHOLD_SEC) return 2;
  if (maxDuration > 60) return 3;
  return MAX_CONCURRENCY;
}

// ============================================================================
// TYPES
// ============================================================================

type TargetAspectRatio = "16:9" | "1:1" | "9:16";

type ZoomLevel = "TIGHT" | "MEDIUM" | "WIDE" | "FULL";

interface FramingKeyframe {
  id: string;
  time: number;
  focusX: number;
  focusY: number;
  zoom: number;
  aiReasoning?: string;
  isAiGenerated: boolean;
}

interface FramingResult {
  mode: "crop" | "fit";
  focusX: number;
  focusY: number;
  aiReasoning: string;
  isAiGenerated: boolean;
}

interface SegmentDescriptor {
  id: string;
  startTime: number;
  endTime: number;
}

interface FramingJob {
  status: "pending" | "analyzing" | "completed" | "failed";
  jobId: string;
  startedAt: string;
  completedAt?: string;
  segmentCount?: number;
  completedCount?: number;
  error?: string;
}

interface AsyncJobPayload {
  isAsyncJob: true;
  projectId: string;
  segments: SegmentDescriptor[];
  targetAspectRatio: TargetAspectRatio;
  jobId: string;
}

// ============================================================================
// ZOOM MAPPING
// ============================================================================

const ZOOM_LEVEL_MAP: Record<ZoomLevel, number> = {
  TIGHT: 1.0,
  MEDIUM: 0.5,
  WIDE: 0.25,
  FULL: 0.0,
};

const VALID_ZOOM_LEVELS = new Set<string>(Object.keys(ZOOM_LEVEL_MAP));

// ============================================================================
// PARSING
// ============================================================================

function parseGeminiKeyframeResponse(
  response: string,
  segmentDuration: number,
): FramingKeyframe[] {
  const lines = response
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("//"));

  if (lines.length === 0) {
    return [makeFallbackKeyframe()];
  }

  const keyframes: FramingKeyframe[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split("|").map((p) => p.trim().toUpperCase());

    if (parts.length < 2) {
      console.warn(`[Framing] Skipping malformed line: "${line}"`);
      continue;
    }

    const timestamp = parseTimestamp(parts[0]);
    if (timestamp === null || timestamp < 0) continue;

    const time = Math.min(timestamp, segmentDuration);
    const zoomToken = parts[1];
    const zoom =
      ZOOM_LEVEL_MAP[zoomToken as ZoomLevel] ?? ZOOM_LEVEL_MAP.MEDIUM;

    keyframes.push({
      id: randomUUID(),
      time,
      focusX: 0.5,
      focusY: 0.5,
      zoom,
      aiReasoning: `${zoomToken.toLowerCase()} at ${time.toFixed(1)}s`,
      isAiGenerated: true,
    });
  }

  if (keyframes.length === 0) {
    return [makeFallbackKeyframe()];
  }

  keyframes.sort((a, b) => a.time - b.time);
  if (keyframes[0].time > 0) {
    keyframes[0].time = 0;
  }

  // Deduplicate consecutive keyframes with identical zoom
  const deduped: FramingKeyframe[] = [keyframes[0]];
  for (let i = 1; i < keyframes.length; i++) {
    const prev = deduped[deduped.length - 1];
    const curr = keyframes[i];
    if (curr.zoom === prev.zoom) continue;
    deduped.push(curr);
  }

  const enforced = enforceMinHold(deduped, segmentDuration);

  // Dedup again — enforcing can create new consecutive identical zooms
  const final: FramingKeyframe[] = [enforced[0]];
  for (let i = 1; i < enforced.length; i++) {
    if (enforced[i].zoom !== final[final.length - 1].zoom) {
      final.push(enforced[i]);
    }
  }

  return final;
}

const MIN_HOLD_SECONDS = 5;

/**
 * Enforce a minimum hold duration per keyframe. When two consecutive keyframes
 * are closer than MIN_HOLD_SECONDS, merge them:
 * - Default: keep the WIDER (lower zoom) to avoid over-aggressive framing
 * - Exception: if one keyframe's hold is ≥2x the other's, use the longer one's
 *   zoom (it's the dominant framing for that period)
 * Runs iteratively until no more violations remain.
 */
function enforceMinHold(
  keyframes: FramingKeyframe[],
  segmentDuration: number,
): FramingKeyframe[] {
  if (keyframes.length <= 1) return keyframes;

  let result = [...keyframes];
  let changed = true;

  while (changed) {
    changed = false;
    for (let i = 0; i < result.length - 1; i++) {
      const holdI = result[i + 1].time - result[i].time;
      if (holdI < MIN_HOLD_SECONDS) {
        const nextNextTime =
          i + 2 < result.length ? result[i + 2].time : segmentDuration;
        const holdNext = nextNextTime - result[i + 1].time;

        let winnerZoom: number;
        if (holdNext >= holdI * 2) {
          winnerZoom = result[i + 1].zoom; // next is much longer — use its zoom
        } else if (holdI >= holdNext * 2) {
          winnerZoom = result[i].zoom; // current is much longer — use its zoom
        } else {
          winnerZoom = Math.min(result[i].zoom, result[i + 1].zoom); // wider wins
        }

        result[i] = { ...result[i], zoom: winnerZoom };
        result.splice(i + 1, 1);
        changed = true;
        break;
      }
    }
  }

  // Drop keyframes that start in the last MIN_HOLD_SECONDS (can't hold long enough)
  // Always keep at least the first keyframe (time=0)
  if (result.length > 1) {
    const filtered = result.filter(
      (kf, i) => i === 0 || segmentDuration - kf.time >= MIN_HOLD_SECONDS,
    );
    if (filtered.length > 0) result = filtered;
  }

  return result;
}

/**
 * Parse timestamps in formats: "30.5" (seconds), "1:03.0" (M:SS.S), "0.19" ambiguous.
 * Gemini sometimes outputs "0.19" meaning 19s (not 0.19s). Heuristic: if the integer
 * part is 0 and the decimal part has 2+ digits, treat as M:SS (i.e. 0 min 19 sec).
 */
function parseTimestamp(raw: string): number | null {
  const trimmed = raw.trim();

  // Handle M:SS or MM:SS format
  const colonMatch = trimmed.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
  if (colonMatch) {
    const minutes = parseInt(colonMatch[1], 10);
    const seconds = parseFloat(colonMatch[2]);
    return minutes * 60 + seconds;
  }

  // Plain number — but detect ambiguous "0.19" meaning 19s
  const val = parseFloat(trimmed);
  if (isNaN(val)) return null;

  // If format is "0.XX" where XX is 2+ digits, Gemini likely means 0 min XX sec
  const dotMatch = trimmed.match(/^0\.(\d{2,})$/);
  if (dotMatch) {
    return parseFloat(dotMatch[1]);
  }

  return val;
}

function makeFallbackKeyframe(): FramingKeyframe {
  return {
    id: `ai-kf-fb-${randomUUID()}`,
    time: 0,
    focusX: 0.5,
    focusY: 0.5,
    zoom: 0.5,
    aiReasoning: "Could not parse AI response, defaulting to medium",
    isAiGenerated: true,
  };
}

function keyframesToLegacyResult(keyframes: FramingKeyframe[]): FramingResult {
  const first = keyframes[0] || makeFallbackKeyframe();
  return {
    mode: first.zoom >= 0.5 ? "crop" : "fit",
    focusX: first.focusX,
    focusY: first.focusY,
    aiReasoning: first.aiReasoning || "AI-generated framing",
    isAiGenerated: true,
  };
}

// ============================================================================
// GEMINI HELPERS (via SporeLabs, model google/gemini-2.5-pro)
// ============================================================================

function buildGeminiPrompt(segmentDuration: number): string {
  return `You are analyzing a video clip to decide how to crop it from 16:9 landscape to 9:16 vertical.

The video has colored guide lines showing exactly where each crop level cuts:
- RED lines: TIGHT crop — only the area between the red lines will be visible
- YELLOW lines: MEDIUM crop — the area between yellow lines will be visible
- GREEN lines: WIDE crop — the area between green lines will be visible
- FULL: no crop, the entire frame is shown (with letterboxing)

The area outside the red lines is slightly darkened to help you see the TIGHT crop region.

Your job: at each moment, pick the crop level where all important subjects fit inside the lines.

Format: TIME|ZOOM
- TIME: plain decimal seconds from start, e.g. 0.0, 8.5, 35.2, 120.0 (NOT minutes:seconds, NOT timestamps)
- ZOOM: TIGHT, MEDIUM, WIDE, or FULL
- The clip is ${segmentDuration.toFixed(1)} seconds long, so TIME ranges from 0.0 to ${segmentDuration.toFixed(1)}

Decision guide:
- Use TIGHT (red) when all subjects fit between the red lines — gives the most impactful close framing
- Use MEDIUM (yellow) if subjects spill outside red but fit inside yellow
- Use WIDE (green) if subjects spill outside yellow but fit inside green
- Use FULL only if subjects extend beyond the green lines

Rules:
- First keyframe MUST be at 0.0
- Add a new keyframe when the shot changes or subjects move enough to need a different crop
- If nothing changes, output just one line
- Maximum 8 keyframes per clip

Output ONLY the TIME|ZOOM lines. No explanations.`;
}

// ============================================================================
// FFMPEG + GEMINI PIPELINE
// ============================================================================

async function cutSegmentClip(
  s3Key: string,
  startTime: number,
  duration: number,
  outputPath: string,
): Promise<void> {
  const presignedUrl = await getSignedUrl(
    s3Client,
    new GetObjectCommand({ Bucket: BUCKET_NAME, Key: s3Key }),
    { expiresIn: 900 },
  );

  const args = [
    "-ss",
    startTime.toFixed(3),
    "-t",
    duration.toFixed(3),
    "-i",
    presignedUrl,
    "-c",
    "copy",
    "-y",
    outputPath,
  ];

  console.log(
    `[Framing] FFmpeg cutting ${startTime.toFixed(1)}s-${(startTime + duration).toFixed(1)}s → ${outputPath}`,
  );
  await execFileAsync(FFMPEG_PATH, args, { timeout: 120_000 });
}

async function uploadClipForAnalysis(
  localPath: string,
  jobId: string,
  segIndex: number,
): Promise<{ key: string; url: string }> {
  const key = `tmp/framing/${jobId}/segment-${segIndex}.mp4`;
  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: fs.createReadStream(localPath),
      ContentType: "video/mp4",
    }),
  );
  const url = await getSignedUrl(
    s3Client,
    new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }),
    { expiresIn: 900 },
  );
  return { key, url };
}

async function analyzeSegmentWithGemini(
  videoUrl: string,
  segmentDuration: number,
): Promise<FramingKeyframe[]> {
  const prompt = buildGeminiPrompt(segmentDuration);
  const responseText = await sporelabsAnalyzeVideo({
    prompt,
    videoUrl,
  });
  console.log(`[Framing] Gemini response: ${responseText}`);
  return parseGeminiKeyframeResponse(responseText, segmentDuration);
}

async function getAnnotatedKey(s3Key: string): Promise<string> {
  // Check for annotated version: raw/abc.mp4 → annotated/abc.mp4
  const annotatedKey = s3Key.replace(/^raw\//, "annotated/");
  if (annotatedKey === s3Key) return s3Key; // no raw/ prefix, use original

  try {
    await s3Client.send(
      new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: annotatedKey }),
    );
    console.log(`[Framing] Using annotated version: ${annotatedKey}`);
    return annotatedKey;
  } catch {
    return s3Key; // annotated version doesn't exist, use original
  }
}

async function processSegment(
  jobId: string,
  s3Key: string,
  segment: SegmentDescriptor,
  segIndex: number,
): Promise<FramingKeyframe[]> {
  const duration = segment.endTime - segment.startTime;
  const clipPath = `/tmp/segment-${segIndex}.mp4`;
  let uploadedKey: string | undefined;

  try {
    await cutSegmentClip(s3Key, segment.startTime, duration, clipPath);
    const uploaded = await uploadClipForAnalysis(clipPath, jobId, segIndex);
    uploadedKey = uploaded.key;
    return await analyzeSegmentWithGemini(uploaded.url, duration);
  } catch (err) {
    console.error(
      `[Framing] Segment ${segIndex} (${segment.startTime.toFixed(1)}s-${segment.endTime.toFixed(1)}s) failed:`,
      err,
    );
    return [makeFallbackKeyframe()];
  } finally {
    try {
      fs.unlinkSync(clipPath);
    } catch {}
    if (uploadedKey) {
      try {
        await s3Client.send(
          new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: uploadedKey }),
        );
      } catch {}
    }
  }
}

// ============================================================================
// SHARED HELPERS
// ============================================================================

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

function errorResponse(statusCode: number, error: string) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify({ error }),
  };
}

function successResponse(data: object) {
  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify(data),
  };
}

async function getAssetRecord(projectId: string) {
  const projectRes = await docClient.send(
    new GetCommand({ TableName: PROJECTS_TABLE, Key: { projectId } }),
  );
  if (!projectRes.Item) throw { statusCode: 404, message: "Project not found" };

  const assetId = projectRes.Item.assetId;
  const assetRes = await docClient.send(
    new GetCommand({ TableName: ASSETS_TABLE, Key: { assetId } }),
  );
  if (!assetRes.Item) throw { statusCode: 404, message: "Asset not found" };

  return {
    assetId,
    asset: assetRes.Item,
    project: projectRes.Item,
  };
}

async function updateFramingJob(
  projectId: string,
  updates: Partial<FramingJob>,
): Promise<void> {
  const expressions: string[] = ["updatedAt = :u"];
  const names: Record<string, string> = {};
  const values: Record<string, any> = { ":u": new Date().toISOString() };

  for (const [key, val] of Object.entries(updates)) {
    const attrName = `#fj_${key}`;
    const attrVal = `:fj_${key}`;
    expressions.push(`framingJob.${attrName} = ${attrVal}`);
    names[attrName] = key;
    values[attrVal] = val;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: PROJECTS_TABLE,
      Key: { projectId },
      UpdateExpression: `set ${expressions.join(", ")}`,
      ExpressionAttributeNames:
        Object.keys(names).length > 0 ? names : undefined,
      ExpressionAttributeValues: values,
    }),
  );
}

// ============================================================================
// SINGLE SEGMENT HANDLER — async via the shared framingJob system
// ============================================================================

async function handleSingleSegment(
  projectId: string,
  segmentId: string | undefined,
  body: Record<string, unknown>,
) {
  const startTime = body.startTime as number;
  const endTime = body.endTime as number;

  if (!segmentId) {
    return errorResponse(400, "Missing segmentId");
  }
  if (typeof body.startTime !== "number" || typeof body.endTime !== "number") {
    return errorResponse(400, "Missing or invalid startTime/endTime");
  }
  if (endTime <= startTime) {
    return errorResponse(400, "endTime must be greater than startTime");
  }

  return handleStartBatch(projectId, {
    segments: [{ id: segmentId, startTime, endTime }],
    targetAspectRatio: body.targetAspectRatio,
  });
}

// ============================================================================
// BATCH HANDLER — Async: start job + self-invoke
// ============================================================================

async function handleStartBatch(
  projectId: string,
  body: Record<string, unknown>,
) {
  const { segments: rawSegments, targetAspectRatio } = body;

  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    return errorResponse(
      400,
      "segments array is required and must not be empty",
    );
  }

  const segments: SegmentDescriptor[] = [];
  for (const seg of rawSegments) {
    if (
      !seg ||
      typeof seg.id !== "string" ||
      typeof seg.startTime !== "number" ||
      typeof seg.endTime !== "number" ||
      seg.endTime <= seg.startTime
    ) {
      return errorResponse(400, `Invalid segment: ${JSON.stringify(seg)}`);
    }
    segments.push({
      id: seg.id,
      startTime: seg.startTime,
      endTime: seg.endTime,
    });
  }

  const validAspectRatios: TargetAspectRatio[] = ["16:9", "1:1", "9:16"];
  const aspectRatio: TargetAspectRatio = validAspectRatios.includes(
    targetAspectRatio as TargetAspectRatio,
  )
    ? (targetAspectRatio as TargetAspectRatio)
    : "9:16";

  // Reject if a job is already running (unless it's stale — >15 min old)
  const projectCheck = await docClient.send(
    new GetCommand({ TableName: PROJECTS_TABLE, Key: { projectId } }),
  );
  const existingJob = projectCheck.Item?.framingJob;
  if (
    existingJob &&
    (existingJob.status === "pending" || existingJob.status === "analyzing")
  ) {
    const ageMs = Date.now() - new Date(existingJob.startedAt).getTime();
    const STALE_THRESHOLD_MS = 15 * 60 * 1000;
    if (ageMs < STALE_THRESHOLD_MS) {
      return errorResponse(
        409,
        "A framing job is already running for this project",
      );
    }
    console.log(
      `[Framing] Overwriting stale job ${existingJob.jobId} (${Math.round(ageMs / 1000)}s old)`,
    );
  }

  const jobId = randomUUID();

  await docClient.send(
    new UpdateCommand({
      TableName: PROJECTS_TABLE,
      Key: { projectId },
      UpdateExpression: "set framingJob = :job, updatedAt = :u",
      ExpressionAttributeValues: {
        ":job": {
          status: "pending",
          jobId,
          startedAt: new Date().toISOString(),
          segmentCount: segments.length,
          completedCount: 0,
        } as FramingJob,
        ":u": new Date().toISOString(),
      },
    }),
  );

  const payload: AsyncJobPayload = {
    isAsyncJob: true,
    projectId,
    segments,
    targetAspectRatio: aspectRatio,
    jobId,
  };

  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: SELF_FUNCTION_NAME,
      InvocationType: "Event",
      Payload: JSON.stringify(payload),
    }),
  );

  console.log(
    `[Framing] Started async batch job ${jobId}: ${segments.length} segments`,
  );

  return {
    statusCode: 202,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      message: "Framing analysis started",
      jobId,
      status: "pending",
    }),
  };
}

// ============================================================================
// ASYNC JOB EXECUTION — Gemini per-segment pipeline
// ============================================================================

async function executeFramingJob(payload: AsyncJobPayload): Promise<void> {
  const { projectId, segments, targetAspectRatio, jobId } = payload;

  console.log(
    `[Framing] Executing job ${jobId}: ${segments.length} segments (target: ${targetAspectRatio})`,
  );

  // Clean up any leftover files from previous runs to ensure clean slate
  try {
    const tmpFiles = fs.readdirSync("/tmp").filter((f) => f.startsWith("segment-"));
    for (const file of tmpFiles) {
      try {
        fs.unlinkSync(`/tmp/${file}`);
      } catch {}
    }
    if (tmpFiles.length > 0) {
      console.log(`[Framing] Cleaned up ${tmpFiles.length} leftover files from /tmp`);
    }
  } catch {}

  try {
    // Verify this job is still the active one
    const check = await docClient.send(
      new GetCommand({ TableName: PROJECTS_TABLE, Key: { projectId } }),
    );
    if (check.Item?.framingJob?.jobId !== jobId) {
      console.log(`[Framing] Job ${jobId} superseded, aborting`);
      return;
    }

    await updateFramingJob(projectId, { status: "analyzing" });

    // For 16:9, no AI needed — just use fit framing
    if (targetAspectRatio === "16:9") {
      await writeFramingResults(
        projectId,
        segments,
        new Map(
          segments.map((_, i) => [
            i,
            [
              {
                id: randomUUID(),
                time: 0,
                focusX: 0.5,
                focusY: 0.5,
                zoom: 0.0,
                aiReasoning: "Fit for landscape",
                isAiGenerated: true,
              },
            ],
          ]),
        ),
        targetAspectRatio,
        jobId,
      );
      await updateFramingJob(projectId, {
        status: "completed",
        completedAt: new Date().toISOString(),
        completedCount: segments.length,
      });
      return;
    }

    // Get asset S3 key
    const { asset } = await getAssetRecord(projectId);
    const s3Key = await getAnnotatedKey(asset.key);

    // Process segments in parallel with dynamic concurrency limit
    const allKeyframes = new Map<number, FramingKeyframe[]>();
    let completedCount = 0;
    const concurrency = getConcurrencyLimit(segments);
    console.log(
      `[Framing] Using concurrency ${concurrency} (max segment: ${Math.max(...segments.map((s) => s.endTime - s.startTime)).toFixed(0)}s)`,
    );

    const processWithLimit = async () => {
      const queue = segments.map((seg, i) => ({ seg, i }));
      const workers = Array.from(
        { length: Math.min(concurrency, queue.length) },
        async () => {
          while (queue.length > 0) {
            const item = queue.shift()!;
            console.log(
              `[Framing] Processing segment ${item.i + 1}/${segments.length}: ${item.seg.startTime.toFixed(1)}s-${item.seg.endTime.toFixed(1)}s`,
            );

            const keyframes = await processSegment(
              jobId,
              s3Key,
              item.seg,
              item.i,
            );
            allKeyframes.set(item.i, keyframes);

            completedCount++;
            await updateFramingJob(projectId, { completedCount });
          }
        },
      );

      await Promise.all(workers);
    };

    await processWithLimit();

    // Write all results
    await writeFramingResults(
      projectId,
      segments,
      allKeyframes,
      targetAspectRatio,
      jobId,
    );
    await updateFramingJob(projectId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      completedCount: segments.length,
    });

    console.log(
      `[Framing] Job ${jobId} completed: ${segments.length} segments`,
    );
  } catch (err) {
    console.error(`[Framing] Job ${jobId} failed:`, err);
    await updateFramingJob(projectId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : "Unknown error",
    }).catch(() => {});
  }
}

/**
 * Write framing results directly into the project's segments in DynamoDB.
 */
async function writeFramingResults(
  projectId: string,
  requestedSegments: SegmentDescriptor[],
  keyframesMap: Map<number, FramingKeyframe[]>,
  targetAspectRatio: TargetAspectRatio,
  jobId?: string,
): Promise<void> {
  const projectRes = await docClient.send(
    new GetCommand({ TableName: PROJECTS_TABLE, Key: { projectId } }),
  );
  if (!projectRes.Item)
    throw new Error("Project not found during result write");

  if (jobId && projectRes.Item.framingJob?.jobId !== jobId) {
    console.log(`[Framing] Job ${jobId} superseded before write, aborting`);
    return;
  }

  const currentSegments = projectRes.Item.segments || [];

  const framingBySegmentId = new Map<
    string,
    { keyframes: FramingKeyframe[]; legacy: FramingResult }
  >();
  for (let i = 0; i < requestedSegments.length; i++) {
    const kfs = keyframesMap.get(i) || [makeFallbackKeyframe()];
    framingBySegmentId.set(requestedSegments[i].id, {
      keyframes: kfs,
      legacy: keyframesToLegacyResult(kfs),
    });
  }

  const updatedSegments = currentSegments.map((seg: any) => {
    const result = framingBySegmentId.get(seg.id);
    if (!result) return seg;

    return {
      ...seg,
      framing: {
        ...(seg.framing || {}),
        aspectRatio: targetAspectRatio,
        mode: result.legacy.mode,
        focusX: result.legacy.focusX,
        focusY: result.legacy.focusY,
        aiReasoning: result.legacy.aiReasoning,
        isAiGenerated: true,
        keyframes: result.keyframes,
      },
    };
  });

  await docClient.send(
    new UpdateCommand({
      TableName: PROJECTS_TABLE,
      Key: { projectId },
      UpdateExpression: "set #seg = :s, updatedAt = :u",
      ExpressionAttributeNames: { "#seg": "segments" },
      ExpressionAttributeValues: {
        ":s": updatedSegments,
        ":u": new Date().toISOString(),
      },
    }),
  );

  console.log(
    `[Framing] Wrote framing for ${framingBySegmentId.size} segments to DynamoDB`,
  );
}

// ============================================================================
// HANDLER — Routes between API Gateway and async self-invoke
// ============================================================================

export const handler: Handler = async (event, context, callback) => {
  if (event.isAsyncJob) {
    return executeFramingJob(event as AsyncJobPayload);
  }
  // Direct Lambda-to-Lambda invocation (e.g., from generateSegments)
  if (event.isDirectBatchStart) {
    return handleStartBatch(event.projectId, event);
  }
  return handleApiRequest(event, context, callback);
};

const handleApiRequest: APIGatewayProxyHandler = async (event) => {
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  try {
    const projectId = event.pathParameters?.projectId;
    const segmentId = event.pathParameters?.segmentId;

    if (!projectId) return errorResponse(400, "Missing projectId");

    const body = JSON.parse(event.body || "{}");

    if (Array.isArray(body.segments)) {
      return await handleStartBatch(projectId, body);
    }

    return await handleSingleSegment(projectId, segmentId, body);
  } catch (error: any) {
    if (error.statusCode) {
      return errorResponse(error.statusCode, error.message);
    }
    console.error("[Framing] Unexpected error:", error);
    return errorResponse(500, "Failed to analyze framing");
  }
};
