import { S3Event, Handler } from "aws-lambda";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { TwelveLabs } from "twelvelabs-js";

const s3Client = new S3Client({});
const lambdaClient = new LambdaClient({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const secretsClient = new SecretsManagerClient({});

const TABLE_NAME = process.env.TABLE_NAME!;
const CHUNK_TASKS_TABLE = process.env.CHUNK_TASKS_TABLE;
const SECRET_ARN = process.env.SECRET_ARN!;
const TWELVE_LABS_INDEX_ID = process.env.TWELVE_LABS_INDEX_ID!;
const SPLIT_FUNCTION_NAME = process.env.SPLIT_FUNCTION_NAME;
const TRANSCRIBE_FUNCTION_NAME = process.env.TRANSCRIBE_FUNCTION_NAME;

// 12labs max video duration is 60 minutes (3600 seconds)
// Only split if video exceeds 60 minutes (splitting adds complexity)
const MAX_SINGLE_VIDEO_DURATION = 60 * 60;

interface ChunkInfo {
  chunkIndex: number;
  s3Key: string;
  startOffset: number;
  endOffset: number;
  duration: number;
  taskId?: string;
  videoId?: string;
}

async function invokeWhisperTranscribe(
  assetId: string,
  bucket: string,
  key: string,
): Promise<void> {
  if (!TRANSCRIBE_FUNCTION_NAME) {
    console.warn("TRANSCRIBE_FUNCTION_NAME is not set; skipping Whisper");
    return;
  }
  try {
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { assetId },
          UpdateExpression:
            "SET transcriptionStatus = :pending, updatedAt = :updatedAt",
          ConditionExpression:
            "attribute_not_exists(transcriptionStatus) OR transcriptionStatus = :failed",
          ExpressionAttributeValues: {
            ":pending": "pending",
            ":failed": "failed",
            ":updatedAt": new Date().toISOString(),
          },
        }),
      );
    } catch (err) {
      if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
        console.log(`Whisper transcription already started for asset ${assetId}`);
        return;
      }
      throw err;
    }
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: TRANSCRIBE_FUNCTION_NAME,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ assetId, bucket, key })),
      }),
    );
    console.log(`Invoked Whisper transcribe for asset ${assetId}`);
  } catch (err) {
    console.error(`Failed to invoke Whisper transcribe for ${assetId}:`, err);
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { assetId },
          UpdateExpression: "SET transcriptionStatus = :ts, updatedAt = :ua",
          ExpressionAttributeValues: {
            ":ts": "failed",
            ":ua": new Date().toISOString(),
          },
        }),
      );
    } catch (statusErr) {
      console.error(`Failed to mark transcription failed for ${assetId}:`, statusErr);
    }
  }
}

/**
 * Index a single video (or chunk) to 12labs
 */
async function indexVideo(
  client: TwelveLabs,
  bucket: string,
  key: string,
  assetId: string,
  chunkIndex?: number,
): Promise<string> {
  // Generate presigned URL for 12Labs to download
  const signedUrl = await getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
    { expiresIn: 3600 },
  );

  const logPrefix = chunkIndex !== undefined ? `chunk ${chunkIndex} of ` : "";
  console.log(`Starting indexing for ${logPrefix}${assetId}...`);

  const task = await client.tasks.create({
    indexId: TWELVE_LABS_INDEX_ID,
    videoUrl: signedUrl,
  });

  console.log(`Created task ${task.id} for ${logPrefix}${assetId}`);
  return task.id!;
}

export const handler: Handler<S3Event> = async (event) => {
  try {
    // Start Whisper first. Transcription must not depend on TwelveLabs
    // credentials or task creation succeeding.
    for (const record of event.Records) {
      const bucket = record.s3.bucket.name;
      const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
      if (!key.startsWith("chunks/")) {
        const assetId = key.split("/")[1]?.split(".")[0];
        if (assetId) await invokeWhisperTranscribe(assetId, bucket, key);
      }
    }

    // TwelveLabs indexing is a separate best-effort pipeline.
    const secretVal = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: SECRET_ARN }),
    );
    const apiKey = secretVal.SecretString;
    if (!apiKey) throw new Error("12Labs API Key not found");

    const client = new TwelveLabs({ apiKey });

    for (const record of event.Records) {
      const bucket = record.s3.bucket.name;
      const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

      // Check if this is a chunk upload (chunks/{assetId}/chunk-N.mp4)
      // or a raw video upload (raw/{assetId}.mp4)
      const isChunk = key.startsWith("chunks/");

      if (isChunk) {
        // Handle chunk indexing
        await handleChunkIndexing(client, bucket, key);
      } else {
        // Handle raw video upload
        await handleRawVideoUpload(client, bucket, key);
      }
    }
  } catch (error: any) {
    console.error("Error in start-indexing:", error);
    throw error;
  }
};

