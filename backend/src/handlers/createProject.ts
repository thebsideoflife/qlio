import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";
import { checkAuth } from "../utils/auth";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;

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
        body: JSON.stringify({ error: "Missing assetId" }),
      };
    }

    // 2. Verify Asset Exists
    const asset = await docClient.send(
      new GetCommand({
        TableName: ASSETS_TABLE,
        Key: { assetId },
      })
    );

    if (!asset.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Asset not found" }),
      };
    }

    const projectId = randomUUID();
    const createdAt = new Date().toISOString();

    // 3. Create Project
    await docClient.send(
      new PutCommand({
        TableName: PROJECTS_TABLE,
        Item: {
          projectId,
          assetId,
          createdAt,
          updatedAt: createdAt,
          status: "DRAFT",
          metadata: metadata || {}, // Store the questionnaire answers here
          title: asset.Item.originalName || "Untitled Project",
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

