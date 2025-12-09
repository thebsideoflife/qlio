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
import { TwelveLabs } from "twelvelabs-js";
import { randomUUID } from "crypto";
import { checkAuth } from "../utils/auth";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const secretsClient = new SecretsManagerClient({});

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const TWELVE_LABS_INDEX_ID = process.env.TWELVE_LABS_INDEX_ID!;
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

export const handler: APIGatewayProxyHandler = async (event) => {
  // 1. Auth Check
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  try {
    const projectId = event.pathParameters?.projectId;
    if (!projectId) {
      return {
        statusCode: 400,
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
        body: JSON.stringify({ error: "Project not found" }),
      };
    }

    const project = projectRes.Item;
    const assetId = project.assetId;

    // 3. Fetch Asset to get 12 Labs Video ID
    const assetRes = await docClient.send(
      new GetCommand({
        TableName: ASSETS_TABLE,
        Key: { assetId },
      })
    );

    if (!assetRes.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Asset not found" }),
      };
    }

    const asset = assetRes.Item;
    const videoId = asset.twelveLabsVideoId;

    if (!videoId || videoId === "unknown") {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Asset has not been indexed by 12 Labs yet.",
        }),
      };
    }

    // 4. Get 12 Labs API Key
    const secretVal = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: SECRET_ARN })
    );
    const apiKey = secretVal.SecretString;
    if (!apiKey) throw new Error("12Labs API Key not found");

    const client = new TwelveLabs({ apiKey });

    // Fetch Duration for fallback logic
    let videoDuration = asset.duration || 600;

    // Only fetch from 12Labs if not present in asset
    if (!asset.duration) {
      try {
        const videoInfo = await client.indexes.videos.retrieve(
          TWELVE_LABS_INDEX_ID,
          videoId
        );
        // Explicitly cast to any because the official type definition might be missing 'metadata'
        // even though the API returns it.
        const anyVideoInfo = videoInfo as any;

        if (anyVideoInfo.metadata && anyVideoInfo.metadata.duration) {
          videoDuration = anyVideoInfo.metadata.duration;
        }
      } catch (err) {
        console.warn("Failed to fetch video duration from 12Labs:", err);
      }
    }

    // 5. Generate Segments
    let generatedSegments: Segment[] = [];

    // For very short videos (<15 seconds), suggest using the entire video as one segment
    if (videoDuration < 15) {
      console.log(
        `Video is very short (${videoDuration}s). Using entire video as single segment.`
      );
      generatedSegments = [
        {
          id: randomUUID(),
          startTime: 0,
          endTime: videoDuration,
          title: "Full Video",
          description: "Short-form content - entire video selected",
          confidence: 1.0,
          sceneTags: ["full-video", "short-form"],
          keyDialogue: "",
          characters: [],
        },
      ];
    } else {
      // Construct search query based on user preferences
      const terms = ["engaging scene", "highlight"];
      if (metadata?.platform) terms.push(metadata.platform);
      if (metadata?.driver) terms.push(metadata.driver);
      if (metadata?.audience?.age?.includes("13-17")) terms.push("viral");
      if (metadata?.type) terms.push(metadata.type);

      const searchQuery = terms.join(" ");
      console.log("Generating segments with query:", searchQuery);

      try {
        const searchResults = await client.search.query({
          indexId: TWELVE_LABS_INDEX_ID,
          queryText: searchQuery,
          searchOptions: ["visual", "transcription"],
        });

        // Filter by confidence score (only keep good matches)
        const filteredResults = searchResults.data.filter(
          (match: any) => match.score > 0.6
        );

        if (filteredResults.length > 0) {
          generatedSegments = filteredResults
            .slice(0, 4)
            .map((match: any) => ({
              id: randomUUID(),
              startTime: match.start,
              endTime: match.end,
              title: "Highlight Segment",
              description: `Confidence: ${match.score.toFixed(2)}`,
              confidence: match.score,
              sceneTags: ["highlight", "auto-generated"],
              keyDialogue: "",
              characters: [],
            }))
            .sort((a, b) => a.startTime - b.startTime);
        }
      } catch (err) {
        console.error("Search step failed:", err);
      }
    }

    // 6. Fallback if still empty (smarter fallback for longer videos)
    if (generatedSegments.length === 0 && videoDuration >= 15) {
      console.log(
        "No high-quality segments found. Using intelligent fallback."
      );

      // For short-medium videos (15-60s), use 1-2 segments
      if (videoDuration < 60) {
        generatedSegments = [
          {
            id: randomUUID(),
            startTime: 0,
            endTime: videoDuration,
            title: "Full Clip",
            description: "Short content - full duration recommended",
            confidence: 0.7,
            sceneTags: ["full-clip"],
            keyDialogue: "",
            characters: [],
          },
        ];
      } else {
        // For longer videos, create evenly distributed segments
        const numSegments = Math.min(3, Math.floor(videoDuration / 30)); // One segment per 30 seconds, max 3
        const segmentLength = Math.min(20, videoDuration / numSegments);

        generatedSegments = Array.from({ length: numSegments }, (_, i) => {
          const start =
            (videoDuration / (numSegments + 1)) * (i + 1) - segmentLength / 2;
          const clampedStart = Math.max(0, start);
          const end = Math.min(clampedStart + segmentLength, videoDuration);

          return {
            id: randomUUID(),
            startTime: clampedStart,
            endTime: end,
            title: `Segment ${i + 1}`,
            description: "Auto-generated segment",
            confidence: 0.5,
            sceneTags: ["auto-generated"],
            keyDialogue: "",
            characters: [],
          };
        });
      }
    }

    // 7. Update Project
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
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        message: "Segments generated successfully",
        segments: generatedSegments,
      }),
    };
  } catch (error) {
    console.error("Error generating segments:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Failed to generate segments" }),
    };
  }
};