/**
 * Handle indexing of a chunk file
 * Path format: chunks/{assetId}/{assetId}-chunk-{N}.mp4
 */
async function handleChunkIndexing(
  client: TwelveLabs,
  bucket: string,
  key: string,
): Promise<void> {
  // Parse assetId and chunkIndex from key
  // Format: chunks/{assetId}/{assetId}-chunk-{N}.mp4
  const match = key.match(/^chunks\/([^/]+)\/[^/]+-chunk-(\d+)\.mp4$/);
  if (!match) {
    console.error("Could not parse chunk key:", key);
    return;
  }

  const assetId = match[1];
  const chunkIndex = parseInt(match[2], 10);

  console.log(`Indexing chunk ${chunkIndex} for asset ${assetId}`);

  // Get current asset to find chunk info
  const assetRes = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { assetId },
    }),
  );

  if (!assetRes.Item) {
    console.error("Asset not found:", assetId);
    return;
  }

  const asset = assetRes.Item;
  const chunks: ChunkInfo[] = asset.chunks || [];

  // Find the chunk entry
  const chunkEntry = chunks.find((c) => c.chunkIndex === chunkIndex);
  if (!chunkEntry) {
    console.error(`Chunk ${chunkIndex} not found in asset chunks`);
    return;
  }

  // Index the chunk - 12labs will use the S3 key as filename (unique per asset)
  const taskId = await indexVideo(client, bucket, key, assetId, chunkIndex);

  // Update the chunk with taskId
  chunkEntry.taskId = taskId;

  // Save task to chunk_tasks table so webhook can find it
  if (CHUNK_TASKS_TABLE) {
    await docClient.send(
      new PutCommand({
        TableName: CHUNK_TASKS_TABLE,
        Item: {
          taskId,
          assetId,
          chunkIndex,
          createdAt: new Date().toISOString(),
          // TTL: expire after 7 days (in case webhook never fires)
          expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
        },
      }),
    );
    console.log(`Saved chunk task ${taskId} to chunk_tasks table`);
  }

  // Update DynamoDB with the new chunk info
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { assetId },
      UpdateExpression:
        "SET chunks = :chunks, twelveLabsIndexId = :iid, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":chunks": chunks,
        ":iid": TWELVE_LABS_INDEX_ID,
        ":updatedAt": new Date().toISOString(),
      },
    }),
  );

  console.log(
    `Started indexing task ${taskId} for chunk ${chunkIndex} of asset ${assetId}`,
  );
}

/**
 * Handle raw video upload - check duration and split if needed
 */
async function handleRawVideoUpload(
  client: TwelveLabs,
  bucket: string,
  key: string,
): Promise<void> {
  // Parse assetId from key "raw/assetId.mp4"
  const assetId = key.split("/")[1]?.split(".")[0];
  if (!assetId) {
    console.error("Could not parse assetId from key:", key);
    return;
  }

  // Get asset to check duration
  const assetRes = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { assetId },
    }),
  );

  const asset = assetRes.Item;
  const duration = asset?.duration || 0;

  console.log(
    `Asset ${assetId} duration: ${duration}s (max single: ${MAX_SINGLE_VIDEO_DURATION}s)`,
  );

  // Check if video needs splitting
  if (duration > MAX_SINGLE_VIDEO_DURATION && SPLIT_FUNCTION_NAME) {
    console.log(`Video exceeds max duration, invoking split function...`);

    // Invoke the split Lambda
    const splitPayload = {
      assetId,
      s3Key: key,
      bucket,
      duration,
    };

    const invokeResult = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: SPLIT_FUNCTION_NAME,
        InvocationType: "Event", // Async invocation
        Payload: Buffer.from(JSON.stringify(splitPayload)),
      }),
    );

    console.log(`Split function invoked, status: ${invokeResult.StatusCode}`);

    // Update status to indicate splitting is in progress
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { assetId },
        UpdateExpression:
          "SET #status = :status, s3VideoUrl = :url, updatedAt = :updatedAt",
        ExpressionAttributeNames: {
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":status": "SPLITTING",
          ":url": `s3://${bucket}/${key}`,
          ":updatedAt": new Date().toISOString(),
        },
      }),
    );

    return;
  }

  // Standard flow: index directly
  const taskId = await indexVideo(client, bucket, key, assetId);

  // Update DynamoDB
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { assetId },
      UpdateExpression:
        "SET #status = :status, s3VideoUrl = :url, twelveLabsIndexId = :iid, twelveLabsTaskId = :tid, isChunked = :isChunked, updatedAt = :updatedAt",
      ExpressionAttributeNames: {
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":status": "INDEXING",
        ":url": `s3://${bucket}/${key}`,
        ":iid": TWELVE_LABS_INDEX_ID,
        ":tid": taskId,
        ":isChunked": false,
        ":updatedAt": new Date().toISOString(),
      },
    }),
  );

  console.log(`Started indexing task ${taskId} for asset ${assetId}`);
}
