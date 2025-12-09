import { APIGatewayProxyHandler } from "aws-lambda";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { checkAuth } from "../utils/auth";

const s3Client = new S3Client({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const BUCKET_NAME = process.env.BUCKET_NAME!;
const TABLE_NAME = process.env.TABLE_NAME!;

export const handler: APIGatewayProxyHandler = async (event) => {
  // 1. Auth Check
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  try {
    // 2. Parse Body
    const body = JSON.parse(event.body || "{}");
    // Extract technical metadata, ignore questionnaire answers
    const { contentType = "video/mp4", extension = "mp4", filename } = body;

    const assetId = randomUUID();
    const key = `raw/${assetId}.${extension}`;

    // 3. Generate Presigned URL
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 3600,
    });

    // 4. Save Initial Asset Record (Simplified)
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          assetId,
          status: "UPLOADING",
          key,
          contentType,
          format: extension.toUpperCase(), // Store format (MP4, MOV, etc.)
          originalName: filename || "Untitled",
          // Removed metadata field containing questionnaire answers
          createdAt: new Date().toISOString(),
          segmentCount: 0,
        },
      })
    );

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        uploadUrl,
        assetId,
        key,
      }),
    };
  } catch (error) {
    console.error("Error generating upload URL:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Failed to generate upload URL" }),
    };
  }
};
