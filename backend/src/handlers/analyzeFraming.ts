import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { checkAuth } from "../utils/auth";
import { createTwelveLabsWrapper } from "../services/twelvelabs";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const secretsClient = new SecretsManagerClient({});

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const SECRET_ARN = process.env.SECRET_ARN!;

// ============================================================================
// TYPES & SCHEMAS
// ============================================================================

/** Target aspect ratio for reframing (input is always assumed 16:9) */
type TargetAspectRatio = "16:9" | "1:1" | "9:16";

/** Valid horizontal positions for CROP mode */
type HorizontalPosition =
  | "FAR_LEFT"
  | "SLIGHT_LEFT"
  | "CENTER"
  | "SLIGHT_RIGHT"
  | "FAR_RIGHT";

/** Structured output from the framing analysis */
interface FramingResult {
  mode: "crop" | "fit";
  focusX: number;
  focusY: number;
  aiReasoning: string;
  isAiGenerated: boolean;
}

/** Parsed AI response before validation */
interface ParsedAIResponse {
  strategy: string;
  position: string;
  raw: string;
}

// ============================================================================
// POSITION MAPPING
// ============================================================================

/** Maps position tokens to focusX values (0 = left edge, 1 = right edge) */
const HORIZONTAL_POSITION_MAP: Record<HorizontalPosition, number> = {
  FAR_LEFT: 0.0,
  SLIGHT_LEFT: 0.25,
  CENTER: 0.5,
  SLIGHT_RIGHT: 0.75,
  FAR_RIGHT: 1.0,
};

const VALID_POSITIONS = new Set<string>(Object.keys(HORIZONTAL_POSITION_MAP));

// ============================================================================
// RESPONSE PARSING (Factor 1: JSON Extraction as Foundation)
// ============================================================================

/**
 * Extract strategy and position from raw AI response.
 * Handles variations in formatting (spaces, underscores, case).
 */
function extractFromResponse(raw: string): ParsedAIResponse {
  const normalized = raw.toUpperCase().trim();
  const parts = normalized.split(",").map((p) => p.trim());

  return {
    strategy: parts[0] || "",
    position: (parts[1] || "").replace(/\s+/g, "_"), // "FAR LEFT" → "FAR_LEFT"
    raw,
  };
}

/**
 * Validate and convert parsed response to structured FramingResult.
 * Returns null if validation fails.
 */
function validateAndConvert(
  parsed: ParsedAIResponse,
  targetAspectRatio: TargetAspectRatio
): FramingResult | null {
  const { strategy, position } = parsed;

  // FIT mode - always valid, always centered
  if (strategy === "FIT") {
    return {
      mode: "fit",
      focusX: 0.5,
      focusY: 0.5,
      aiReasoning:
        "Showing full frame with letterboxing to preserve wide context",
      isAiGenerated: true,
    };
  }

  // CROP mode - validate position
  if (strategy === "CROP") {
    // CROP doesn't make sense for landscape (input already 16:9)
    if (targetAspectRatio === "16:9") {
      console.warn(
        "[Framing] CROP requested for landscape output, falling back to FIT"
      );
      return {
        mode: "fit",
        focusX: 0.5,
        focusY: 0.5,
        aiReasoning: "Using fit for landscape output (no crop needed)",
        isAiGenerated: true,
      };
    }

    // Validate position is in our known set
    if (!VALID_POSITIONS.has(position)) {
      console.warn(
        `[Framing] Unknown position "${position}", defaulting to CENTER`
      );
    }

    const focusX =
      HORIZONTAL_POSITION_MAP[position as HorizontalPosition] ?? 0.5;
    const positionLabel =
      POSITION_LABELS[position as HorizontalPosition] || "center";

    return {
      mode: "crop",
      focusX,
      focusY: 0.5,
      aiReasoning: `Cropping to focus on ${positionLabel}`,
      isAiGenerated: true,
    };
  }

  // Unknown strategy
  return null;
}

/** Human-readable labels for positions */
const POSITION_LABELS: Record<HorizontalPosition, string> = {
  FAR_LEFT: "far left",
  SLIGHT_LEFT: "slight left",
  CENTER: "center",
  SLIGHT_RIGHT: "slight right",
  FAR_RIGHT: "far right",
};

/**
 * Parse the 12labs response string into framing parameters.
 *
 * Flow: raw string → extract → validate → structured result
 * Falls back to safe defaults on parse failure.
 */
