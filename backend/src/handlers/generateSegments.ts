import { APIGatewayProxyHandler, Handler, type Context } from "aws-lambda";
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
import {
  generateWithStoryIQ,
  mapMetadataToGoals,
  type JockeyV3Input,
} from "../services/storyiq";
import { presignS3Uri } from "../utils/s3";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const secretsClient = new SecretsManagerClient({});
const lambdaClient = new LambdaClient({});

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const SECRET_ARN = process.env.SECRET_ARN!;
const JOCKEY_COMPACT_RECAP_ENABLED =
  process.env.JOCKEY_COMPACT_RECAP_ENABLED === "true";
// Jockey v3 self-directed cutting (SPEC-jockey-v3-self-directed-cuts.md).
// Layered above JOCKEY_COMPACT_RECAP_ENABLED; rollback = flip to "false".
const JOCKEY_V3_SELF_DIRECTED_ENABLED =
  process.env.JOCKEY_V3_SELF_DIRECTED_ENABLED === "true";
const JOCKEY_AGENTS_SECRET_ARN = process.env.JOCKEY_AGENTS_SECRET_ARN;
const BUCKET_NAME = process.env.BUCKET_NAME;
const SELF_FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME;

// ============================================================================
// Generation Job Types
// ============================================================================

interface GenerationJob {
  status: "pending" | "generating" | "completed" | "failed";
  jobId: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

interface AsyncJobPayload {
  isAsyncJob: true;
  projectId: string;
  userPrompt?: string;
  videoDuration?: number;
  jobId: string;
  autoFrame?: boolean;
  targetAspectRatio?: string;
  /** Generation purpose */
  purpose?: "compact_video" | "highlights" | "full_video" | "episode_recap";
  /** Omitted or null = Auto. Otherwise 25 / 50 / 75 (% of source length). */
  targetPercent?: number | null;
  /** Min per-segment length in seconds */
  minSegmentDuration?: number;
  /** Max per-segment length in seconds */
  maxSegmentDuration?: number;
  /** Pass-through metadata: tv | movie | other */
  assetType?: string;
  /** Pass-through metadata: mobile | tv | tiktok | ig | shorts | facebook */
  platform?: string;
  /** Pass-through metadata: compact_video | full_video | highlights | trailer | episode_recap | season_recap */
  format?: string;
  /** When true, use Jockey for compact/recap if env flags allow. Default false. */
  jockeyEnabled?: boolean;
}

interface Segment {
  id: string;
  startTime: number;
  endTime: number;
  title: string;
  description?: string;
  confidence?: number;
  sceneTags?: string[];
  keyDialogue?: string;
  characters?: string[];
}

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

/**
 * Helper to update job status in DynamoDB
 */
async function updateJobStatus(
  projectId: string,
  status: GenerationJob["status"],
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: PROJECTS_TABLE,
      Key: { projectId },
      UpdateExpression: "set generationJob.#status = :s, updatedAt = :u",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":s": status,
        ":u": new Date().toISOString(),
      },
    }),
  );
}

/**
 * Main handler - routes between API Gateway requests and async job execution
 */
export const handler: Handler = async (event, context, callback) => {
  // Check if this is an async job callback (self-invoked)
  if (event.isAsyncJob) {
    return executeGenerationJob(event as AsyncJobPayload, context);
  }

  // Otherwise, handle as API Gateway request
  return handleApiRequest(event, context, callback);
};

/**
 * Handle API Gateway request - start async job and return immediately
 */
