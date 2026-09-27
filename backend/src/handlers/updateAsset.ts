import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { checkAuth } from "../utils/auth";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const TABLE_NAME = process.env.TABLE_NAME!;

export const handler: APIGatewayProxyHandler = async (event) => {
  // 1. Auth Check
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  try {
    const assetId = event.pathParameters?.assetId;
    if (!assetId) {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ error: "Missing assetId" }),
      };
    }

    // The display name lives in the top-level `title`, which listAssetsStatus
    // reads. (It used to be written into `metadata`, so renames reverted.)
    const { title } = JSON.parse(event.body || "{}");
    if (typeof title !== "string" || !title.trim()) {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ error: "A non-empty title is required" }),
      };
    }

    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { assetId },
        UpdateExpression: "SET #title = :t, updatedAt = :u",
        ConditionExpression: "attribute_exists(assetId)",
        ExpressionAttributeNames: { "#title": "title" },
        ExpressionAttributeValues: {
          ":t": title.trim(),
          ":u": new Date().toISOString(),
        },
      }),
    );

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ success: true }),
    };
  } catch (error) {
    console.error("Error updating asset:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Failed to update asset" }),
    };
  }
};

