import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { checkAuth } from "../utils/auth";
import { presignS3Uri } from "../utils/s3";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;

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

    // 2. Fetch Project
    const projectRes = await docClient.send(
      new GetCommand({
        TableName: PROJECTS_TABLE,
        Key: { projectId },
        ConsistentRead: true,
      })
    );

    if (!projectRes.Item) {
      return {
        statusCode: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ error: "Project not found" }),
      };
    }

    const project = projectRes.Item;

    // 3. Fetch Associated Asset (to get video URL, etc.)
    const assetRes = await docClient.send(
      new GetCommand({
        TableName: ASSETS_TABLE,
        Key: { assetId: project.assetId },
      })
    );

    const asset = assetRes.Item || null;

    // 4. Presign all S3 URLs in the asset for authenticated access
    if (asset) {
      if (asset.s3VideoUrl) {
        const presignedUrl = await presignS3Uri(asset.s3VideoUrl);
        if (presignedUrl) asset.videoUrl = presignedUrl;
      }

      if (asset.transcriptionUrl) {
        const presignedUrl = await presignS3Uri(asset.transcriptionUrl);
        if (presignedUrl) asset.transcriptionUrl = presignedUrl;
      }
    }

    // Combine data
    const responseData = {
      ...project,
      asset,
    };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(responseData),
    };
  } catch (error) {
    console.error("Error getting project:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Failed to get project" }),
    };
  }
};
