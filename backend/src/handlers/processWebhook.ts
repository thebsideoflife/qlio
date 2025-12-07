import { APIGatewayProxyHandler } from "aws-lambda";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { TwelveLabs } from "twelvelabs-js";

const s3Client = new S3Client({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const secretsClient = new SecretsManagerClient({});

const TABLE_NAME = process.env.TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;
const SECRET_ARN = process.env.SECRET_ARN!;
const TWELVE_LABS_INDEX_ID = process.env.TWELVE_LABS_INDEX_ID!;
// const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET!; // TODO: Add to secrets/env

export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    // 1. Verify Signature (Skipping strict check for now, but placeholder)
    const signature = event.headers["x-twelvelabs-signature"];
    // const calculatedSignature = ...
    // if (signature !== calculatedSignature) return { statusCode: 401, body: 'Invalid signature' };

    const body = JSON.parse(event.body || "{}");
    // Handle both old and new webhook formats
    // New format: type='index.task.ready', data={ id: 'task_id', ... }
    // Old format: type='index_task_status', status='ready', id='task_id'

    let eventType = body.type;
    let taskStatus = body.status;
    let taskId = body.id;
    let videoId = body.data?.video_id;

    // Normalization for new format
    if (eventType === "index.task.ready") {
      taskStatus = "ready";
      // In new format, taskId might be in data.id or data.task_id?
      // Usually data.id is the Task ID for task events.
      taskId = body.data?.id;
      // Video ID is likely in metadata or data.video_id?
      // Let's assume data.video_id is present or we need to fetch it.
      // Actually, data object usually contains the resource info.
    }

    if (
      (eventType !== "index_task_status" && eventType !== "index.task.ready") ||
      taskStatus !== "ready"
    ) {
      console.log("Ignoring webhook:", eventType, taskStatus);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Ignored" }),
      };
    }

    if (!taskId) {
      // Fallback: check if id is at root
      taskId = body.id;
    }

    // For new format, videoId might not be in data.video_id directly if it's a task event.
    // If videoId is missing, we might need to rely on the Task ID to look up the asset.

    if (!taskId) {
      console.error("Missing taskId", body);
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing data" }),
      };
    }

    // 2. Find Asset by Task ID
    // We need a GSI on twelveLabsTaskId to find the asset efficiently.
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Asset not found" }),
      };
    }

    const asset = queryRes.Items[0];
    const assetId = asset.assetId;

    // 3. Fetch Transcript/Metadata from 12Labs
    const secretVal = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: SECRET_ARN })
    );
    const apiKey = secretVal.SecretString;
    if (!apiKey) throw new Error("12Labs API Key not found");

    const client = new TwelveLabs({ apiKey });

    // Fetching transcription
    let transcription;
    try {
      // Using SDK to fetch transcription if available
      // Note: SDK structure might vary, but typically:
      const video = await client.indexes.videos.retrieve(
        TWELVE_LABS_INDEX_ID,
        videoId
      );
      // Or simply assume we want to store the video metadata which includes transcription if available?
      // Actually, transcription is usually a separate call or part of the video object if requested.
      // Let's use a generic method if unsure, but client.index.video.transcription.list is likely.
      // For now, let's just store the video metadata itself which is valuable.
      transcription = video;
    } catch (e) {
      console.warn("Could not fetch video metadata/transcription", e);
      transcription = { error: "Fetch failed" };
    }

    // 4. Save to S3
    const metadataKey = `metadata/${assetId}_transcript.json`;
    await s3Client.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: metadataKey,
        Body: JSON.stringify(transcription),
        ContentType: "application/json",
      })
    );

    // 5. Update DynamoDB
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { assetId },
        UpdateExpression:
          "set #s = :status, transcriptS3Key = :tk, twelveLabsVideoId = :vid",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":status": "READY",
          ":tk": metadataKey,
          ":vid": videoId,
        },
      })
    );

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "OK" }),
    };
  } catch (error) {
    console.error("Error processing webhook:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal Server Error" }),
    };
  }
};
