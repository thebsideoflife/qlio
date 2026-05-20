import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";
import { checkAuth } from "../utils/auth";

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

    // Distinct Project Title (Timestamp based for now to avoid collision with Asset Name)
    const projectTitle = `Microseries ${new Date().toLocaleString()}`;

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
