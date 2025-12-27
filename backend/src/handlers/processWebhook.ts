import { APIGatewayProxyHandler } from "aws-lambda";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { TwelveLabs } from "twelvelabs-js";
import { createHmac } from "crypto";
import axios from "axios";

const s3Client = new S3Client({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});
const secretsClient = new SecretsManagerClient({});

const TABLE_NAME = process.env.TABLE_NAME!;
const CHUNK_TASKS_TABLE = process.env.CHUNK_TASKS_TABLE;
const SECRET_ARN = process.env.SECRET_ARN!;
const SIGNING_SECRET_ARN = process.env.SIGNING_SECRET_ARN!;
const TWELVE_LABS_INDEX_ID = process.env.TWELVE_LABS_INDEX_ID!;
const BUCKET_NAME = process.env.BUCKET_NAME!;

interface ChunkInfo {
  chunkIndex: number;
  s3Key: string;
  startOffset: number;
  endOffset: number;
  duration: number;
  taskId?: string;
  videoId?: string;
}

export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    // 1. Verify Signature
    const signature =
      event.headers["tl-signature"] ||
      event.headers["TL-Signature"] ||
      event.headers["x-twelvelabs-signature"] ||
      event.headers["X-Twelvelabs-Signature"];

    let webhookBody = event.body || "{}";
    if (event.isBase64Encoded && event.body) {
      webhookBody = Buffer.from(event.body, "base64").toString("utf-8");
    }

    // Fetch signing secret
    const secretVal = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: SIGNING_SECRET_ARN })
    );
    const signingSecret = secretVal.SecretString;

    if (signingSecret && signature) {
      // Parse header: t=timestamp,v1=signature
      const parts = signature.split(",");
      const timestampPart = parts.find((p) => p.trim().startsWith("t="));
      const signaturePart = parts.find((p) => p.trim().startsWith("v1="));

      if (!timestampPart || !signaturePart) {
        console.error("Invalid signature header format", signature);
        return {
          statusCode: 401,
          body: JSON.stringify({ error: "Invalid signature format" }),
        };
      }

      const timestamp = timestampPart.trim().substring(2);
      const providedSignature = signaturePart.trim().substring(3);

      // Construct signed payload: timestamp + "." + rawBody
      const signedPayload = `${timestamp}.${webhookBody}`;

      const hmac = createHmac("sha256", signingSecret);
      hmac.update(signedPayload);
      const computedSignature = hmac.digest("hex");

      if (providedSignature !== computedSignature) {
        console.error("Invalid webhook signature", {
          provided: providedSignature,
          computed: computedSignature,
          timestamp,
        });
        return {
          statusCode: 401,
          body: JSON.stringify({ error: "Invalid signature" }),
        };
      }
    } else if (signingSecret) {
      console.error(
        "Missing webhook signature header. Received headers:",
        event.headers
      );
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Missing signature" }),
      };
    } else {
      console.warn(
        "Skipping signature verification: No signing secret configured."
      );
    }

    const body = JSON.parse(webhookBody);
    const eventType = body.type;
    const taskStatus = body.status;
    let taskId = body.id;

    if (eventType === "index.task.ready") {
      taskId = body.data?.id;
    }

    if (
      (eventType !== "index_task_status" && eventType !== "index.task.ready") ||
      (taskStatus !== "ready" && body.data?.status !== "ready")
    ) {
      if (eventType !== "index.task.ready" && taskStatus !== "ready") {
        console.log("Ignoring webhook:", eventType, taskStatus);
        return {
          statusCode: 200,
          body: JSON.stringify({ message: "Ignored" }),
        };
      }
    }

    if (!taskId) {
      console.error("Missing taskId", body);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing task ID" }),
      };
    }

    const videoId = body.data?.video_id;

    // 2. Check if this is a chunk task first
    if (CHUNK_TASKS_TABLE) {
      const chunkTaskResult = await docClient.send(
        new GetCommand({
          TableName: CHUNK_TASKS_TABLE,
          Key: { taskId },
        })
      );

      if (chunkTaskResult.Item) {
        // This is a chunk completion webhook
        return await handleChunkCompletion(
          chunkTaskResult.Item,
          videoId,
          taskId
        );
      }
    }

    // 3. Find Asset by Task ID (non-chunked video)
    const queryRes = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: "TaskIdIndex",
        KeyConditionExpression: "twelveLabsTaskId = :tid",
        ExpressionAttributeValues: {
          ":tid": taskId,
        },
      })
    );

    if (!queryRes.Items || queryRes.Items.length === 0) {
      console.error("No asset found for task", taskId);
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Asset not found" }),
      };
    }

    const asset = queryRes.Items[0];
    const assetId = asset.assetId;

    // Handle non-chunked video completion
    return await handleSingleVideoCompletion(
      assetId,
      videoId || asset.twelveLabsVideoId
    );
  } catch (error) {
    console.error("Error processing webhook:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal Server Error" }),
    };
  }
};

