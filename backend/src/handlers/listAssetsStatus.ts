import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { checkAuth, getAuthenticatedUserId } from "../utils/auth";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.TABLE_NAME!;

/**
 * Slim asset status endpoint for polling.
 * Returns only id, status, title, createdAt - NO presigned URLs.
 * Use GET /assets/:id when you need the full asset with video URL.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  const userId = await getAuthenticatedUserId(event);

  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: "userId = :uid",
        ExpressionAttributeValues: { ":uid": userId },
        // Only fetch the fields we need
        ProjectionExpression: "assetId, #s, title, originalName, createdAt, updatedAt, #f",
        ExpressionAttributeNames: {
          "#s": "status",
          "#f": "format",
        },
      })
    );

    const items = result.Items || [];

    // Sort by createdAt desc
    items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

    // Transform to slim response
    const slimAssets = items.map((item) => ({
      id: item.assetId,
      status: item.status,
      title: item.title || item.originalName || "Untitled",
      format: item.format,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(slimAssets),
    };
  } catch (error) {
    console.error("Error listing asset statuses:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Failed to list asset statuses" }),
    };
  }
};