function parseFramingResponse(
  response: string,
  targetAspectRatio: TargetAspectRatio
): FramingResult {
  const parsed = extractFromResponse(response);

  // Log for debugging (Factor 11: visibility into AI responses)
  console.log(
    `[Framing] Parsed: strategy="${parsed.strategy}", position="${parsed.position}"`
  );

  const result = validateAndConvert(parsed, targetAspectRatio);

  if (result) {
    return result;
  }

  // Fallback for unparseable responses
  console.warn(`[Framing] Could not parse response: "${response}"`);
  return {
    mode: "fit",
    focusX: 0.5,
    focusY: 0.5,
    aiReasoning: `Could not parse AI response ("${parsed.strategy}"), defaulting to fit`,
    isAiGenerated: true,
  };
}

// ============================================================================
// PROMPTS (Factor 2: Own Your Prompts)
// Prompts are explicit, testable, and not hidden in framework abstractions.
// ============================================================================

/**
 * Build orientation-specific prompts for 12labs Pegasus.
 * The prompt changes based on target aspect ratio to give the AI proper context.
 */
function buildFramingPrompt(
  startTime: number,
  endTime: number,
  targetAspectRatio: TargetAspectRatio
): string {
  const timeRange = `${startTime.toFixed(1)}s to ${endTime.toFixed(1)}s`;

  if (targetAspectRatio === "16:9") {
    // Landscape output from landscape input - no decisions needed
    return `Look at the video segment from ${timeRange}. The original video is 16:9 landscape and the target is also 16:9.

Since the aspect ratios match, just respond: FIT, N/A`;
  }

  if (targetAspectRatio === "1:1") {
    // Square output from landscape input
    return `Look at the video segment from ${timeRange}. The original video is 16:9 landscape.

TARGET: 1:1 square. The left and right edges will be cropped off.

Your job: Find the MOST IMPORTANT MOMENT in this segment (usually whoever is speaking) and decide where to position the crop window.

RULES:
- If someone is SPEAKING, ALWAYS use CROP centered on them. A tiny letterboxed talking head is useless.
- CROP fills the frame and looks professional. Use it for: speakers, interviews, focused action, any single subject.
- FIT shows everything but with black bars above and below. ONLY use FIT when multiple important subjects are on opposite sides of the frame AND they're all essential to show simultaneously.

CROP positions (where to place your square window on the wide frame):
- FAR_LEFT - Window on the left edge
- SLIGHT_LEFT - Window slightly left of center
- CENTER - Window centered
- SLIGHT_RIGHT - Window slightly right of center  
- FAR_RIGHT - Window on the right edge

Examples:
- Speaker on left third → CROP, SLIGHT_LEFT
- Speaker centered → CROP, CENTER
- Speaker on right → CROP, SLIGHT_RIGHT
- Two people debating on opposite sides → FIT, N/A

Respond with ONLY your choice (e.g., "CROP, CENTER"). Nothing else.`;
  }

  // Portrait (9:16) output from landscape input
  return `Look at the video segment from ${timeRange}. The original video is 16:9 landscape.

TARGET: 9:16 portrait (vertical). This is a dramatic crop—most of the left and right will be cut off.

Your job: Find the MOST IMPORTANT MOMENT in this segment (usually whoever is speaking) and decide where to position the narrow vertical crop window.

RULES:
- If someone is SPEAKING, ALWAYS use CROP centered on them. A tiny letterboxed talking head is completely useless on mobile.
- CROP fills the vertical screen and looks intentional. Use it for: speakers, interviews, focused action, any single subject.
- FIT shows the full wide video but TINY with huge black bars above and below. ONLY use FIT when multiple essential subjects are on opposite sides AND you absolutely cannot crop to one.

CROP positions (where to place your vertical window on the wide frame):
- FAR_LEFT - Window on the left edge
- SLIGHT_LEFT - Window slightly left of center
- CENTER - Window centered
- SLIGHT_RIGHT - Window slightly right of center
- FAR_RIGHT - Window on the right edge

Examples:
- Speaker on left third → CROP, SLIGHT_LEFT  
- Speaker centered → CROP, CENTER
- Speaker on right edge → CROP, FAR_RIGHT
- Wide landscape shot with no clear subject → FIT, N/A (rare!)

Respond with ONLY your choice (e.g., "CROP, CENTER"). Nothing else.`;
}

