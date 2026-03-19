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
import { randomUUID } from "crypto";
import { checkAuth } from "../utils/auth";
import { createTwelveLabsWrapper } from "../services/twelvelabs";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const secretsClient = new SecretsManagerClient({});
const lambdaClient = new LambdaClient({});

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const SECRET_ARN = process.env.SECRET_ARN!;
const SELF_FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME;

// ============================================================================
// TYPES
// ============================================================================

type TargetAspectRatio = "16:9" | "1:1" | "9:16";

type HorizontalPosition =
  | "FAR_LEFT"
  | "SLIGHT_LEFT"
  | "CENTER"
  | "SLIGHT_RIGHT"
  | "FAR_RIGHT";

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
// POSITION & ZOOM MAPPING
// ============================================================================

const HORIZONTAL_POSITION_MAP: Record<HorizontalPosition, number> = {
  FAR_LEFT: 0.0,
  SLIGHT_LEFT: 0.25,
  CENTER: 0.5,
  SLIGHT_RIGHT: 0.75,
  FAR_RIGHT: 1.0,
};

const VALID_POSITIONS = new Set<string>(Object.keys(HORIZONTAL_POSITION_MAP));

const ZOOM_LEVEL_MAP: Record<ZoomLevel, number> = {
  TIGHT: 1.0,
  MEDIUM: 0.75,
  WIDE: 0.5,
  FULL: 0.0,
};

const VALID_ZOOM_LEVELS = new Set<string>(Object.keys(ZOOM_LEVEL_MAP));

const POSITION_LABELS: Record<HorizontalPosition, string> = {
  FAR_LEFT: "far left",
  SLIGHT_LEFT: "slight left",
  CENTER: "center",
  SLIGHT_RIGHT: "slight right",
  FAR_RIGHT: "far right",
};

// ============================================================================
// PARSING
// ============================================================================

