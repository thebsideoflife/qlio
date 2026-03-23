import { APIGatewayProxyHandler, Handler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager, FileState } from "@google/generative-ai/server";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { checkAuth } from "../utils/auth";

const execFileAsync = promisify(execFile);

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const secretsClient = new SecretsManagerClient({});
const lambdaClient = new LambdaClient({});
const s3Client = new S3Client({});

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const BUCKET_NAME = process.env.BUCKET_NAME!;
const GEMINI_SECRET_ARN = process.env.GEMINI_SECRET_ARN!;
const SELF_FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME;
const FFMPEG_PATH = "/opt/bin/ffmpeg";

const CONCURRENCY_LIMIT = 5;

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

    const timestamp = parseFloat(parts[0]);
    if (isNaN(timestamp) || timestamp < 0) continue;

    const time = Math.min(timestamp, segmentDuration);
    const zoomToken = parts[1];
    const zoom =
      ZOOM_LEVEL_MAP[zoomToken as ZoomLevel] ?? ZOOM_LEVEL_MAP.MEDIUM;

    keyframes.push({
      id: `ai-kf-${i}`,
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

  deduped.forEach((kf, i) => {
    kf.id = `ai-kf-${i}`;
  });

  return deduped;
}

function makeFallbackKeyframe(): FramingKeyframe {
  return {
    id: "ai-kf-0",
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
// GEMINI HELPERS
// ============================================================================

let geminiClient: GoogleGenerativeAI | null = null;
let fileManager: GoogleAIFileManager | null = null;

async function getGeminiClient(): Promise<GoogleGenerativeAI> {
  if (geminiClient) return geminiClient;
  const secret = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: GEMINI_SECRET_ARN }),
  );
  if (!secret.SecretString) throw new Error("Gemini API key not found");
  geminiClient = new GoogleGenerativeAI(secret.SecretString);
  fileManager = new GoogleAIFileManager(secret.SecretString);
  return geminiClient;
}

function getFileManager(): GoogleAIFileManager {
  if (!fileManager) throw new Error("Call getGeminiClient() first");
  return fileManager;
}

