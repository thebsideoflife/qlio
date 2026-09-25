import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { checkAuth } from "../utils/auth";
import { captionSettingsEqual } from "../utils/caption-settings";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;

const GENERATION_INPUT_KEYS = [
  "userPrompt",
  "purpose",
  "format",
  "assetType",
  "platform",
  "minSegmentDuration",
  "maxSegmentDuration",
  "targetPercent",
] as const;

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
    const { title, segments, captionSettings, globalFraming, metadata } = body;

    // Check if any updateable fields are provided
    if (!title && !segments && !captionSettings && !globalFraming && !metadata) {
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

    const wantsMetadataMerge = Boolean(metadata && typeof metadata === "object");

    // Read the stored fields we need to compare/merge against, in one round trip.
    let existingItem: Record<string, any> | undefined;
    if (captionSettings || wantsMetadataMerge) {
      const existing = await docClient.send(
        new GetCommand({
          TableName: PROJECTS_TABLE,
          Key: { projectId },
          ProjectionExpression: "#meta, #captionSettings",
          ExpressionAttributeNames: {
            "#meta": "metadata",
            "#captionSettings": "captionSettings",
          },
        }),
      );
      existingItem = existing.Item;
    }

    if (captionSettings) {
      updateParts.push("#captionSettings = :cs");
      exprNames["#captionSettings"] = "captionSettings";
      exprValues[":cs"] = captionSettings;

      // The editor autosaves the whole caption-settings object on every dirty
      // tick, so only stamp captionSettingsUpdatedAt when the settings really
      // changed. createProject uses this stamp to find the sibling project
      // whose captions were most recently edited by a user.
      if (!captionSettingsEqual(existingItem?.captionSettings, captionSettings)) {
        updateParts.push("#captionSettingsUpdatedAt = :u");
        exprNames["#captionSettingsUpdatedAt"] = "captionSettingsUpdatedAt";
      }
    }

    if (globalFraming) {
      updateParts.push("#globalFraming = :gf");
      exprNames["#globalFraming"] = "globalFraming";
      exprValues[":gf"] = globalFraming;
    }

    if (wantsMetadataMerge) {
      // Merge generation inputs into existing metadata; preserve unrelated keys.
      const current = (existingItem?.metadata ?? {}) as Record<string, unknown>;
      const next: Record<string, unknown> = { ...current };
      for (const key of GENERATION_INPUT_KEYS) {
        if (key in metadata) next[key] = metadata[key];
      }
      if (typeof next.assetType === "string" && next.assetType) {
        delete next.type;
      }
      updateParts.push("#metadata = :meta");
      exprNames["#metadata"] = "metadata";
      exprValues[":meta"] = next;
    }

    await docClient.send(
      new UpdateCommand({
        TableName: PROJECTS_TABLE,
        Key: { projectId },
        UpdateExpression: `SET ${updateParts.join(", ")}`,
        ConditionExpression: "attribute_exists(projectId)",
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
        metadata,
      }),
    };
  } catch (error: any) {
    if (error.name === "ConditionalCheckFailedException") {
      return {
        statusCode: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ error: "Project not found" }),
      };
    }
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
