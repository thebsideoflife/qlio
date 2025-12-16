import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { TwelveLabs } from "twelvelabs-js";
import { checkAuth } from "../utils/auth";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const secretsClient = new SecretsManagerClient({});

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const SECRET_ARN = process.env.SECRET_ARN!;

// Framing analysis result
interface FramingResult {
  mode: "crop" | "fit";
  focusX: number;
  focusY: number;
  aiReasoning: string;
  isAiGenerated: boolean;
}

// Map 12labs response to focusX coordinates
const FOCUS_POSITION_MAP: Record<string, number> = {
  LEFT: 0.25,
  CENTER: 0.5,
  RIGHT: 0.75,
};

/**
 * Parse the 12labs response string into framing parameters.
 * Expected format: "STRATEGY, POSITION" (e.g., "FOCUS, RIGHT" or "WIDE, N/A")
 */
function parseFramingResponse(response: string): FramingResult {
  const normalized = response.toUpperCase().trim();

  // Default result (fit mode, centered)
  const defaultResult: FramingResult = {
    mode: "fit",
    focusX: 0.5,
    focusY: 0.5,
    aiReasoning: "Could not parse AI response, defaulting to fit mode",
    isAiGenerated: true,
  };

  // Try to parse "STRATEGY, POSITION" format
  const parts = normalized.split(",").map((p) => p.trim());

  if (parts.length < 2) {
    console.warn("Unexpected framing response format:", response);
    return defaultResult;
  }

  const strategy = parts[0];
  const position = parts[1];

  if (strategy === "WIDE") {
    return {
      mode: "fit",
      focusX: 0.5,
      focusY: 0.5,
      aiReasoning: "Wide shot detected - showing full frame",
      isAiGenerated: true,
    };
  }

  if (strategy === "FOCUS") {
    const focusX = FOCUS_POSITION_MAP[position] ?? 0.5;
    const positionLabel =
      position === "LEFT"
        ? "left side"
        : position === "RIGHT"
        ? "right side"
        : "center";

    return {
      mode: "crop",
      focusX,
      focusY: 0.5,
      aiReasoning: `Single speaker detected on ${positionLabel}`,
      isAiGenerated: true,
    };
  }

  console.warn("Unknown strategy in framing response:", strategy);
  return defaultResult;
}

/**
 * Build the prompt for 12labs Pegasus to analyze framing.
 */
function buildFramingPrompt(startTime: number, endTime: number): string {
  return `Analyze the video segment from ${startTime.toFixed(
    1
  )} seconds to ${endTime.toFixed(1)} seconds.

I am adapting this video for a vertical mobile screen. I need to decide whether to crop in on a speaker or show the full wide shot.

Determine the best framing strategy:
1. "WIDE": Use this if there are multiple active speakers, a wide establishing shot, significant movement (walking), or if important context would be lost by cropping.
2. "FOCUS": Use this ONLY if there is a clearly dominant single speaker who is relatively stationary.

If "FOCUS", where is that speaker located? (Left, Center, or Right).

Return the answer in this strict format: STRATEGY, POSITION
Examples:
- WIDE, N/A
- FOCUS, LEFT
- FOCUS, CENTER
- FOCUS, RIGHT

Respond with ONLY the strategy and position, nothing else.`;
}

export const handler: APIGatewayProxyHandler = async (event) => {
  // 1. Auth Check
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  try {
    const projectId = event.pathParameters?.projectId;
    const segmentId = event.pathParameters?.segmentId;

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

    // Parse request body for segment time range
    const body = JSON.parse(event.body || "{}");
    const { startTime, endTime } = body;

    if (typeof startTime !== "number" || typeof endTime !== "number") {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({
          error: "Missing or invalid startTime/endTime in request body",
        }),
      };
    }

    if (endTime <= startTime) {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({
          error: "endTime must be greater than startTime",
        }),
      };
    }

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

    // 5. Query 12labs for framing analysis
    console.log(
      `Analyzing framing for segment ${
        segmentId || "unknown"
      }: ${startTime}s - ${endTime}s`
    );

    const prompt = buildFramingPrompt(startTime, endTime);

    let framingResult: FramingResult;

    try {
      // Use the analyze endpoint (same pattern as generateSegments.ts)
      console.log("Calling 12labs analyze with prompt:", prompt);
      const response = await (client as any).analyze({
        videoId,
        prompt,
      });

      console.log(
        "12labs framing response:",
        JSON.stringify(response, null, 2)
      );

      // Extract the text response - handle different response formats
      let responseText: string;
      if (response?.data) {
        responseText = response.data;
      } else if (typeof response === "string") {
        responseText = response;
      } else if (response?.text) {
        responseText = response.text;
      } else {
        responseText = String(response);
      }

      console.log("Extracted response text:", responseText);
      framingResult = parseFramingResponse(responseText);

      console.log("Parsed framing result:", framingResult);
    } catch (analysisError) {
      console.error("12labs framing analysis failed:", analysisError);

      // Return a sensible default on failure
      framingResult = {
        mode: "fit",
        focusX: 0.5,
        focusY: 0.5,
        aiReasoning: "AI analysis unavailable - defaulting to fit mode",
        isAiGenerated: false,
      };
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        segmentId: segmentId || null,
        startTime,
        endTime,
        framing: framingResult,
      }),
    };
  } catch (error) {
    console.error("Error analyzing framing:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Failed to analyze framing" }),
    };
  }
};
