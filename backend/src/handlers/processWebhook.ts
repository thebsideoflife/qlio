import { APIGatewayProxyHandler } from "aws-lambda";
import { S3Client } from "@aws-sdk/client-s3";
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
      // If we have a secret configured but no signature header, reject
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

    // NOTE: Automatic clip generation removed. We wait for user to create a project with specific metadata.
    // The webhook now only updates the status to READY.

    // 3. Update DynamoDB
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { assetId },
        UpdateExpression:
          "set #s = :status, twelveLabsVideoId = :vid, updatedAt = :ua",
        ExpressionAttributeNames: {
          "#s": "status",
        },
        ExpressionAttributeValues: {
          ":status": "READY",
          ":vid": videoId || "unknown",
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
