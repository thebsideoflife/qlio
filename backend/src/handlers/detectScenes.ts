import { Handler } from "aws-lambda";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createTwelveLabsWrapper } from "../services/twelvelabs";

const secretsClient = new SecretsManagerClient({});
const s3Client = new S3Client({});

const SECRET_ARN = process.env.SECRET_ARN!;
const BUCKET_NAME = process.env.BUCKET_NAME!;

// ============================================================================
// Types
// ============================================================================

interface DetectScenesPayload {
  assetId: string;
}

// ============================================================================
// Handler
// ============================================================================

/**
 * Async Lambda for scene detection.
 * Called by generateSegments Lambda when scene cache is empty.
 * Runs with 15-minute timeout to process long videos.
 */
export const handler: Handler<DetectScenesPayload> = async (event) => {
  const { assetId } = event;

  if (!assetId) {
    throw new Error("Missing assetId in payload");
  }

  console.log(`[DetectScenes] Starting scene detection for asset ${assetId}`);

  try {
    // Note: in_progress marker is already written by storyiq/index.ts before invoking this Lambda

    // 1. Get API key from secrets
    const secretVal = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: SECRET_ARN })
    );
    const apiKey = secretVal.SecretString;
    if (!apiKey) {
      throw new Error("12Labs API Key not found");
    }

    // 2. Create wrapper and run scene detection
    const twelvelabs = createTwelveLabsWrapper(apiKey);
    const result = await twelvelabs.detectScenes(assetId);

    console.log(
      `[DetectScenes] Completed for ${assetId}: ` +
        `${result.brief.length} scenes detected, ` +
        `${result.meta?.windowsSucceeded}/${result.meta?.windowsTotal} windows succeeded`
    );

    // If detection was incomplete (e.g., rate limited), mark as failed so next request retries
    if (!result.meta?.isComplete) {
      const reason = result.meta?.hitRateLimit
        ? "Rate limit exceeded"
        : "Incomplete detection";
      console.warn(
        `[DetectScenes] Marking as failed for ${assetId}: ${reason}`
      );
      await markSceneDetectionFailed(assetId, reason);

      return {
        success: false,
        assetId,
        scenesDetected: result.brief.length,
        isComplete: false,
        reason,
      };
    }

    return {
      success: true,
      assetId,
      scenesDetected: result.brief.length,
      isComplete: true,
    };
  } catch (error: any) {
    console.error(`[DetectScenes] Failed for ${assetId}:`, error);

    // Write failed status to cache so next request can retry
    await markSceneDetectionFailed(assetId, error.message);

    throw error;
  }
};

// ============================================================================
// Cache Markers
// ============================================================================

/**
 * Write failed status to scene cache.
 * Allows next request to retry instead of waiting forever.
 */
async function markSceneDetectionFailed(
  assetId: string,
  errorMessage: string
): Promise<void> {
  if (!BUCKET_NAME) return;

  const key = `scene-cache/${assetId}.json`;
  const body = JSON.stringify({
    status: "failed",
    failedAt: new Date().toISOString(),
    error: errorMessage,
    assetId,
  });

  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: body,
        ContentType: "application/json",
      })
    );
    console.log(`[DetectScenes] Marked failed for ${assetId}`);
  } catch (err: any) {
    console.warn(`[DetectScenes] Failed to write failure marker:`, err.message);
  }
}
