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
import { DirectorAgent, VideoContext, UserGoals } from "../services/director";
import { createTwelveLabsWrapper } from "../services/twelvelabs";

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

    // Check if asset is ready (either has videoId for non-chunked, or all chunks indexed)
    const isChunked = asset.isChunked || false;
    const videoId = asset.twelveLabsVideoId;
    const chunks = asset.chunks || [];

    if (!isChunked && (!videoId || videoId === "unknown")) {
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

    if (isChunked && chunks.some((c: any) => !c.videoId)) {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
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

    // Create the TwelveLabs wrapper which handles chunked videos transparently
    const twelvelabs = createTwelveLabsWrapper(apiKey, ASSETS_TABLE);

    // --- DIRECTOR AGENT WORKFLOW ---

    // Step 1: Ingest (Perceive & Ground)
    console.log("Step 1: Ingesting video context...");

    // Determine duration priority:
    // 1. Client provided (most reliable fix for broken assets)
    // 2. Stored in Asset (from upload)
    // 3. 12Labs Metadata (slow/sometimes missing)
    let videoDuration = 0;
    if (metadata?.duration && typeof metadata.duration === "number") {
      videoDuration = metadata.duration;
      console.log(`Using client-provided duration: ${videoDuration}s`);
    } else if (asset.duration && typeof asset.duration === "number") {
      videoDuration = asset.duration;
      console.log(`Using stored asset duration: ${videoDuration}s`);
    }

    let videoSummary = "";
    let videoTags: string[] = [];
    let videoTranscript = "";
    let availableScenes = "";

    // A. Fetch Duration from 12Labs (Official Source) - Only if we still don't have it
    // Uses wrapper which handles chunked videos automatically
    try {
      if (videoDuration === 0) {
        const videoMetadata = await twelvelabs.getVideoMetadata(assetId);
        if (videoMetadata.duration > 0) {
          videoDuration = videoMetadata.duration;
          console.log(`Updated video duration from 12Labs: ${videoDuration}s`);
        }
      }
    } catch (err) {
      console.warn("Failed to fetch video duration from 12Labs:", err);
    }

    // Safety fallback for duration if everything fails
    if (videoDuration === 0) {
      console.warn(
        "Duration is still 0. Defaulting to 60s to allow heuristic fallback."
      );
      videoDuration = 60;
    }

    // A2. Fetch Transcript (Grounding Source 2)
    // We try to fetch the transcription if it exists, to provide at least some text context
    try {
      // Note: The SDK might not expose a direct 'transcription' getter on the video object easily
      // We can try to use the search or retrieve endpoint, or just check if we stored it in the asset.
      // But 'asset.transcriptionUrl' is an S3 path. We can't read S3 easily here without more code.
      // Let's rely on 12Labs 'analyze' first.
    } catch (e) {}

    // B. Fetch Summary/Tags (Gist) & "Available Scenes" List using wrapper
    // Wrapper handles chunked videos transparently - aggregates from all chunks
    try {
      console.log("Fetching Gist (title, topics)...");
      const gist = await twelvelabs.gist(assetId, {
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
      // Fetch Detailed Scene List (Grounding) using wrapper
      // For chunked videos, this queries all chunks and adjusts timestamps
      const groundingPrompt =
        "Provide a chronological list of every distinct scene in the video. " +
        "For each scene, strictly provide the Start Time (in seconds), End Time (in seconds), and a detailed visual description. " +
        "Format each scene as: [StartSeconds-EndSeconds] Description";

      console.log("Fetching Available Scenes (analyze)...");
      const sceneResponse = await twelvelabs.analyze(assetId, {
        prompt: groundingPrompt,
      });
      console.log("Scene Response:", JSON.stringify(sceneResponse, null, 2));

      if (sceneResponse && sceneResponse.data) {
        availableScenes = sceneResponse.data;
        console.log("Grounding: Retrieved Available Scenes list.");
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
      availableScenes = `SCENE_LIST_UNAVAILABLE. 
      Whole Video [0-${videoDuration.toFixed(0)}]: 
      Summary: ${videoSummary}. 
      Topics: ${videoTags.join(", ") || "unknown"}`;
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

    // Step 4: Fallback / Failure Mode
    if (generatedSegments.length === 0) {
      console.warn(
        "Director Agent failed to find valid segments. Attempting heuristic fallback."
      );

      // Heuristic Fallback: Generate 3 evenly spaced segments
      // 1. Intro (Start)
      // 2. Climax (Middle)
      // 3. Conclusion (End)

      const safeDuration = videoDuration > 0 ? videoDuration : 60;
      const segmentDuration = Math.min(15, Math.max(5, safeDuration / 10)); // Between 5s and 15s

      // Segment 1: Start
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

      // Segment 2: Middle (if video is long enough)
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

      // Segment 3: End (if video is long enough)
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
        console.error("Heuristic fallback also failed (video too short?).");
        return {
          statusCode: 422,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
          body: JSON.stringify({
            error:
              "AI could not find suitable clips, and fallback generation failed.",
            details: "Video might be too short or metadata is invalid.",
          }),
        };
      }

      console.log("Generated fallback segments:", generatedSegments);
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