// ============================================================================
// HANDLER (Factor 5: Own Your Control Flow)
// Clear flow: validate → fetch context → prompt → parse → respond
// ============================================================================

/** Standard CORS headers for all responses */
const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

/** Create a structured error response */
function errorResponse(statusCode: number, error: string) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify({ error }),
  };
}

/** Create a success response */
function successResponse(data: object) {
  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify(data),
  };
}

export const handler: APIGatewayProxyHandler = async (event) => {
  // Step 1: Auth
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  try {
    // Step 2: Validate input
    const projectId = event.pathParameters?.projectId;
    const segmentId = event.pathParameters?.segmentId;

    if (!projectId) {
      return errorResponse(400, "Missing projectId");
    }

    const body = JSON.parse(event.body || "{}");
    const { startTime, endTime, targetAspectRatio } = body;

    if (typeof startTime !== "number" || typeof endTime !== "number") {
      return errorResponse(
        400,
        "Missing or invalid startTime/endTime in request body"
      );
    }

    if (endTime <= startTime) {
      return errorResponse(400, "endTime must be greater than startTime");
    }

    // Validate aspect ratio (default to portrait)
    const validAspectRatios: TargetAspectRatio[] = ["16:9", "1:1", "9:16"];
    const aspectRatio: TargetAspectRatio = validAspectRatios.includes(
      targetAspectRatio
    )
      ? targetAspectRatio
      : "9:16";

    // Step 3: Fetch context (project → asset → videoId)
    const projectRes = await docClient.send(
      new GetCommand({ TableName: PROJECTS_TABLE, Key: { projectId } })
    );
    if (!projectRes.Item) {
      return errorResponse(404, "Project not found");
    }

    const assetId = projectRes.Item.assetId;
    const assetRes = await docClient.send(
      new GetCommand({ TableName: ASSETS_TABLE, Key: { assetId } })
    );
    if (!assetRes.Item) {
      return errorResponse(404, "Asset not found");
    }

    const asset = assetRes.Item;
    const isChunked = asset.isChunked || false;
    const videoId = asset.twelveLabsVideoId;
    const chunks = asset.chunks || [];

    // Check if asset is ready for analysis
    if (!isChunked && (!videoId || videoId === "unknown")) {
      return errorResponse(400, "Asset has not been indexed by 12 Labs yet");
    }

    if (isChunked && chunks.some((c: any) => !c.videoId)) {
      return errorResponse(400, "Asset chunks are still being indexed");
    }

    // Step 4: Get API credentials and create wrapper
    const secretVal = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: SECRET_ARN })
    );
    if (!secretVal.SecretString) {
      throw new Error("12Labs API Key not found in secrets");
    }

    // Use wrapper which handles chunked videos transparently
    const twelvelabs = createTwelveLabsWrapper(
      secretVal.SecretString,
      ASSETS_TABLE
    );

    // Step 5: Build prompt and call AI
    console.log(
      `[Framing] Analyzing segment ${
        segmentId || "unknown"
      }: ${startTime}s-${endTime}s (target: ${aspectRatio})`
    );

    const prompt = buildFramingPrompt(startTime, endTime, aspectRatio);
    console.log("[Framing] Prompt:", prompt.substring(0, 200) + "...");

    let framingResult: FramingResult;

    try {
      // Use wrapper's analyze method - handles chunked videos automatically
      // by finding the right chunk for the given time range
      const response = await twelvelabs.analyze(assetId, {
        prompt,
        startTime,
        endTime,
      });

      // Step 6: Extract and parse response
      const responseText = response.data;
      console.log("[Framing] Raw AI response:", responseText);

      framingResult = parseFramingResponse(responseText, aspectRatio);
      console.log("[Framing] Result:", JSON.stringify(framingResult));
    } catch (analysisError) {
      // Factor 11: Graceful degradation on AI failure
      console.error("[Framing] AI analysis failed:", analysisError);
      framingResult = {
        mode: "fit",
        focusX: 0.5,
        focusY: 0.5,
        aiReasoning: "AI analysis unavailable - defaulting to fit mode",
        isAiGenerated: false,
      };
    }

    // Step 7: Return structured result
    return successResponse({
      segmentId: segmentId || null,
      startTime,
      endTime,
      framing: framingResult,
    });
  } catch (error) {
    // Factor 11: Top-level error handling
    console.error("[Framing] Unexpected error:", error);
    return errorResponse(500, "Failed to analyze framing");
  }
};