function parseMultiKeyframeResponse(
  response: string,
  segmentDuration: number,
): FramingKeyframe[] {
  const lines = response
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return [makeFallbackKeyframe()];
  }

  const keyframes: FramingKeyframe[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split("|").map((p) => p.trim().toUpperCase());

    if (parts.length < 3) {
      console.warn(`[Framing] Skipping malformed line: "${line}"`);
      continue;
    }

    const timestamp = parseFloat(parts[0]);
    if (isNaN(timestamp) || timestamp < 0) continue;

    const time = Math.min(timestamp, segmentDuration);
    const positionToken = parts[1].replace(/\s+/g, "_");
    const focusX =
      HORIZONTAL_POSITION_MAP[positionToken as HorizontalPosition] ?? 0.5;
    const zoomToken = parts[2];
    const zoom = ZOOM_LEVEL_MAP[zoomToken as ZoomLevel] ?? 0.75;

    const posLabel =
      POSITION_LABELS[positionToken as HorizontalPosition] || "center";
    const zoomLabel = zoomToken.toLowerCase();

    keyframes.push({
      id: `ai-kf-${i}`,
      time,
      focusX,
      focusY: 0.5,
      zoom,
      aiReasoning: `${zoomLabel} on ${posLabel} at ${time.toFixed(1)}s`,
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

  return keyframes.slice(0, 4);
}

function makeFallbackKeyframe(): FramingKeyframe {
  return {
    id: "ai-kf-0",
    time: 0,
    focusX: 0.5,
    focusY: 0.5,
    zoom: 0.0,
    aiReasoning: "Could not parse AI response, defaulting to fit",
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

/** Parse flat-format batch: N|TIME|POSITION|ZOOM */
function parseBatchFlatResponse(
  response: string,
  segments: SegmentDescriptor[],
): Map<number, FramingKeyframe[]> {
  const result = new Map<number, FramingKeyframe[]>();
  const linesBySegment = new Map<number, string[]>();

  const lines = response
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.includes("|"));

  for (const line of lines) {
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 4) continue;

    const segNum = parseInt(parts[0]);
    if (isNaN(segNum) || segNum < 1 || segNum > segments.length) continue;

    const keyframeLine = parts.slice(1).join("|");
    const existing = linesBySegment.get(segNum) || [];
    existing.push(keyframeLine);
    linesBySegment.set(segNum, existing);
  }

  for (const [segNum, kfLines] of linesBySegment) {
    const segIndex = segNum - 1;
    const segDuration = segments[segIndex].endTime - segments[segIndex].startTime;
    const keyframes = parseMultiKeyframeResponse(kfLines.join("\n"), segDuration);
    keyframes.forEach((kf, i) => {
      kf.id = `ai-kf-${segIndex}-${i}`;
    });
    result.set(segIndex, keyframes);
  }

  for (let i = 0; i < segments.length; i++) {
    if (!result.has(i)) {
      console.warn(`[Framing] No response for segment ${i + 1}/${segments.length}`);
      result.set(i, [makeFallbackKeyframe()]);
    }
  }

  return result;
}

// ============================================================================
// LEGACY SINGLE-LINE PARSING (for old "CROP, CENTER" responses)
// ============================================================================

function extractFromResponse(raw: string) {
  const normalized = raw.toUpperCase().trim();
  const parts = normalized.split(",").map((p) => p.trim());
  return {
    strategy: parts[0] || "",
    position: (parts[1] || "").replace(/\s+/g, "_"),
    raw,
  };
}

function validateAndConvert(
  parsed: { strategy: string; position: string },
  targetAspectRatio: TargetAspectRatio,
): FramingResult | null {
  const { strategy, position } = parsed;

  if (strategy === "FIT") {
    return { mode: "fit", focusX: 0.5, focusY: 0.5, aiReasoning: "Showing full frame with letterboxing", isAiGenerated: true };
  }

  if (strategy === "CROP") {
    if (targetAspectRatio === "16:9") {
      return { mode: "fit", focusX: 0.5, focusY: 0.5, aiReasoning: "Using fit for landscape output", isAiGenerated: true };
    }
    const focusX = HORIZONTAL_POSITION_MAP[position as HorizontalPosition] ?? 0.5;
    const positionLabel = POSITION_LABELS[position as HorizontalPosition] || "center";
    return { mode: "crop", focusX, focusY: 0.5, aiReasoning: `Cropping to focus on ${positionLabel}`, isAiGenerated: true };
  }

  return null;
}

// ============================================================================
// PROMPTS
// ============================================================================

function buildFramingPrompt(
  startTime: number,
  endTime: number,
  targetAspectRatio: TargetAspectRatio,
): string {
  const segDuration = endTime - startTime;

  if (targetAspectRatio === "16:9") {
    return `Look at the video segment from ${startTime.toFixed(1)}s to ${endTime.toFixed(1)}s. The original video is 16:9 landscape and the target is also 16:9.\n\nSince the aspect ratios match, just respond: 0.0|CENTER|FULL`;
  }

  const ratioLabel = targetAspectRatio === "9:16" ? "9:16 portrait (vertical)" : "1:1 square";

  return `Look at the video from ${startTime.toFixed(1)}s to ${endTime.toFixed(1)}s.
Target: ${ratioLabel} from 16:9 source.

Identify 1-4 FRAMING SECTIONS where the camera framing should differ.
A new section is needed when:
- A different speaker starts talking
- Subjects move to significantly different positions
- The number of important on-screen subjects changes

For each section:
TIMESTAMP | POSITION | ZOOM

TIMESTAMP: seconds relative to segment start (0.0 = segment start, max ${segDuration.toFixed(1)})
POSITION: FAR_LEFT / SLIGHT_LEFT / CENTER / SLIGHT_RIGHT / FAR_RIGHT
ZOOM: TIGHT (single subject fills frame) / MEDIUM (subject + context) / WIDE (multiple subjects visible) / FULL (show everything)

Rules:
- First line MUST start at 0.0 (relative to segment start)
- 1-4 lines max. If framing doesn't change, just one line.
- ALWAYS prefer TIGHT/MEDIUM over FULL for speakers

Example for a 20s segment:
0.0|CENTER|TIGHT
8.5|SLIGHT_LEFT|MEDIUM
15.0|CENTER|WIDE

Respond with ONLY the lines. Nothing else.`;
}

/** Max segments per 12Labs call — keeps output short for reliability */
const MAX_SEGMENTS_PER_CALL = 20;

function buildBatchFramingPrompt(
  segments: SegmentDescriptor[],
  targetAspectRatio: TargetAspectRatio,
): string {
  const ratioLabel = targetAspectRatio === "9:16" ? "9:16 portrait" : "1:1 square";

  const segmentLines = segments
    .map((s, i) => `${i + 1}: ${s.startTime.toFixed(1)}s-${s.endTime.toFixed(1)}s`)
    .join("\n");

  return `Reframe 16:9 video to ${ratioLabel}. Analyze these ${segments.length} segments:
${segmentLines}

For each segment, respond with 1-3 keyframes. Format: N|TIME|POSITION|ZOOM
N=segment number, TIME=seconds from segment start (first must be 0.0)
POSITION: FAR_LEFT/SLIGHT_LEFT/CENTER/SLIGHT_RIGHT/FAR_RIGHT
ZOOM: TIGHT/MEDIUM/WIDE/FULL
Prefer TIGHT/MEDIUM for speakers.

Example:
1|0.0|CENTER|TIGHT
1|8.5|SLIGHT_LEFT|MEDIUM
2|0.0|CENTER|WIDE

ONLY output lines.`;
}

// ============================================================================
// SHARED HELPERS
// ============================================================================

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

function errorResponse(statusCode: number, error: string) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify({ error }) };
}

