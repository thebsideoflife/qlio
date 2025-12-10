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
import { DirectorAgent, VideoContext, UserGoals } from "../services/director";

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
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
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
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
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
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ error: "Asset not found" }),
      };
    }

    const asset = assetRes.Item;
    const videoId = asset.twelveLabsVideoId;

    if (!videoId || videoId === "unknown") {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
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

    // --- DIRECTOR AGENT WORKFLOW ---

    // Step 1: Ingest (Perceive & Ground)
    console.log("Step 1: Ingesting video context...");

    let videoDuration = asset.duration || 0;
    let videoSummary = "";
    let videoTags: string[] = [];
    let videoTranscript = "";
    let availableScenes = "";

    // A. Fetch Duration from 12Labs (Official Source)
    try {
      const videoInfo = await client.indexes.videos.retrieve(
        TWELVE_LABS_INDEX_ID,
        videoId
      );
      const anyVideoInfo = videoInfo as any;
      if (
        anyVideoInfo.metadata &&
        typeof anyVideoInfo.metadata.duration === "number"
      ) {
        videoDuration = anyVideoInfo.metadata.duration;
        console.log(`Updated video duration from 12Labs: ${videoDuration}s`);
      }
    } catch (err) {
      console.warn("Failed to fetch video duration from 12Labs:", err);
    }

    // A2. Fetch Transcript (Grounding Source 2)
    // We try to fetch the transcription if it exists, to provide at least some text context
    try {
      // Note: The SDK might not expose a direct 'transcription' getter on the video object easily
      // We can try to use the search or retrieve endpoint, or just check if we stored it in the asset.
      // But 'asset.transcriptionUrl' is an S3 path. We can't read S3 easily here without more code.
      // Let's rely on 12Labs 'analyze' first.
    } catch (e) {}

    // B. Fetch Summary/Tags (Gist) & "Available Scenes" List using correct SDK methods
    try {
      // Fetch standard summary using client.gist() - the correct method per 12Labs docs
      console.log("Fetching Gist (title, topics)...");
      const gist = await (client as any).gist({
        videoId: videoId,
        types: ["title", "topic"],
      });
      if (gist) {
        videoSummary = gist.title || "";
        videoTags = gist.topics || [];
        console.log("Gist fetched successfully:", {
          title: videoSummary,
          topics: videoTags,
        });
      }
    } catch (e) {
      console.warn("Failed to fetch gist:", e);
    }

    try {
      // Fetch Detailed Scene List (Grounding) using client.analyze() - the correct method per 12Labs docs
      const groundingPrompt =
        "Provide a chronological list of every distinct scene in the video. " +
        "For each scene, strictly provide the Start Time (in seconds), End Time (in seconds), and a detailed visual description. " +
        "Format each scene as: [StartSeconds-EndSeconds] Description";

      console.log("Fetching Available Scenes (analyze)...");
      const sceneResponse = await (client as any).analyze({
        videoId: videoId,
        prompt: groundingPrompt,
      });
      console.log("Scene Response:", JSON.stringify(sceneResponse, null, 2));

      if (sceneResponse && sceneResponse.data) {
        availableScenes = sceneResponse.data;
        console.log("Grounding: Retrieved Available Scenes list.");
      } else if (sceneResponse && typeof sceneResponse === "string") {
        availableScenes = sceneResponse;
        console.log("Grounding: Retrieved Available Scenes (string response).");
      } else {
        console.warn(
          "Grounding: Scene response was empty or unexpected format."
        );
        // Fallback: provide basic context
        availableScenes = `Whole Video [0-${videoDuration.toFixed(
          0
        )}]: Video about ${videoTags.join(", ") || "general content"}`;
      }
    } catch (e) {
      console.warn("Failed to analyze for scenes:", e);
      // Fallback: If analyze fails, construct a simple "Whole Video" context
      availableScenes = `Whole Video [0-${videoDuration.toFixed(
        0
      )}]: Video duration ${videoDuration}s, topics: ${
        videoTags.join(", ") || "unknown"
      }`;
    }

    // Step 2: Ideate (Reason)
    console.log("Step 2: Ideating with Director Agent...");

    const context: VideoContext = {
      duration: videoDuration,
      summary:
        videoSummary ||
        "Video content about " + (metadata?.topic || "general topics"),
      transcript: videoTranscript,
      tags: videoTags,
      availableScenes: availableScenes, // Pass the ground truth
    };

    const goals: UserGoals = {
      platform: metadata?.platform || "TikTok",
      intent: metadata?.intent || "Viral Teaser",
      targetAudience: metadata?.audience || "General",
      style: metadata?.style || "High Energy",
    };

    let generatedSegments: Segment[] = [];

    try {
      // Call the Director Agent (LLM)
      const directorOutput = await DirectorAgent.ideate(context, goals);
      console.log("Director Plan:", JSON.stringify(directorOutput, null, 2));

      // Step 3: Retrieve (Act)
      console.log("Step 3: Processing Director's grounded plan...");

      const plan = directorOutput.plan || [];

      for (const planItem of plan) {
        // Since we are now using grounded selection, we expect precise timestamps
        // But we validate them

        let start = planItem.startTime;
        let end = planItem.endTime;

        // Basic Validation
        if (typeof start !== "number" || typeof end !== "number") {
          console.warn(
            "Skipping invalid segment (non-number times):",
            planItem
          );
          continue;
        }

        // Ensure within bounds
        start = Math.max(0, start);
        end = Math.min(videoDuration > 0 ? videoDuration : end, end); // Cap at video duration if known

        // Ensure min duration (5 seconds)
        if (end - start < 5) {
          console.warn(
            `Segment too short (${end - start}s), skipping:`,
            planItem.title
          );
          continue;
        }

        generatedSegments.push({
          id: randomUUID(),
          startTime: start,
          endTime: end,
          title: planItem.title || "Selected Scene",
          description: planItem.reasoning,
          confidence: 1.0, // High confidence because it came from the grounded list
          // Clean metadata
          sceneTags: [],
          keyDialogue: planItem.expectedContent,
          characters: [],
        });
      }
    } catch (err) {
      console.error("Director Agent flow encountered an error:", err);
    }

    // Step 4: Strict Failure Mode (No Fallback)
    if (generatedSegments.length === 0) {
      console.error("Director Agent failed to find any valid segments.");
      return {
        statusCode: 422, // Unprocessable Entity
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({
          error: "AI could not find suitable clips meeting the criteria.",
          details:
            "No segments found in Director plan or segments were too short.",
        }),
      };
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
