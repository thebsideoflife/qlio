import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";
import { checkAuth } from "../utils/auth";
import { defaultProjectTitle } from "../utils/projectTitle";
import {
  DEFAULT_CAPTION_SETTINGS,
  mergeCaptionSettings,
  pickCaptionSettingsSource,
  type CaptionSettings,
  type ProjectCaptionFields,
} from "../utils/caption-settings";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;

interface Segment {
  id: string;
  startTime: number;
  endTime: number;
  title: string;
  description?: string;
  confidence?: number;
  sceneTags?: string[];
  keyDialogue?: string;
  characters?: string[];
}

/**
 * Look up the asset's existing projects and return the caption settings a new
 * project should start from: the built-in defaults with the most recently
 * caption-edited sibling's settings layered on top. Returns null when no
 * sibling has caption settings, or on any lookup failure (logged) so that
 * project creation never fails because of this.
 */
async function inheritCaptionSettings(
  assetId: string,
): Promise<{ captionSettings: CaptionSettings; captionSettingsUpdatedAt: string } | null> {
  try {
    const siblings: ProjectCaptionFields[] = [];
    let lastKey: Record<string, any> | undefined;
    do {
      const page = await docClient.send(
        new QueryCommand({
          TableName: PROJECTS_TABLE,
          IndexName: "AssetIdIndex",
          KeyConditionExpression: "assetId = :assetId",
          ExpressionAttributeValues: { ":assetId": assetId },
          ProjectionExpression:
            "projectId, captionSettings, captionSettingsUpdatedAt, updatedAt, createdAt",
          ExclusiveStartKey: lastKey,
        }),
      );
      siblings.push(...((page.Items || []) as ProjectCaptionFields[]));
      lastKey = page.LastEvaluatedKey;
    } while (lastKey);

    const source = pickCaptionSettingsSource(siblings);
    if (!source) return null;

    console.log(
      `Inheriting caption settings for asset ${assetId} from project ${source.projectId} (captionSettingsUpdatedAt=${source.captionSettingsUpdatedAt})`,
    );
    return {
      captionSettings: mergeCaptionSettings(
        DEFAULT_CAPTION_SETTINGS,
        source.captionSettings,
      ),
      captionSettingsUpdatedAt: source.captionSettingsUpdatedAt,
    };
  } catch (error) {
    console.error(
      `Failed to look up sibling caption settings for asset ${assetId}; creating project with no caption settings:`,
      error,
    );
    return null;
  }
}

export const handler: APIGatewayProxyHandler = async (event) => {
  // 1. Auth Check
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  try {
    const body = JSON.parse(event.body || "{}");
    const { assetId, metadata } = body;

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

    // 2. Verify Asset Exists
    const assetRes = await docClient.send(
      new GetCommand({
        TableName: ASSETS_TABLE,
        Key: { assetId },
      })
    );

    if (!assetRes.Item) {
      return {
        statusCode: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ error: "Asset not found" }),
      };
    }

    const asset = assetRes.Item;

    // Check asset status - must be READY before creating a project
    if (asset.status !== "READY") {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({
          error: "Asset is not ready yet. Please wait for indexing to complete.",
        }),
      };
    }

    // 3. (Optional) Generate Initial Microseries Segments
    // This logic is now primarily handled in the Editor via 'generateSegments' API,
    // but we can keep a lightweight version here for initial project creation or initialize empty.

    // For now, initializing with empty segments so the user can generate them in the editor.
    const generatedSegments: Segment[] = [];

    const projectId = randomUUID();
    const createdAt = new Date().toISOString();

    const projectTitle = defaultProjectTitle();

    // 4. Inherit caption settings from the asset's most recently
    // caption-edited project, if there is one. Only fills the starting point;
    // when no sibling has caption settings the item is written exactly as before.
    const inherited = await inheritCaptionSettings(assetId);

    // 5. Create Project with Segments
    await docClient.send(
      new PutCommand({
        TableName: PROJECTS_TABLE,
        Item: {
          projectId,
          assetId,
          createdAt,
          updatedAt: createdAt,
          status: "DRAFT",
          metadata: metadata || {},
          title: projectTitle,
          segments: generatedSegments,
          ...(inherited
            ? {
                captionSettings: inherited.captionSettings,
                captionSettingsUpdatedAt: inherited.captionSettingsUpdatedAt,
              }
            : {}),
        },
      })
    );

    return {
      statusCode: 201,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        projectId,
        message: "Project created successfully",
        segments: generatedSegments,
      }),
    };
  } catch (error) {
    console.error("Error creating project:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Failed to create project" }),
    };
  }
};
