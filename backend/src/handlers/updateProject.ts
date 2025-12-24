import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { checkAuth } from "../utils/auth";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;

export const handler: APIGatewayProxyHandler = async (event) => {
  // 1. Auth Check
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  try {
    const projectId = event.pathParameters?.projectId;
    if (!projectId) {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ error: "Missing projectId" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const { title, segments, captionSettings, globalFraming } = body;

    // Check if any updateable fields are provided
    if (!title && !segments && !captionSettings && !globalFraming) {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ error: "No updateable fields provided" }),
      };
    }

    // Build dynamic update expression
    // Note: 'segments' is a DynamoDB reserved keyword, so we must use ExpressionAttributeNames
    const updateParts: string[] = ["#updatedAt = :u"];
    const exprNames: Record<string, string> = {
      "#updatedAt": "updatedAt",
    };
    const exprValues: Record<string, any> = {
      ":u": new Date().toISOString(),
    };

    if (title) {
      updateParts.push("#title = :t");
      exprNames["#title"] = "title";
      exprValues[":t"] = title;
    }

    if (segments) {
      updateParts.push("#segments = :s");
      exprNames["#segments"] = "segments";
      exprValues[":s"] = segments;
    }

    if (captionSettings) {
      updateParts.push("#captionSettings = :cs");
      exprNames["#captionSettings"] = "captionSettings";
      exprValues[":cs"] = captionSettings;
    }

    if (globalFraming) {
      updateParts.push("#globalFraming = :gf");
      exprNames["#globalFraming"] = "globalFraming";
      exprValues[":gf"] = globalFraming;
    }

    await docClient.send(
      new UpdateCommand({
        TableName: PROJECTS_TABLE,
        Key: { projectId },
        UpdateExpression: `SET ${updateParts.join(", ")}`,
        ExpressionAttributeNames: exprNames,
        ExpressionAttributeValues: exprValues,
        ReturnValues: "ALL_NEW",
      })
    );

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        success: true,
        title,
        segments,
        captionSettings,
        globalFraming,
      }),
    };
  } catch (error) {
    console.error("Error updating project:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Failed to update project" }),
    };
  }
};