function successResponse(data: object) {
  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(data) };
}

async function getAssetAndWrapper(projectId: string) {
  const projectRes = await docClient.send(
    new GetCommand({ TableName: PROJECTS_TABLE, Key: { projectId } }),
  );
  if (!projectRes.Item) throw { statusCode: 404, message: "Project not found" };

  const assetId = projectRes.Item.assetId;
  const assetRes = await docClient.send(
    new GetCommand({ TableName: ASSETS_TABLE, Key: { assetId } }),
  );
  if (!assetRes.Item) throw { statusCode: 404, message: "Asset not found" };

  const asset = assetRes.Item;
  if (!asset.isChunked && (!asset.twelveLabsVideoId || asset.twelveLabsVideoId === "unknown")) {
    throw { statusCode: 400, message: "Asset has not been indexed by 12 Labs yet" };
  }
  if (asset.isChunked && (asset.chunks || []).some((c: any) => !c.videoId)) {
    throw { statusCode: 400, message: "Asset chunks are still being indexed" };
  }

  const secretVal = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: SECRET_ARN }),
  );
  if (!secretVal.SecretString) throw new Error("12Labs API Key not found");

  return { assetId, project: projectRes.Item, twelvelabs: createTwelveLabsWrapper(secretVal.SecretString, ASSETS_TABLE) };
}

function stripChunkPrefixes(raw: string): string {
  return raw.replace(/\[Chunk \d+ \([^\)]*\)\]:\s*/gi, "").trim();
}

async function updateFramingJob(projectId: string, updates: Partial<FramingJob>): Promise<void> {
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
      ExpressionAttributeNames: Object.keys(names).length > 0 ? names : undefined,
      ExpressionAttributeValues: values,
    }),
  );
}

