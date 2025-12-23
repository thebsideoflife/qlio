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
    return await handleSingleVideoCompletion(assetId, videoId || asset.twelveLabsVideoId);
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
  // Fetch 12 Labs API Key to get thumbnail AND transcription
  const secretVal12Labs = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: SECRET_ARN })
  );
  const apiKey = secretVal12Labs.SecretString;
  let thumbnailUrl = null;
  let transcriptionUrl = null;
  let videoDuration = 0;

  if (apiKey && videoId && videoId !== "unknown") {
    const client = new TwelveLabs({ apiKey });

    // A. Get Thumbnail
    try {
      const video = await client.indexes.videos.retrieve(
        TWELVE_LABS_INDEX_ID,
        videoId
      );

      // Safely access duration
      if ("metadata" in video && (video as any).metadata?.duration) {
        videoDuration = (video as any).metadata.duration;
      }

      console.log("12Labs video response:", JSON.stringify(video, null, 2));

      // Determine timestamp for thumbnail (avoid black start frame)
      let thumbTime = 0;
      if (videoDuration > 10) {
        thumbTime = 5;
      } else if (videoDuration > 0) {
        thumbTime = videoDuration / 2;
      }

      // Fetch thumbnail directly from API to control timestamp
      console.log(`Fetching thumbnail at ${thumbTime}s...`);
      const thumbUrl = `https://api.twelvelabs.io/v1.2/indexes/${TWELVE_LABS_INDEX_ID}/videos/${videoId}/thumbnail`;

      let thumbResponse;
      try {
        thumbResponse = await axios.get(thumbUrl, {
          headers: { "x-api-key": apiKey },
          params: { time: thumbTime },
          responseType: "arraybuffer",
        });
      } catch (e) {
        console.warn(
          "Failed to fetch custom thumbnail, falling back to default URL"
        );
        const externalThumbnailUrl =
          (video as any).thumbnailUrl ||
          (video as any).thumbnail_url ||
          (video as any).hls?.thumbnailUrls?.[0] ||
          (video as any).hls?.thumbnail_urls?.[0] ||
          (video as any).metadata?.thumbnail_url;

        if (externalThumbnailUrl) {
          thumbResponse = await axios.get(externalThumbnailUrl, {
            responseType: "arraybuffer",
          });
        }
      }

      if (thumbResponse && thumbResponse.data) {
        const thumbKey = `thumbnails/${assetId}.jpg`;

        await s3Client.send(
          new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: thumbKey,
            Body: thumbResponse.data,
            ContentType: "image/jpeg",
          })
        );

        thumbnailUrl = `s3://${BUCKET_NAME}/${thumbKey}`;
        console.log(`Thumbnail stored at ${thumbnailUrl}`);
      } else {
        console.warn("No thumbnail could be retrieved.");
      }
    } catch (err) {
      console.error("Failed to fetch/store thumbnail from 12 Labs", err);
    }

    // B. Get Transcription & Store in S3
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
        "SET #s = :status, twelveLabsVideoId = :vid, thumbnailUrl = :thumb, transcriptionUrl = :trans, #dur = :dur, updatedAt = :ua",
      ExpressionAttributeNames: {
        "#s": "status",
        "#dur": "duration",
      },
      ExpressionAttributeValues: {
        ":status": "READY",
        ":vid": videoId || "unknown",
        ":thumb": thumbnailUrl,
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

    // Get thumbnail from first chunk
    let thumbnailUrl = null;
    let totalDuration = 0;

    const secretVal12Labs = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: SECRET_ARN })
    );
    const apiKey = secretVal12Labs.SecretString;

    if (apiKey) {
      const client = new TwelveLabs({ apiKey });

      // Get thumbnail from first chunk
      const firstChunk = chunks.find((c) => c.chunkIndex === 0);
      if (firstChunk?.videoId) {
        try {
          const video = await client.indexes.videos.retrieve(
            TWELVE_LABS_INDEX_ID,
            firstChunk.videoId
          );

          let thumbTime = 5;
          const thumbUrl = `https://api.twelvelabs.io/v1.2/indexes/${TWELVE_LABS_INDEX_ID}/videos/${firstChunk.videoId}/thumbnail`;

          const thumbResponse = await axios.get(thumbUrl, {
            headers: { "x-api-key": apiKey },
            params: { time: thumbTime },
            responseType: "arraybuffer",
          });

          if (thumbResponse.data) {
            const thumbKey = `thumbnails/${assetId}.jpg`;
            await s3Client.send(
              new PutObjectCommand({
                Bucket: BUCKET_NAME,
                Key: thumbKey,
                Body: thumbResponse.data,
                ContentType: "image/jpeg",
              })
            );
            thumbnailUrl = `s3://${BUCKET_NAME}/${thumbKey}`;
            console.log(`Thumbnail stored at ${thumbnailUrl}`);
          }
        } catch (err) {
          console.error("Failed to fetch thumbnail from first chunk:", err);
        }
      }

      // Calculate total duration from chunks
      totalDuration = chunks.reduce(
        (max, c) => Math.max(max, c.endOffset),
        0
      );

      // Aggregate transcriptions from all chunks
      try {
        const allTranscriptions: any[] = [];

        for (const chunk of chunks.sort((a, b) => a.chunkIndex - b.chunkIndex)) {
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
          // Sort by start time and dedupe overlaps
          allTranscriptions.sort((a, b) => a.start - b.start);

          const key = `transcriptions/${assetId}.json`;
          await s3Client.send(
            new PutObjectCommand({
              Bucket: BUCKET_NAME,
              Key: key,
              Body: JSON.stringify(allTranscriptions),
              ContentType: "application/json",
            })
          );
          console.log(`Aggregated transcription stored at s3://${BUCKET_NAME}/${key}`);
        }
      } catch (err) {
        console.error("Failed to aggregate transcriptions:", err);
      }
    }

    // Update asset as READY
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { assetId },
        UpdateExpression:
          "SET #s = :status, chunks = :chunks, thumbnailUrl = :thumb, #dur = :dur, pendingChunks = :pending, updatedAt = :ua",
        ExpressionAttributeNames: {
          "#s": "status",
          "#dur": "duration",
        },
        ExpressionAttributeValues: {
          ":status": "READY",
          ":chunks": chunks,
          ":thumb": thumbnailUrl,
          ":dur": totalDuration,
          ":pending": 0,
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

    console.log(
      `Asset ${assetId} waiting for ${pendingChunks} more chunk(s)`
    );
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
