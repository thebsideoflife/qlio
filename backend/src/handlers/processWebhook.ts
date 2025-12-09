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
import { randomUUID, createHmac } from "crypto";
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
const SECRET_ARN = process.env.SECRET_ARN!;
const SIGNING_SECRET_ARN = process.env.SIGNING_SECRET_ARN!;
const TWELVE_LABS_INDEX_ID = process.env.TWELVE_LABS_INDEX_ID!;
const BUCKET_NAME = process.env.BUCKET_NAME!;

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

    // 2. Find Asset by Task ID
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
    let videoId = body.data?.video_id || asset.twelveLabsVideoId;

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

      // A. Get Thumbnail (Use correct method client.indexes.videos.retrieve)
      try {
        const video = await client.indexes.videos.retrieve(
          TWELVE_LABS_INDEX_ID,
          videoId
        );

        // Safely access duration without 'as any' if possible, or use a typed helper
        // The type definition in the library seems to be `Video` which has `metadata`.
        // If the linter/compiler complains, we can perform a safe check.
        if ("metadata" in video && (video as any).metadata?.duration) {
          videoDuration = (video as any).metadata.duration;
        }

        console.log("12Labs video response:", JSON.stringify(video, null, 2));

        // Try multiple possible paths for thumbnail
        // Based on log analysis, structure is hls.thumbnailUrls (array)
        const externalThumbnailUrl =
          (video as any).thumbnailUrl ||
          (video as any).thumbnail_url ||
          (video as any).hls?.thumbnailUrls?.[0] ||
          (video as any).hls?.thumbnail_urls?.[0] ||
          (video as any).metadata?.thumbnail_url;

        // Persist thumbnail to S3
        if (externalThumbnailUrl) {
          console.log(`Downloading thumbnail from ${externalThumbnailUrl}...`);
          const thumbResponse = await axios.get(externalThumbnailUrl, {
            responseType: "arraybuffer",
          });
          const thumbKey = `thumbnails/${assetId}.jpg`;

          await s3Client.send(
            new PutObjectCommand({
              Bucket: BUCKET_NAME,
              Key: thumbKey,
              Body: thumbResponse.data,
              ContentType: "image/jpeg",
            })
          );

          // Store as S3 URI, not public URL
          thumbnailUrl = `s3://${BUCKET_NAME}/${thumbKey}`;
          console.log(`Thumbnail stored at ${thumbnailUrl}`);
        } else {
          console.warn("No thumbnail URL found in 12Labs response");
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
        // The transcription is in data.transcription
        const transcriptionData = data.transcription;

        if (transcriptionData && Array.isArray(transcriptionData)) {
          // Store in S3
          const key = `transcriptions/${assetId}.json`;
          await s3Client.send(
            new PutObjectCommand({
              Bucket: BUCKET_NAME,
              Key: key,
              Body: JSON.stringify(transcriptionData),
              ContentType: "application/json",
            })
          );

          // Store as S3 URI, not public URL
          transcriptionUrl = `s3://${BUCKET_NAME}/${key}`;
          console.log("Transcription stored at", transcriptionUrl);
        } else {
          console.warn("No transcription data found in response", data);
        }
      } catch (err) {
        console.error("Failed to fetch/store transcription", err);
      }
    }

    // 3. Update DynamoDB
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { assetId },
        UpdateExpression:
          "set #s = :status, twelveLabsVideoId = :vid, thumbnailUrl = :thumb, transcriptionUrl = :trans, duration = :dur, updatedAt = :ua",
        ExpressionAttributeNames: {
          "#s": "status",
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
  } catch (error) {
    console.error("Error processing webhook:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal Server Error" }),
    };
  }
};