// ============================================================================
// SINGLE SEGMENT HANDLER (synchronous — still used by per-segment button)
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

  const validAspectRatios: TargetAspectRatio[] = ["16:9", "1:1", "9:16"];
  const aspectRatio: TargetAspectRatio = validAspectRatios.includes(body.targetAspectRatio as TargetAspectRatio)
    ? (body.targetAspectRatio as TargetAspectRatio)
    : "9:16";

  const { assetId, twelvelabs } = await getAssetAndWrapper(projectId);
  const segmentDuration = endTime - startTime;

  const prompt = buildFramingPrompt(startTime, endTime, aspectRatio);
  let keyframes: FramingKeyframe[];
  let legacyFraming: FramingResult;

  try {
    const response = await twelvelabs.analyze(assetId, { prompt, startTime, endTime });
    const responseText = stripChunkPrefixes(response.data);
    console.log("[Framing] AI response:", responseText);

    if (responseText.includes("|")) {
      keyframes = parseMultiKeyframeResponse(responseText, segmentDuration);
      legacyFraming = keyframesToLegacyResult(keyframes);
    } else {
      const parsed = extractFromResponse(responseText);
      const result = validateAndConvert(parsed, aspectRatio);
      legacyFraming = result || { mode: "fit", focusX: 0.5, focusY: 0.5, aiReasoning: "Could not parse response", isAiGenerated: true };
      keyframes = [{ id: "ai-kf-0", time: 0, focusX: legacyFraming.focusX, focusY: legacyFraming.focusY, zoom: legacyFraming.mode === "crop" ? 1.0 : 0.0, aiReasoning: legacyFraming.aiReasoning, isAiGenerated: true }];
    }
  } catch (err) {
    console.error("[Framing] AI analysis failed:", err);
    keyframes = [makeFallbackKeyframe()];
    legacyFraming = { mode: "fit", focusX: 0.5, focusY: 0.5, aiReasoning: "AI analysis unavailable", isAiGenerated: false };
  }

  return successResponse({ segmentId: segmentId || null, startTime, endTime, keyframes, framing: legacyFraming });
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
    return errorResponse(400, "segments array is required and must not be empty");
  }

  // Validate segments
  const segments: SegmentDescriptor[] = [];
  for (const seg of rawSegments) {
    if (!seg || typeof seg.id !== "string" || typeof seg.startTime !== "number" || typeof seg.endTime !== "number" || seg.endTime <= seg.startTime) {
      return errorResponse(400, `Invalid segment: ${JSON.stringify(seg)}`);
    }
    segments.push({ id: seg.id, startTime: seg.startTime, endTime: seg.endTime });
  }

  const validAspectRatios: TargetAspectRatio[] = ["16:9", "1:1", "9:16"];
  const aspectRatio: TargetAspectRatio = validAspectRatios.includes(targetAspectRatio as TargetAspectRatio)
    ? (targetAspectRatio as TargetAspectRatio)
    : "9:16";

  const jobId = randomUUID();

  // Write pending framingJob to project
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

  // Self-invoke async
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

  console.log(`[Framing] Started async batch job ${jobId}: ${segments.length} segments`);

  return {
    statusCode: 202,
    headers: CORS_HEADERS,
    body: JSON.stringify({ message: "Framing analysis started", jobId, status: "pending" }),
  };
}

// ============================================================================
// ASYNC JOB EXECUTION
// ============================================================================

