import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { checkAuth } from "../utils/auth";
import { presignS3Uri } from "../utils/s3";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.TABLE_NAME!;

export const handler: APIGatewayProxyHandler = async (event) => {
  // Auth Check
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
      })
    );

    const items = result.Items || [];

    // Sort by createdAt desc
    items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

    // Generate presigned URLs for all items
    // Note: In a production app with many items, this might be slow and should be paginated or URLs generated on demand (like getAsset).
    // For this MVP, we'll map over them.
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
