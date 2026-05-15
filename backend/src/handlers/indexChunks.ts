import { Handler } from "aws-lambda";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
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
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const secretsClient = new SecretsManagerClient({});

const TABLE_NAME = process.env.TABLE_NAME!;
const CHUNK_TASKS_TABLE = process.env.CHUNK_TASKS_TABLE!;
const BUCKET_NAME = process.env.BUCKET_NAME!;
const SECRET_ARN = process.env.SECRET_ARN!;
const TWELVE_LABS_INDEX_ID = process.env.TWELVE_LABS_INDEX_ID!;

interface ChunkInfo {
  chunkIndex: number;
  s3Key: string;
  startOffset: number;
  endOffset: number;
  duration: number;
  taskId?: string;
  videoId?: string;
}

export interface IndexChunksEvent {
  assetId: string;
}

export interface IndexChunksResult {
  assetId: string;
  chunksIndexed: number;
  taskIds: string[];
}

/**
 * Lambda handler to start indexing all chunks of a split video.
 * This is invoked after splitVideo completes.
 */
export const handler: Handler<IndexChunksEvent, IndexChunksResult> = async (
  event,
) => {
  const { assetId } = event;

  console.log(`Starting chunk indexing for asset ${assetId}`);

  // Get asset with chunk info
  const assetRes = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { assetId },
    }),
  );

  if (!assetRes.Item) {
    throw new Error(`Asset not found: ${assetId}`);
  }

  const asset = assetRes.Item;
  const chunks: ChunkInfo[] = asset.chunks || [];
  const originalName = asset.originalName || "Untitled";
  // Remove extension from original name for cleaner chunk naming
  const baseName = originalName.replace(/\.[^/.]+$/, "");

  if (chunks.length === 0) {
    throw new Error(`No chunks found for asset: ${assetId}`);
  }

  // Get 12Labs API Key
  const secretVal = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: SECRET_ARN }),
  );
  const apiKey = secretVal.SecretString;
  if (!apiKey) throw new Error("12Labs API Key not found");

  // Use the SDK exactly like startIndexing does
  const client = new TwelveLabs({ apiKey });
  const taskIds: string[] = [];

  // Index each chunk
  for (const chunk of chunks) {
    console.log(`Indexing chunk ${chunk.chunkIndex} (${chunk.s3Key})...`);

    // Generate presigned URL for 12Labs
    const signedUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: chunk.s3Key,
      }),
      { expiresIn: 3600 },
    );

    // Create indexing task - same approach as startIndexing
    console.log(`Calling 12labs SDK for chunk ${chunk.chunkIndex}...`);

    const task = await client.tasks.create({
      indexId: TWELVE_LABS_INDEX_ID,
      videoUrl: signedUrl,
    });

    const taskId = task.id;
    if (!taskId) {
      throw new Error(`Failed to create task for chunk ${chunk.chunkIndex}`);
    }

    console.log(`Created task ${taskId} for chunk ${chunk.chunkIndex}`);

    // Update chunk with taskId
    chunk.taskId = taskId;
    taskIds.push(taskId);

    // Write to chunk_tasks lookup table for webhook handling
    // TTL set to 7 days from now (indexing should complete within hours)
    const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
    await docClient.send(
      new PutCommand({
        TableName: CHUNK_TASKS_TABLE,
        Item: {
          taskId,
          assetId,
          chunkIndex: chunk.chunkIndex,
          startOffset: chunk.startOffset,
          endOffset: chunk.endOffset,
          createdAt: new Date().toISOString(),
          expiresAt,
        },
      }),
    );
  }

  // Calculate how many chunks need to complete before asset is ready
  const pendingChunks = chunks.length;

  // Update asset with all task IDs and pending count
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { assetId },
      UpdateExpression:
        "SET #status = :status, chunks = :chunks, twelveLabsIndexId = :iid, pendingChunks = :pending, updatedAt = :updatedAt",
      ExpressionAttributeNames: {
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":status": "INDEXING",
        ":chunks": chunks,
        ":iid": TWELVE_LABS_INDEX_ID,
        ":pending": pendingChunks,
        ":updatedAt": new Date().toISOString(),
      },
    }),
  );

  console.log(`Started indexing ${chunks.length} chunks for asset ${assetId}`);

  return {
    assetId,
    chunksIndexed: chunks.length,
    taskIds,
  };
};