/**
 * Handle completion of a single (non-chunked) video indexing
 */
async function handleSingleVideoCompletion(
  assetId: string,
  videoId: string
): Promise<{ statusCode: number; headers?: any; body: string }> {
  // Fetch 12 Labs API Key to get transcription
  const secretVal12Labs = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: SECRET_ARN })
  );
  const apiKey = secretVal12Labs.SecretString;
  let transcriptionUrl = null;
  let videoDuration = 0;

  if (apiKey && videoId && videoId !== "unknown") {
    const client = new TwelveLabs({ apiKey });

    // Get video metadata for duration
    try {
      const video = await client.indexes.videos.retrieve(
        TWELVE_LABS_INDEX_ID,
        videoId
      );

      // 12Labs stores duration in various places depending on API version
      const anyVideo = video as any;
      videoDuration =
        anyVideo.system_metadata?.duration ||
        anyVideo.metadata?.duration ||
        anyVideo.hls?.duration ||
        anyVideo.duration ||
        0;

      console.log(
        "12Labs video duration:",
        videoDuration,
        "from response:",
        JSON.stringify(video, null, 2).slice(0, 500)
      );
    } catch (err) {
      console.error("Failed to fetch video metadata from 12 Labs", err);
    }

    // Get Transcription & Store in S3
    try {
      console.log(`Fetching transcription for video ${videoId}...`);

      const url = `https://api.twelvelabs.io/v1.3/indexes/${TWELVE_LABS_INDEX_ID}/videos/${videoId}`;
      const response = await axios.get(url, {
        headers: {
          "x-api-key": apiKey,
        },
        params: {
          transcription: true,
        },
      });

      const data = response.data;
      const transcriptionData = data.transcription;

      if (transcriptionData && Array.isArray(transcriptionData)) {
        const key = `transcriptions/${assetId}.json`;
        await s3Client.send(
          new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            Body: JSON.stringify(transcriptionData),
            ContentType: "application/json",
          })
        );

        transcriptionUrl = `s3://${BUCKET_NAME}/${key}`;
        console.log("Transcription stored at", transcriptionUrl);

        // Fallback: If duration is 0, estimate from last transcript segment
        if (videoDuration === 0 && transcriptionData.length > 0) {
          const lastSegment = transcriptionData[transcriptionData.length - 1];
          const estimatedDuration = lastSegment.end || lastSegment.endTime || 0;
          if (estimatedDuration > 0) {
            videoDuration = estimatedDuration;
            console.log(
              `Duration estimated from transcript: ${videoDuration}s`
            );
          }
        }
      } else {
        console.warn("No transcription data found in response", data);
      }
    } catch (err) {
      console.error("Failed to fetch/store transcription", err);
    }
  }

  // Update DynamoDB
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { assetId },
      UpdateExpression:
        "SET #s = :status, twelveLabsVideoId = :vid, transcriptionUrl = :trans, #dur = :dur, updatedAt = :ua",
      ExpressionAttributeNames: {
        "#s": "status",
        "#dur": "duration",
      },
      ExpressionAttributeValues: {
        ":status": "READY",
        ":vid": videoId || "unknown",
        ":trans": transcriptionUrl,
        ":dur": videoDuration,
        ":ua": new Date().toISOString(),
      },
    })
  );

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "OK",
      status: "READY",
    }),
  };
}

/**
 * Handle completion of a chunk indexing task
 */