async function executeFramingJob(payload: AsyncJobPayload): Promise<void> {
  const { projectId, segments, targetAspectRatio, jobId } = payload;

  console.log(`[Framing] Executing job ${jobId}: ${segments.length} segments (target: ${targetAspectRatio})`);

  try {
    await updateFramingJob(projectId, { status: "analyzing" });

    // For 16:9, no AI needed — just write defaults
    if (targetAspectRatio === "16:9") {
      await writeFramingResults(projectId, segments, new Map(
        segments.map((_, i) => [i, [{ id: "ai-kf-0", time: 0, focusX: 0.5, focusY: 0.5, zoom: 0.0, aiReasoning: "Fit for landscape", isAiGenerated: true }]])
      ), targetAspectRatio);
      await updateFramingJob(projectId, { status: "completed", completedAt: new Date().toISOString(), completedCount: segments.length });
      return;
    }

    const { assetId, project, twelvelabs } = await getAssetAndWrapper(projectId);

    // Process in chunks of MAX_SEGMENTS_PER_CALL
    const allKeyframes = new Map<number, FramingKeyframe[]>();
    const sortedIndices = segments.map((_, i) => i).sort((a, b) => segments[a].startTime - segments[b].startTime);

    for (let chunkStart = 0; chunkStart < sortedIndices.length; chunkStart += MAX_SEGMENTS_PER_CALL) {
      const chunkIndices = sortedIndices.slice(chunkStart, chunkStart + MAX_SEGMENTS_PER_CALL);
      const chunkSegments = chunkIndices.map((idx) => segments[idx]);
      const chunkNum = Math.floor(chunkStart / MAX_SEGMENTS_PER_CALL) + 1;
      const totalChunks = Math.ceil(sortedIndices.length / MAX_SEGMENTS_PER_CALL);

      console.log(`[Framing] Chunk ${chunkNum}/${totalChunks}: ${chunkSegments.length} segments`);

      const prompt = buildBatchFramingPrompt(chunkSegments, targetAspectRatio);
      const minStart = Math.min(...chunkSegments.map((s) => s.startTime));
      const maxEnd = Math.max(...chunkSegments.map((s) => s.endTime));

      try {
        const response = await twelvelabs.analyze(assetId, { prompt, startTime: minStart, endTime: maxEnd });
        const responseText = stripChunkPrefixes(response.data);
        console.log(`[Framing] Chunk ${chunkNum} response (${responseText.length} chars):`, responseText);

        const parsed = parseBatchFlatResponse(responseText, chunkSegments);

        // Map back to original indices
        for (let li = 0; li < chunkIndices.length; li++) {
          allKeyframes.set(chunkIndices[li], parsed.get(li) || [makeFallbackKeyframe()]);
        }
      } catch (err) {
        console.error(`[Framing] Chunk ${chunkNum} failed:`, err);
        for (const idx of chunkIndices) {
          allKeyframes.set(idx, [makeFallbackKeyframe()]);
        }
      }

      // Update progress
      await updateFramingJob(projectId, { completedCount: Math.min(chunkStart + MAX_SEGMENTS_PER_CALL, segments.length) });
    }

    // Write all framing results to the project's segments in DynamoDB
    await writeFramingResults(projectId, segments, allKeyframes, targetAspectRatio);
    await updateFramingJob(projectId, { status: "completed", completedAt: new Date().toISOString(), completedCount: segments.length });

    console.log(`[Framing] Job ${jobId} completed: ${segments.length} segments`);
  } catch (err) {
    console.error(`[Framing] Job ${jobId} failed:`, err);
    await updateFramingJob(projectId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : "Unknown error",
    }).catch(() => {}); // Don't throw on status update failure
  }
}

/**
 * Write framing results directly into the project's segments in DynamoDB.
 * Reads current segments, patches framing on matching IDs, writes back.
 */
async function writeFramingResults(
  projectId: string,
  requestedSegments: SegmentDescriptor[],
  keyframesMap: Map<number, FramingKeyframe[]>,
  targetAspectRatio: TargetAspectRatio,
): Promise<void> {
  // Read current project to get segments
  const projectRes = await docClient.send(
    new GetCommand({ TableName: PROJECTS_TABLE, Key: { projectId } }),
  );
  if (!projectRes.Item) throw new Error("Project not found during result write");

  const currentSegments = projectRes.Item.segments || [];

  // Build a map of segment ID → framing result
  const framingBySegmentId = new Map<string, { keyframes: FramingKeyframe[]; legacy: FramingResult }>();
  for (let i = 0; i < requestedSegments.length; i++) {
    const kfs = keyframesMap.get(i) || [makeFallbackKeyframe()];
    framingBySegmentId.set(requestedSegments[i].id, {
      keyframes: kfs,
      legacy: keyframesToLegacyResult(kfs),
    });
  }

  // Patch framing onto each matching segment
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

  // Write back
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

  console.log(`[Framing] Wrote framing for ${framingBySegmentId.size} segments to DynamoDB`);
}

// ============================================================================
// HANDLER — Routes between API Gateway and async self-invoke
// ============================================================================

export const handler: Handler = async (event, context, callback) => {
  // Async job execution (self-invoked)
  if (event.isAsyncJob) {
    return executeFramingJob(event as AsyncJobPayload);
  }

  // API Gateway request
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

    // Batch mode: body contains segments[] → start async job
    if (Array.isArray(body.segments)) {
      return await handleStartBatch(projectId, body);
    }

    // Single segment mode (synchronous, still fits in 30s)
    return await handleSingleSegment(projectId, segmentId, body);
  } catch (error: any) {
    if (error.statusCode) {
      return errorResponse(error.statusCode, error.message);
    }
    console.error("[Framing] Unexpected error:", error);
    return errorResponse(500, "Failed to analyze framing");
  }
};