function buildGeminiPrompt(segmentDuration: number): string {
  return `You are analyzing a short video clip for framing decisions. This clip will be cropped from 16:9 landscape to a vertical (9:16) or square (1:1) format.

Your job: decide how tightly to zoom in at each moment. Output zoom keyframes.

Format: TIME|ZOOM
- TIME: seconds from start of this clip (0.0 to ${segmentDuration.toFixed(1)})
- ZOOM: one of TIGHT, MEDIUM, WIDE, FULL

Zoom guide:
- TIGHT: One person's face/upper body fills the frame. Use for close-ups, interviews, emotional moments.
- MEDIUM: One person with breathing room, or two people close together. Default for dialogue.
- WIDE: Two+ people who need space between them, someone walking/moving, action scenes.
- FULL: Establishing shots, large groups, landscapes, wide rooms. Shows the entire frame.

Rules:
- First keyframe MUST be at 0.0
- Only add a new keyframe when the shot composition actually changes (cut, camera move, people entering/exiting)
- If nothing changes, output just one line
- Maximum 20 keyframes per clip
- Watch for actual shot changes — don't invent transitions that aren't there

Output ONLY the lines. No explanations, no markdown.`;
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

async function uploadToGemini(filePath: string): Promise<string> {
  const fm = getFileManager();

  const uploadResult = await fm.uploadFile(filePath, {
    mimeType: "video/mp4",
    displayName: path.basename(filePath),
  });

  let file = uploadResult.file;
  console.log(`[Framing] Uploaded ${filePath} → ${file.name} (${file.state})`);

  // Poll until ACTIVE
  let attempts = 0;
  while (file.state === FileState.PROCESSING && attempts < 30) {
    await new Promise((r) => setTimeout(r, 2000));
    file = await fm.getFile(file.name);
    attempts++;
  }

  if (file.state !== FileState.ACTIVE) {
    throw new Error(`File ${file.name} failed processing: ${file.state}`);
  }

  return file.uri;
}

async function analyzeSegmentWithGemini(
  client: GoogleGenerativeAI,
  fileUri: string,
  segmentDuration: number,
): Promise<FramingKeyframe[]> {
  const model = client.getGenerativeModel({ model: "gemini-2.5-pro" });

  const prompt = buildGeminiPrompt(segmentDuration);

  const result = await model.generateContent([
    { text: prompt },
    {
      fileData: {
        mimeType: "video/mp4",
        fileUri,
      },
    },
  ]);

  const responseText = result.response.text();
  console.log(`[Framing] Gemini response: ${responseText}`);

  return parseGeminiKeyframeResponse(responseText, segmentDuration);
}

async function processSegment(
  client: GoogleGenerativeAI,
  s3Key: string,
  segment: SegmentDescriptor,
  segIndex: number,
): Promise<FramingKeyframe[]> {
  const duration = segment.endTime - segment.startTime;
  const clipPath = `/tmp/segment-${segIndex}.mp4`;

  try {
    // 1. Cut segment with FFmpeg
    await cutSegmentClip(s3Key, segment.startTime, duration, clipPath);

    // 2. Upload to Gemini File API
    const fileUri = await uploadToGemini(clipPath);

    // 3. Query Gemini for zoom keyframes
    const keyframes = await analyzeSegmentWithGemini(client, fileUri, duration);

    // Re-id keyframes with segment index
    keyframes.forEach((kf, i) => {
      kf.id = `ai-kf-${segIndex}-${i}`;
    });

    return keyframes;
  } catch (err) {
    console.error(
      `[Framing] Segment ${segIndex} (${segment.startTime.toFixed(1)}s-${segment.endTime.toFixed(1)}s) failed:`,
      err,
    );
    return [makeFallbackKeyframe()];
  } finally {
    // Clean up clip
    try {
      fs.unlinkSync(clipPath);
    } catch {}
  }
}

// ============================================================================
// PROMPTS (legacy single-segment — kept for synchronous endpoint)
// ============================================================================

function buildFramingPrompt(
  startTime: number,
  endTime: number,
  targetAspectRatio: TargetAspectRatio,
): string {
  const segDuration = endTime - startTime;

  if (targetAspectRatio === "16:9") {
    return `This is 16:9 video targeting 16:9. Respond: 0.0|FULL`;
  }

  return `Analyze this video clip (${segDuration.toFixed(0)}s long) for vertical cropping.

Format: TIME|ZOOM
TIME: seconds from 0.0 to ${segDuration.toFixed(1)}
ZOOM: TIGHT / MEDIUM / WIDE / FULL

Rules:
- TIGHT: close-up of one person
- MEDIUM: one person with space, or two people close
- WIDE: two+ people, movement
- FULL: establishing shot, large group
- First line must be 0.0
- Only add keyframes at actual shot changes
- Max 5 keyframes

Output ONLY the lines.`;
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
  if (!projectRes.Item)
    throw { statusCode: 404, message: "Project not found" };

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
// SINGLE SEGMENT HANDLER (synchronous)
// ============================================================================

async function handleSingleSegment(
  projectId: string,
  segmentId: string | undefined,
  body: Record<string, unknown>,
) {
  const startTime = body.startTime as number;
  const endTime = body.endTime as number;

  if (typeof body.startTime !== "number" || typeof body.endTime !== "number") {
    return errorResponse(400, "Missing or invalid startTime/endTime");
  }
  if (endTime <= startTime) {
    return errorResponse(400, "endTime must be greater than startTime");
  }

  const { asset } = await getAssetRecord(projectId);
  const segmentDuration = endTime - startTime;
  const s3Key = asset.key;

  const client = await getGeminiClient();
  let keyframes: FramingKeyframe[];
  let legacyFraming: FramingResult;

  try {
    const clipPath = `/tmp/single-segment.mp4`;
    await cutSegmentClip(s3Key, startTime, segmentDuration, clipPath);
    const fileUri = await uploadToGemini(clipPath);
    keyframes = await analyzeSegmentWithGemini(client, fileUri, segmentDuration);
    legacyFraming = keyframesToLegacyResult(keyframes);
    try {
      fs.unlinkSync(clipPath);
    } catch {}
  } catch (err) {
    console.error("[Framing] AI analysis failed:", err);
    keyframes = [makeFallbackKeyframe()];
    legacyFraming = {
      mode: "fit",
      focusX: 0.5,
      focusY: 0.5,
      aiReasoning: "AI analysis unavailable",
      isAiGenerated: false,
    };
  }

  return successResponse({
    segmentId: segmentId || null,
    startTime,
    endTime,
    keyframes,
    framing: legacyFraming,
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

  // Reject if a job is already running
  const projectCheck = await docClient.send(
    new GetCommand({ TableName: PROJECTS_TABLE, Key: { projectId } }),
  );
  const existingJob = projectCheck.Item?.framingJob;
  if (
    existingJob &&
    (existingJob.status === "pending" || existingJob.status === "analyzing")
  ) {
    return errorResponse(
      409,
      "A framing job is already running for this project",
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

    // For 16:9, no AI needed
    if (targetAspectRatio === "16:9") {
      await writeFramingResults(
        projectId,
        segments,
        new Map(
          segments.map((_, i) => [
            i,
            [
              {
                id: "ai-kf-0",
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
    const s3Key = asset.key;

    // Get Gemini client
    const client = await getGeminiClient();

    // Process segments in parallel with concurrency limit
    const allKeyframes = new Map<number, FramingKeyframe[]>();
    let completedCount = 0;

    const processWithLimit = async () => {
      const queue = segments.map((seg, i) => ({ seg, i }));
      const workers = Array.from(
        { length: Math.min(CONCURRENCY_LIMIT, queue.length) },
        async () => {
          while (queue.length > 0) {
            const item = queue.shift()!;
            console.log(
              `[Framing] Processing segment ${item.i + 1}/${segments.length}: ${item.seg.startTime.toFixed(1)}s-${item.seg.endTime.toFixed(1)}s`,
            );

            const keyframes = await processSegment(
              client,
              s3Key,
              item.seg,
              item.i,
            );
            allKeyframes.set(item.i, keyframes);

            completedCount++;
            await updateFramingJob(projectId, {
              completedCount,
            });
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