async function handleChunkCompletion(
  chunkTask: any,
  videoId: string,
  taskId: string
): Promise<{ statusCode: number; headers?: any; body: string }> {
  const { assetId, chunkIndex } = chunkTask;

  console.log(
    `Chunk ${chunkIndex} completed for asset ${assetId}, videoId: ${videoId}`
  );

  // Get current asset
  const assetRes = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { assetId },
    })
  );

  if (!assetRes.Item) {
    console.error("Asset not found for chunk task:", assetId);
    return {
      statusCode: 404,
      body: JSON.stringify({ error: "Asset not found" }),
    };
  }

  const asset = assetRes.Item;
  const chunks: ChunkInfo[] = asset.chunks || [];

  // Update the chunk with the videoId
  const chunkToUpdate = chunks.find((c) => c.chunkIndex === chunkIndex);
  if (chunkToUpdate) {
    chunkToUpdate.videoId = videoId;
  } else {
    console.error(`Chunk ${chunkIndex} not found in asset chunks`);
  }

  // Check if all chunks are now complete
  const pendingChunks = chunks.filter((c) => !c.videoId).length;
  const allChunksComplete = pendingChunks === 0;

  console.log(
    `Chunk status: ${chunks.length - pendingChunks}/${chunks.length} complete`
  );

  if (allChunksComplete) {
    // All chunks are indexed - finalize the asset
    console.log(`All chunks complete for asset ${assetId}, finalizing...`);

    let totalDuration = 0;

    const secretVal12Labs = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: SECRET_ARN })
    );
    const apiKey = secretVal12Labs.SecretString;

    let transcriptionUrl: string | null = null;

    if (apiKey) {
      // Calculate total duration from chunks
      totalDuration = chunks.reduce((max, c) => Math.max(max, c.endOffset), 0);

      // Aggregate transcriptions from all chunks
      try {
        const allTranscriptions: any[] = [];

        for (const chunk of chunks.sort(
          (a, b) => a.chunkIndex - b.chunkIndex
        )) {
          if (!chunk.videoId) continue;

          try {
            const url = `https://api.twelvelabs.io/v1.3/indexes/${TWELVE_LABS_INDEX_ID}/videos/${chunk.videoId}`;
            const response = await axios.get(url, {
              headers: { "x-api-key": apiKey },
              params: { transcription: true },
            });

            const transcriptionData = response.data?.transcription;
            if (transcriptionData && Array.isArray(transcriptionData)) {
              // Adjust timestamps to original video timeline
              for (const segment of transcriptionData) {
                allTranscriptions.push({
                  ...segment,
                  start: (segment.start || 0) + chunk.startOffset,
                  end: (segment.end || 0) + chunk.startOffset,
                });
              }
            }
          } catch (err) {
            console.error(
              `Failed to fetch transcription for chunk ${chunk.chunkIndex}:`,
              err
            );
          }
        }

        if (allTranscriptions.length > 0) {
          // Sort by start time
          allTranscriptions.sort((a, b) => a.start - b.start);

          // Remove duplicate segments from overlap regions (chunks overlap by 30s)
          const dedupedTranscriptions: any[] = [];
          for (const segment of allTranscriptions) {
            const last =
              dedupedTranscriptions[dedupedTranscriptions.length - 1];
            // Skip if this segment overlaps significantly with the previous one
            if (last && segment.start < last.end - 1) {
              continue;
            }
            dedupedTranscriptions.push(segment);
          }

          const key = `transcriptions/${assetId}.json`;
          await s3Client.send(
            new PutObjectCommand({
              Bucket: BUCKET_NAME,
              Key: key,
              Body: JSON.stringify(dedupedTranscriptions),
              ContentType: "application/json",
            })
          );
          transcriptionUrl = `s3://${BUCKET_NAME}/${key}`;
          console.log(
            `Aggregated transcription stored at ${transcriptionUrl} (${dedupedTranscriptions.length} segments from ${allTranscriptions.length} raw)`
          );
        }
      } catch (err) {
        console.error("Failed to aggregate transcriptions:", err);
      }
    }

    // Update asset as READY with transcriptionUrl
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { assetId },
        UpdateExpression:
          "SET #s = :status, chunks = :chunks, #dur = :dur, pendingChunks = :pending, transcriptionUrl = :trans, updatedAt = :ua",
        ExpressionAttributeNames: {
          "#s": "status",
          "#dur": "duration",
        },
        ExpressionAttributeValues: {
          ":status": "READY",
          ":chunks": chunks,
          ":dur": totalDuration,
          ":pending": 0,
          ":trans": transcriptionUrl,
          ":ua": new Date().toISOString(),
        },
      })
    );

    console.log(`Asset ${assetId} is now READY`);
  } else {
    // Still waiting for more chunks
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { assetId },
        UpdateExpression:
          "SET chunks = :chunks, pendingChunks = :pending, updatedAt = :ua",
        ExpressionAttributeValues: {
          ":chunks": chunks,
          ":pending": pendingChunks,
          ":ua": new Date().toISOString(),
        },
      })
    );

    console.log(`Asset ${assetId} waiting for ${pendingChunks} more chunk(s)`);
  }

  // Delete the chunk task entry (it's served its purpose)
  if (CHUNK_TASKS_TABLE) {
    try {
      await docClient.send(
        new DeleteCommand({
          TableName: CHUNK_TASKS_TABLE,
          Key: { taskId },
        })
      );
    } catch (err) {
      console.warn("Failed to delete chunk task entry:", err);
    }
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Chunk processed",
      assetId,
      chunkIndex,
      allComplete: pendingChunks === 0,
    }),
  };
}