const handleApiRequest: APIGatewayProxyHandler = async (event) => {
  // 1. Auth Check
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  try {
    const projectId = event.pathParameters?.projectId;
    if (!projectId) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Missing projectId" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const {
      userPrompt,
      videoDuration,
      autoFrame,
      targetAspectRatio,
      purpose,
      targetPercent,
      minSegmentDuration,
      maxSegmentDuration,
      assetType,
      platform,
      format,
      jockeyEnabled,
    } = body;

    // Generate a job ID
    const jobId = randomUUID();

    // Save pending status to project
    await docClient.send(
      new UpdateCommand({
        TableName: PROJECTS_TABLE,
        Key: { projectId },
        UpdateExpression: "set generationJob = :job, updatedAt = :u",
        ExpressionAttributeValues: {
          ":job": {
            status: "pending",
            jobId,
            startedAt: new Date().toISOString(),
          } as GenerationJob,
          ":u": new Date().toISOString(),
        },
      }),
    );

    // Invoke self asynchronously to do the actual work
    const payload: AsyncJobPayload = {
      isAsyncJob: true,
      projectId,
      userPrompt: userPrompt || undefined,
      videoDuration:
        typeof videoDuration === "number" ? videoDuration : undefined,
      jobId,
      autoFrame: !!autoFrame,
      targetAspectRatio: targetAspectRatio || "9:16",
      purpose: purpose || "highlights",
      targetPercent:
        typeof targetPercent === "number" ? targetPercent : undefined,
      minSegmentDuration:
        typeof minSegmentDuration === "number" ? minSegmentDuration : undefined,
      maxSegmentDuration:
        typeof maxSegmentDuration === "number" ? maxSegmentDuration : undefined,
      assetType: assetType || undefined,
      platform: platform || undefined,
      format: format || undefined,
      jockeyEnabled: jockeyEnabled === true,
    };

    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: SELF_FUNCTION_NAME,
        InvocationType: "Event", // Async - fire and forget
        Payload: JSON.stringify(payload),
      }),
    );

    console.log(
      `[generateSegments] Started async job ${jobId} for project ${projectId}`,
    );

    // Return immediately with job info
    return {
      statusCode: 202, // Accepted
      headers: CORS_HEADERS,
      body: JSON.stringify({
        message: "Generation started",
        jobId,
        status: "pending",
      }),
    };
  } catch (error) {
    console.error("[generateSegments] Error starting job:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Failed to start generation" }),
    };
  }
};

/**
 * Execute the actual generation job (called asynchronously)
 */
const ANALYZE_FRAMING_FUNCTION_NAME = process.env.ANALYZE_FRAMING_FUNCTION_NAME;

