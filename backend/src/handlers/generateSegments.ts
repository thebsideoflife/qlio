import { APIGatewayProxyHandler } from "aws-lambda";
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
import { randomUUID } from "crypto";
import { checkAuth } from "../utils/auth";
import { createTwelveLabsWrapper } from "../services/twelvelabs";
import {
  generateWithStoryIQ,
  mapMetadataToGoals,
} from "../services/storyiq";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const secretsClient = new SecretsManagerClient({});

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const SECRET_ARN = process.env.SECRET_ARN!;

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

export const handler: APIGatewayProxyHandler = async (event) => {
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

    // 2. Fetch Project to get Asset ID
    const projectRes = await docClient.send(
      new GetCommand({
        TableName: PROJECTS_TABLE,
        Key: { projectId },
      })
    );

    if (!projectRes.Item) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Project not found" }),
      };
    }

    const project = projectRes.Item;
    const assetId = project.assetId;

    // 3. Fetch Asset to validate it's ready
    const assetRes = await docClient.send(
      new GetCommand({
        TableName: ASSETS_TABLE,
        Key: { assetId },
      })
    );

    if (!assetRes.Item) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Asset not found" }),
      };
    }

    const asset = assetRes.Item;

    // Check if asset is ready (either has videoId for non-chunked, or all chunks indexed)
    const isChunked = asset.isChunked || false;
    const videoId = asset.twelveLabsVideoId;
    const chunks = asset.chunks || [];

    if (!isChunked && (!videoId || videoId === "unknown")) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: "Asset has not been indexed by 12 Labs yet.",
        }),
      };
    }

    if (isChunked && chunks.some((c: any) => !c.videoId)) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: "Asset chunks are still being indexed. Please wait.",
        }),
      };
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
      // Run StoryIQ (pass transcript S3 URI if available for faster fetching)
      const result = await generateWithStoryIQ(twelvelabs, {
        assetId,
        goals,
        transcriptS3Uri: asset.transcriptionUrl,
      });

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
        return {
          statusCode: 422,
          headers: CORS_HEADERS,
          body: JSON.stringify({
            error:
              "AI could not find suitable clips, and fallback generation failed.",
            details: "Video might be too short or metadata is invalid.",
          }),
        };
      }

      console.log(
        "[generateSegments] Generated fallback segments:",
        generatedSegments.length
      );
    }

    // Sort segments chronologically
    generatedSegments.sort((a, b) => a.startTime - b.startTime);

    // 5. Update Project
    await docClient.send(
      new UpdateCommand({
        TableName: PROJECTS_TABLE,
        Key: { projectId },
        UpdateExpression: "set #seg = :s, #meta = :m, updatedAt = :u",
        ExpressionAttributeNames: {
          "#seg": "segments",
          "#meta": "metadata",
        },
        ExpressionAttributeValues: {
          ":s": generatedSegments,
          ":m": metadata || {},
          ":u": new Date().toISOString(),
        },
      })
    );

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        message: "Segments generated successfully",
        segments: generatedSegments,
      }),
    };
  } catch (error) {
    console.error("[generateSegments] Error:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Failed to generate segments" }),
    };
  }
};
