import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
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

    const body = JSON.parse(event.body || "{}") as Record<string, unknown>;

    // `title` is the asset's display name and lives at the top level, where
    // listAssetsStatus reads it. Other keys merge into `metadata` one by one
    // so a rename never wipes stored metadata.
    const sets = ["updatedAt = :u"];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = { ":u": new Date().toISOString() };

    let title: string | undefined;
    if (typeof body.title === "string") {
      title = body.title.trim();
      if (!title) {
        return {
          statusCode: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
          body: JSON.stringify({ error: "Title cannot be empty" }),
        };
      }
      sets.push("#title = :t");
      names["#title"] = "title";
      values[":t"] = title;
    }

    const metaEntries = Object.entries(body).filter(([key]) => key !== "title");
    if (metaEntries.length > 0) {
      const existing = await docClient.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: { assetId },
          ProjectionExpression: "#meta",
          ExpressionAttributeNames: { "#meta": "metadata" },
        }),
      );
      const current = existing.Item?.metadata;
      sets.push("#meta = :m");
      names["#meta"] = "metadata";
      values[":m"] = {
        ...(current && typeof current === "object" ? current : {}),
        ...Object.fromEntries(metaEntries),
      };
    }

    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { assetId },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ConditionExpression: "attribute_exists(assetId)",
        ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
        ExpressionAttributeValues: values,
      }),
    );

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ success: true, ...(title ? { title } : {}) }),
    };
  } catch (error) {
    if ((error as { name?: string })?.name === "ConditionalCheckFailedException") {
      return {
        statusCode: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ error: "Asset not found" }),
      };
    }
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

