import { APIGatewayProxyHandler } from "aws-lambda";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";
import { checkAuth, getAuthenticatedUserId } from "../utils/auth";

const stsClient = new STSClient({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const BUCKET_NAME = process.env.BUCKET_NAME!;
const TABLE_NAME = process.env.TABLE_NAME!;
const UPLOAD_ROLE_ARN = process.env.UPLOAD_ROLE_ARN!;

export const handler: APIGatewayProxyHandler = async (event) => {
  // 1. Auth Check
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  const userId = await getAuthenticatedUserId(event);

  try {
    // 2. Parse Body
    const body = JSON.parse(event.body || "{}");
    const {
      contentType = "video/mp4",
      extension = "mp4",
      filename,
      duration,
    } = body;

    const assetId = randomUUID();
    const key = `raw/${assetId}.${extension}`;

    // 3. Generate Temporary Credentials scoped to this specific key
    const assumeRoleCommand = new AssumeRoleCommand({
      RoleArn: UPLOAD_ROLE_ARN,
      RoleSessionName: `upload-${assetId}`,
      DurationSeconds: 3600, // 1 hour
      Policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["s3:PutObject", "s3:AbortMultipartUpload"],
            Resource: `arn:aws:s3:::${BUCKET_NAME}/${key}`,
          },
        ],
      }),
    });

    const assumeRoleResponse = await stsClient.send(assumeRoleCommand);
    const credentials = assumeRoleResponse.Credentials;

    if (!credentials) {
      throw new Error("Failed to assume role");
    }

    // 4. Save Initial Asset Record
    const item: any = {
      assetId,
      status: "UPLOADING",
      key,
      contentType,
      format: extension.toUpperCase(),
      originalName: filename || "Untitled",
      createdAt: new Date().toISOString(),
      segmentCount: 0,
      ...(userId && { userId }),
    };

    if (typeof duration === "number") {
      item.duration = duration;
    }

    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
      })
    );

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        assetId,
        key,
        bucket: BUCKET_NAME,
        region: process.env.AWS_REGION || "us-west-2",
        credentials: {
          accessKeyId: credentials.AccessKeyId,
          secretAccessKey: credentials.SecretAccessKey,
          sessionToken: credentials.SessionToken,
          expiration: credentials.Expiration?.toISOString(),
        },
      }),
    };
  } catch (error) {
    console.error("Error generating upload credentials:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Failed to generate upload credentials" }),
    };
  }
};
