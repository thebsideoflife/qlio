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
import { generateWithStoryIQ, mapMetadataToGoals } from "../services/storyiq";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const secretsClient = new SecretsManagerClient({});
const lambdaClient = new LambdaClient({});

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const SECRET_ARN = process.env.SECRET_ARN!;
const SELF_FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME;

// ============================================================================
// Generation Job Types
// ============================================================================

interface GenerationJob {
  status:
    | "pending"
    | "detecting_scenes"
    | "generating"
    | "completed"
    | "failed";
  jobId: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

interface AsyncJobPayload {
  isAsyncJob: true;
  projectId: string;
  metadata: any;
  jobId: string;
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
  status: GenerationJob["status"]
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
    })
  );
}

/**
 * Main handler - routes between API Gateway requests and async job execution
 */
export const handler: Handler = async (event, context, callback) => {
  // Check if this is an async job callback (self-invoked)
  if (event.isAsyncJob) {
    return executeGenerationJob(event as AsyncJobPayload);
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
    const { metadata } = body;

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
      })
    );

    // Invoke self asynchronously to do the actual work
    const payload: AsyncJobPayload = {
      isAsyncJob: true,
      projectId,
      metadata,
      jobId,
    };

    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: SELF_FUNCTION_NAME,
        InvocationType: "Event", // Async - fire and forget
        Payload: JSON.stringify(payload),
      })
    );

    console.log(
      `[generateSegments] Started async job ${jobId} for project ${projectId}`
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
async function executeGenerationJob(payload: AsyncJobPayload): Promise<void> {
  const { projectId, metadata, jobId } = payload;

  console.log(
    `[generateSegments] Executing job ${jobId} for project ${projectId}`
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
    })
  );

  try {
    // Fetch Project to get Asset ID
    const projectRes = await docClient.send(
      new GetCommand({
        TableName: PROJECTS_TABLE,
        Key: { projectId },
      })
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
      })
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

    // 4. Get 12 Labs API Key and create wrapper
    const secretVal = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: SECRET_ARN })
    );
    const apiKey = secretVal.SecretString;
    if (!apiKey) throw new Error("12Labs API Key not found");

    const twelvelabs = createTwelveLabsWrapper(apiKey, ASSETS_TABLE);

    // =========================================================================
    // StoryIQ Generation
    // =========================================================================

    console.log("[generateSegments] Starting StoryIQ generation...");
    console.log("[generateSegments] Metadata:", JSON.stringify(metadata));

    // Map frontend metadata to StoryIQ goals
    const goals = mapMetadataToGoals(metadata || {});
    console.log("[generateSegments] Goals:", JSON.stringify(goals));

    let generatedSegments: Segment[] = [];

    try {
      // Status callback - allows StoryIQ to update job status during scene detection
      const onStatusChange = async (
        status: "detecting_scenes" | "generating"
      ) => {
        console.log(`[generateSegments] Status change: ${status}`);
        await updateJobStatus(projectId, status);
      };

      // Run StoryIQ (pass transcript S3 URI and duration if available)
      const result = await generateWithStoryIQ(
        twelvelabs,
        {
          assetId,
          goals,
          transcriptS3Uri: asset.transcriptionUrl,
          // Pass videoDuration from frontend if available (more reliable than 12Labs for chunked videos)
          videoDuration: metadata?.videoDuration || asset.duration || 0,
        },
        onStatusChange
      );

      console.log(
        `[generateSegments] StoryIQ complete: ${result.segments.segments.length} segments, ` +
          `confidence=${result.segments.confidence}, attempts=${result.metadata.attempts}`
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
    }

    // =========================================================================
    // Fallback: Heuristic Generation
    // =========================================================================

    if (generatedSegments.length === 0) {
      console.warn(
        "[generateSegments] StoryIQ failed. Attempting heuristic fallback."
      );

      // Get video duration
      let videoDuration = 0;
      if (metadata?.duration && typeof metadata.duration === "number") {
        videoDuration = metadata.duration;
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
          "AI could not find suitable clips, and fallback generation failed."
        );
      }

      console.log(
        "[generateSegments] Generated fallback segments:",
        generatedSegments.length
      );
    }

    // Sort segments chronologically
    generatedSegments.sort((a, b) => a.startTime - b.startTime);

    // Update Project with segments and mark job as completed
    await docClient.send(
      new UpdateCommand({
        TableName: PROJECTS_TABLE,
        Key: { projectId },
        UpdateExpression: `
          set #seg = :s, 
              #meta = :m, 
              generationJob.#status = :status,
              generationJob.completedAt = :completedAt,
              generationJob.segmentCount = :segmentCount,
              updatedAt = :u
        `,
        ExpressionAttributeNames: {
          "#seg": "segments",
          "#meta": "metadata",
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":s": generatedSegments,
          ":m": metadata || {},
          ":status": "completed",
          ":completedAt": new Date().toISOString(),
          ":segmentCount": generatedSegments.length,
          ":u": new Date().toISOString(),
        },
      })
    );

    console.log(
      `[generateSegments] Job ${jobId} completed successfully with ${generatedSegments.length} segments`
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
      })
    );
  }
}
