import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "crypto";
import { checkAuth, getAuthenticatedUserId } from "../utils/auth";
import { presignS3Uri } from "../utils/s3";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.TABLE_NAME!;

export const handler: APIGatewayProxyHandler = async (event) => {
  // Auth Check
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  const userId = await getAuthenticatedUserId(event);

  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'userId = :uid',
        ExpressionAttributeValues: { ':uid': userId },
      })
    );

    const items = result.Items || [];

    // Sort by createdAt desc
    items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

    // Compute ETag from item IDs + statuses + updatedAt (lightweight fingerprint)
    const fingerprint = items
      .map((i) => `${i.assetId}:${i.status}:${i.updatedAt || i.createdAt}`)
      .join("|");
    const etag = `"${createHash("md5").update(fingerprint).digest("hex")}"`;

    // If client sent If-None-Match and it matches, return 304
    const clientEtag = event.headers?.["If-None-Match"] || event.headers?.["if-none-match"];
    if (clientEtag === etag) {
      return {
        statusCode: 304,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "ETag": etag,
        },
        body: "",
      };
    }

    // Generate presigned URLs for all items
    const itemsWithUrls = await Promise.all(
      items.map(async (item) => {
        const result: any = { ...item, id: item.assetId };

        // Presign video URL
        if (item.s3VideoUrl) {
          const presignedUrl = await presignS3Uri(item.s3VideoUrl);
          if (presignedUrl) result.videoUrl = presignedUrl;
        }

        return result;
      })
    );

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "ETag": etag,
      },
      body: JSON.stringify(itemsWithUrls),
    };
  } catch (error) {
    console.error("Error listing assets:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Failed to list assets" }),
    };
  }
};