async function executeGenerationJob(
  payload: AsyncJobPayload,
  lambdaContext?: Context,
): Promise<void> {
  const {
    projectId,
    userPrompt,
    videoDuration: payloadVideoDuration,
    jobId,
    autoFrame,
    targetAspectRatio,
    purpose,
    targetPercent,
    minSegmentDuration,
    maxSegmentDuration,
    assetType,
    platform,
    format,
    jockeyEnabled,
  } = payload;

  console.log(
    `[generateSegments] Executing job ${jobId} for project ${projectId}`,
  );

  // Update status to "generating"
  await docClient.send(
    new UpdateCommand({
      TableName: PROJECTS_TABLE,
      Key: { projectId },
      UpdateExpression: "set generationJob.#status = :s, updatedAt = :u",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":s": "generating",
        ":u": new Date().toISOString(),
      },
    }),
  );

  try {
    // Fetch Project to get Asset ID
    const projectRes = await docClient.send(
      new GetCommand({
        TableName: PROJECTS_TABLE,
        Key: { projectId },
      }),
    );

    if (!projectRes.Item) {
      throw new Error("Project not found");
    }

    const project = projectRes.Item;
    const assetId = project.assetId;

    // Fetch Asset to validate it's ready
    const assetRes = await docClient.send(
      new GetCommand({
        TableName: ASSETS_TABLE,
        Key: { assetId },
      }),
    );

    if (!assetRes.Item) {
      throw new Error("Asset not found");
    }

    const asset = assetRes.Item;

    // Check if asset is ready (either has videoId for non-chunked, or all chunks indexed)
    const isChunked = asset.isChunked || false;
    const videoId = asset.twelveLabsVideoId;
    const chunks = asset.chunks || [];

    if (!isChunked && (!videoId || videoId === "unknown")) {
      throw new Error("Asset has not been indexed by 12 Labs yet.");
    }

    if (isChunked && chunks.some((c: any) => !c.videoId)) {
      throw new Error("Asset chunks are still being indexed. Please wait.");
    }

    // 4. Get API Keys
    const isJockeyPurpose =
      purpose === "compact_video" || purpose === "episode_recap";
    const jockeyRequested = jockeyEnabled === true;
    const useJockeyForRequest =
      jockeyRequested && JOCKEY_COMPACT_RECAP_ENABLED && isJockeyPurpose;

    // Always use the org TwelveLabs key — org-indexed assets are not readable
    // under the Jockey/Agents key. Claude/Gemini calls go through SporeLabs.
    const secretVal = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: SECRET_ARN }),
    );
    const apiKey = secretVal.SecretString;
    if (!apiKey) throw new Error("12Labs API Key not found");

    // Jockey v3 self-directed: resolve the Agents API key and per-asset
    // Agents context (cached asset/store ids, or a presigned URL for the
    // one-time upload). No detect-scenes, no brief — Jockey owns the cuts.
    const useJockeyV3ForRequest =
      jockeyRequested && JOCKEY_V3_SELF_DIRECTED_ENABLED && isJockeyPurpose;
    let jockeyV3: JockeyV3Input | undefined;

    if (useJockeyV3ForRequest) {
      if (!JOCKEY_AGENTS_SECRET_ARN) {
        throw new Error(
          "JOCKEY_V3_SELF_DIRECTED_ENABLED is on but JOCKEY_AGENTS_SECRET_ARN is not configured",
        );
      }
      const agentsSecret = await secretsClient.send(
        new GetSecretValueCommand({ SecretId: JOCKEY_AGENTS_SECRET_ARN }),
      );
      const agentsApiKey = agentsSecret.SecretString;
      if (!agentsApiKey || agentsApiKey.startsWith("REPLACE_ME")) {
        throw new Error("Jockey Agents API key secret is not populated");
      }

      // Reuse cached Agents ids so re-runs skip upload + indexing.
      const cachedAgentsAssetId =
        typeof asset.jockeyAgentsAssetId === "string"
          ? asset.jockeyAgentsAssetId
          : undefined;
      const cachedStoreId =
        typeof asset.jockeyAgentsStoreId === "string"
          ? asset.jockeyAgentsStoreId
          : undefined;

      let videoUrlForUpload: string | undefined;
      if (!cachedAgentsAssetId) {
        let s3Uri =
          typeof asset.s3VideoUrl === "string" ? asset.s3VideoUrl : undefined;
        if (!s3Uri && typeof asset.key === "string" && BUCKET_NAME) {
          s3Uri = `s3://${BUCKET_NAME}/${asset.key}`;
        }
        if (s3Uri) {
          videoUrlForUpload = (await presignS3Uri(s3Uri, 43_200)) ?? undefined;
        }
      }

      jockeyV3 = {
        agentsApiKey,
        agentsAssetId: cachedAgentsAssetId,
        knowledgeStoreId: cachedStoreId,
        videoUrlForUpload,
        onAgentsContextReady: async (ctx) => {
          await docClient.send(
            new UpdateCommand({
              TableName: ASSETS_TABLE,
              Key: { assetId },
              UpdateExpression:
                "set jockeyAgentsAssetId = :a, jockeyAgentsStoreId = :s",
              ExpressionAttributeValues: {
                ":a": ctx.agentsAssetId,
                ":s": ctx.knowledgeStoreId,
              },
            }),
          );
          console.log(
            `[generateSegments] Cached Agents context on asset ${assetId}: ` +
              `asset ${ctx.agentsAssetId}, store ${ctx.knowledgeStoreId}`,
          );
        },
      };
    }

    const twelvelabs = createTwelveLabsWrapper(apiKey, ASSETS_TABLE);

    // =========================================================================
    // StoryIQ Generation
    // =========================================================================

    console.log("[generateSegments] Starting StoryIQ generation...");

    const goals = mapMetadataToGoals({
      userPrompt,
      purpose,
      targetPercent,
      minSegmentDuration,
      maxSegmentDuration,
      assetType,
      platform,
      format,
    });
    console.log("[generateSegments] Goals:", JSON.stringify(goals));

    let generatedSegments: Segment[] = [];

    try {
      // Status callback for job progress
      const onStatusChange = async (status: "generating") => {
        console.log(`[generateSegments] Status change: ${status}`);
        await updateJobStatus(projectId, status);
      };

      const maxAsyncWaitMs = lambdaContext?.getRemainingTimeInMillis
        ? Math.max(120_000, lambdaContext.getRemainingTimeInMillis() - 60_000)
        : undefined;

      // Run StoryIQ (pass transcript S3 URI and duration if available)
      const videoTitle =
        (typeof asset.title === "string" && asset.title.trim()
          ? asset.title.trim()
          : null) ??
        (typeof asset.originalName === "string" && asset.originalName.trim()
          ? asset.originalName.trim()
          : null) ??
        (typeof project.title === "string" && project.title.trim()
          ? project.title.trim()
          : undefined);

      const result = await generateWithStoryIQ(
        twelvelabs,
        {
          assetId,
          goals,
          transcriptS3Uri: asset.transcriptionUrl,
          videoDuration: payloadVideoDuration || asset.duration || 0,
          maxAsyncWaitMs,
          title: videoTitle,
          jockeyV3,
          jockeyEnabled: jockeyRequested,
        },
        onStatusChange,
      );

      console.log(
        `[generateSegments] StoryIQ complete: ${result.segments.segments.length} segments, ` +
          `confidence=${result.segments.confidence}, attempts=${result.metadata.attempts}`,
      );

      // Transform StoryIQ output to handler format
      for (const seg of result.segments.segments) {
        generatedSegments.push({
          id: randomUUID(),
          startTime: seg.startTime,
          endTime: seg.endTime,
          title: seg.title,
          description: seg.reasoning,
          confidence: result.segments.confidence,
          sceneTags: seg.section ? [seg.section] : [],
          keyDialogue: seg.expectedContent,
          characters: [],
        });
      }
    } catch (err) {
      console.error("[generateSegments] StoryIQ failed:", err);
      // Jockey paths fail loud — no heuristic fallback (SPEC v3 §4.5).
      if (useJockeyForRequest || useJockeyV3ForRequest) {
        throw err;
      }
    }

    // =========================================================================
    // Fallback: Heuristic Generation
    // =========================================================================

    if (generatedSegments.length === 0) {
      console.warn(
        "[generateSegments] StoryIQ failed. Attempting heuristic fallback.",
      );

      // Get video duration for fallback segments
      let videoDuration = 0;
      if (payloadVideoDuration && payloadVideoDuration > 0) {
        videoDuration = payloadVideoDuration;
      } else if (asset.duration && typeof asset.duration === "number") {
        videoDuration = asset.duration;
      } else {
        try {
          const videoMetadata = await twelvelabs.getVideoMetadata(assetId);
          videoDuration = videoMetadata.duration;
        } catch (e) {
          console.warn("[generateSegments] Could not get duration:", e);
        }
      }

      const safeDuration = videoDuration > 0 ? videoDuration : 60;
      const segmentDuration = Math.min(15, Math.max(5, safeDuration / 10));

      // Generate 3 evenly spaced segments
      generatedSegments.push({
        id: randomUUID(),
        startTime: 0,
        endTime: segmentDuration,
        title: "Opening Scene",
        description: "Auto-generated fallback: Opening of the video.",
        confidence: 0.5,
        sceneTags: ["fallback"],
        keyDialogue: "",
        characters: [],
      });

      if (safeDuration > segmentDuration * 3) {
        const midStart = safeDuration / 2 - segmentDuration / 2;
        generatedSegments.push({
          id: randomUUID(),
          startTime: midStart,
          endTime: midStart + segmentDuration,
          title: "Key Moment",
          description: "Auto-generated fallback: Middle of the video.",
          confidence: 0.5,
          sceneTags: ["fallback"],
          keyDialogue: "",
          characters: [],
        });
      }

      if (safeDuration > segmentDuration * 2) {
        generatedSegments.push({
          id: randomUUID(),
          startTime: safeDuration - segmentDuration,
          endTime: safeDuration,
          title: "Conclusion",
          description: "Auto-generated fallback: End of the video.",
          confidence: 0.5,
          sceneTags: ["fallback"],
          keyDialogue: "",
          characters: [],
        });
      }

      if (generatedSegments.length === 0) {
        throw new Error(
          "AI could not find suitable clips, and fallback generation failed.",
        );
      }

      console.log(
        "[generateSegments] Generated fallback segments:",
        generatedSegments.length,
      );
    }

    // Sort segments chronologically
    generatedSegments.sort((a, b) => a.startTime - b.startTime);

    // The project is the microseries; its name is the user's, never a scene's.
    // Write segments to DB first (without marking completed yet)
    await docClient.send(
      new UpdateCommand({
        TableName: PROJECTS_TABLE,
        Key: { projectId },
        UpdateExpression: `set #seg = :s, #meta = :m, updatedAt = :u`,
        ExpressionAttributeNames: { "#seg": "segments", "#meta": "metadata" },
        ExpressionAttributeValues: {
          ":s": generatedSegments,
          ":m": {
            userPrompt: userPrompt || null,
            purpose: purpose || null,
            format: format || null,
            assetType: assetType || null,
            platform: platform || null,
            minSegmentDuration: minSegmentDuration ?? null,
            maxSegmentDuration: maxSegmentDuration ?? null,
            targetPercent: targetPercent ?? null,
          },
          ":u": new Date().toISOString(),
        },
      }),
    );


    // If auto-framing requested, start the framing job BEFORE marking generation
    // as completed — this guarantees framingJob exists in DynamoDB when the
    // frontend polls and sees generationJob.status = "completed".
    if (
      autoFrame &&
      ANALYZE_FRAMING_FUNCTION_NAME &&
      generatedSegments.length > 0
    ) {
      const batchSegments = generatedSegments.map((seg) => ({
        id: seg.id,
        startTime: seg.startTime,
        endTime: seg.endTime,
      }));
      console.log(
        `[generateSegments] Starting auto-framing for ${batchSegments.length} segments`,
      );
      try {
        const framingResponse = await lambdaClient.send(
          new InvokeCommand({
            FunctionName: ANALYZE_FRAMING_FUNCTION_NAME,
            InvocationType: "RequestResponse",
            Payload: JSON.stringify({
              isDirectBatchStart: true,
              projectId,
              segments: batchSegments,
              targetAspectRatio: targetAspectRatio || "9:16",
            }),
          }),
        );
        // Check if handleStartBatch returned an error (409 conflict, 400 bad input, etc.)
        if (framingResponse.FunctionError) {
          console.error(
            `[generateSegments] Auto-framing Lambda error: ${framingResponse.FunctionError}`,
          );
        } else {
          const payload = framingResponse.Payload
            ? JSON.parse(Buffer.from(framingResponse.Payload).toString())
            : null;
          if (payload?.statusCode >= 400) {
            console.error(
              `[generateSegments] Auto-framing rejected (${payload.statusCode}): ${payload.body}`,
            );
          } else {
            console.log(`[generateSegments] Auto-framing job started`);
          }
        }
      } catch (framingErr) {
        console.error(
          `[generateSegments] Failed to start auto-framing (non-fatal):`,
          framingErr,
        );
      }
    }

    // Now mark generation as completed — framingJob is already in DynamoDB if auto-frame was requested
    await docClient.send(
      new UpdateCommand({
        TableName: PROJECTS_TABLE,
        Key: { projectId },
        UpdateExpression: `
          set generationJob.#status = :status,
              generationJob.completedAt = :completedAt,
              generationJob.segmentCount = :segmentCount,
              updatedAt = :u
        `,
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "completed",
          ":completedAt": new Date().toISOString(),
          ":segmentCount": generatedSegments.length,
          ":u": new Date().toISOString(),
        },
      }),
    );

    console.log(
      `[generateSegments] Job ${jobId} completed successfully with ${generatedSegments.length} segments`,
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(`[generateSegments] Job ${jobId} failed:`, error);

    // Update job status to failed
    await docClient.send(
      new UpdateCommand({
        TableName: PROJECTS_TABLE,
        Key: { projectId },
        UpdateExpression: `
          set generationJob.#status = :status,
              generationJob.completedAt = :completedAt,
              generationJob.#error = :error,
              updatedAt = :u
        `,
        ExpressionAttributeNames: {
          "#status": "status",
          "#error": "error",
        },
        ExpressionAttributeValues: {
          ":status": "failed",
          ":completedAt": new Date().toISOString(),
          ":error": errorMessage,
          ":u": new Date().toISOString(),
        },
      }),
    );
  }
}
