import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { checkAuth } from "../utils/auth";
import { normalizeShowInfo } from "../services/show-info";

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
    // `showInfo` (series, season, episode…) feeds AEO metadata; either field
    // may be sent alone.
    const body = JSON.parse(event.body || "{}") as {
      title?: unknown;
      showInfo?: unknown;
    };
    const hasTitle = body.title !== undefined;
    const hasShowInfo = body.showInfo !== undefined;
    if (
      (!hasTitle && !hasShowInfo) ||
      (hasTitle && (typeof body.title !== "string" || !body.title.trim())) ||
      (hasShowInfo &&
        (body.showInfo === null || typeof body.showInfo !== "object"))
    ) {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({
          error: "Send a non-empty title, a showInfo object, or both",
        }),
      };
    }

    const sets = ["updatedAt = :u"];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = { ":u": new Date().toISOString() };
    if (hasTitle) {
      sets.push("#title = :t");
      names["#title"] = "title";
      values[":t"] = (body.title as string).trim();
    }
    const showInfo = hasShowInfo ? normalizeShowInfo(body.showInfo) : undefined;
    if (showInfo) {
      sets.push("showInfo = :s");
      values[":s"] = showInfo;
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
      body: JSON.stringify({ success: true, ...(showInfo ? { showInfo } : {}) }),
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

