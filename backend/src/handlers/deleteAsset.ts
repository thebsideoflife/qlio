import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  DeleteCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { TwelveLabs } from "twelvelabs-js";
import { checkAuth } from "../utils/auth";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});
const secretsClient = new SecretsManagerClient({});

const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const SECRET_ARN = process.env.SECRET_ARN!; // 12Labs API Key Secret

export const handler: APIGatewayProxyHandler = async (event) => {
  // 1. Auth Check
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

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

  try {
    // 2. Fetch the Asset
    const assetResult = await docClient.send(
      new GetCommand({
        TableName: ASSETS_TABLE,
        Key: { assetId },
      })
    );

    const asset = assetResult.Item;

    if (!asset) {
      return {
        statusCode: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ error: "Asset not found" }),
      };
    }

    // 3. Find Associated Projects
    const projectsResult = await docClient.send(
      new QueryCommand({
        TableName: PROJECTS_TABLE,
        IndexName: "AssetIdIndex",
        KeyConditionExpression: "assetId = :aid",
        ExpressionAttributeValues: {
          ":aid": assetId,
        },
      })
    );

    const projects = projectsResult.Items || [];

    // 4. Delete Associated Data

    // a. Delete Projects
    if (projects.length > 0) {
      console.log(`Deleting ${projects.length} projects associated with asset ${assetId}`);
      await Promise.all(
        projects.map((project) =>
          docClient.send(
            new DeleteCommand({
              TableName: PROJECTS_TABLE,
              Key: { projectId: project.projectId },
            })
          )
        )
      );
    }

    // b. Delete from 12Labs
    const indexId = asset.twelveLabsIndexId;
    const videoId = asset.twelveLabsVideoId;

    if (indexId && videoId) {
      try {
        console.log(`Deleting video ${videoId} from 12Labs index ${indexId}`);
        // Get API Key
        const secretVal = await secretsClient.send(
          new GetSecretValueCommand({ SecretId: SECRET_ARN })
        );
        const apiKey = secretVal.SecretString;
        
        if (apiKey) {
            const client = new TwelveLabs({ apiKey });
            // Using the delete method from the SDK
            await client.indexes.videos.delete(indexId, videoId);
            console.log("Successfully deleted from 12Labs");
        } else {
            console.warn("Could not retrieve 12Labs API key, skipping 12Labs deletion");
        }
      } catch (err) {
        console.error("Error deleting from 12Labs:", err);
        // Continue with other deletions even if 12Labs fails
      }
    } else {
        console.log("Skipping 12Labs deletion: indexId or videoId missing");
    }

    // c. Delete from S3
    const s3Url = asset.s3VideoUrl; // e.g., s3://bucket/key
    if (s3Url && s3Url.startsWith("s3://")) {
      try {
        const parts = s3Url.replace("s3://", "").split("/");
        const bucket = parts[0];
        const key = parts.slice(1).join("/");
        
        console.log(`Deleting object from S3: bucket=${bucket}, key=${key}`);
        await s3Client.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: key,
          })
        );
      } catch (err) {
        console.error("Error deleting from S3:", err);
      }
    }

    // 5. Delete Asset
    console.log(`Deleting asset ${assetId} from DynamoDB`);
    await docClient.send(
      new DeleteCommand({
        TableName: ASSETS_TABLE,
        Key: { assetId },
      })
    );

    return {
      statusCode: 204, // No Content
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
      body: "",
    };
  } catch (error) {
    console.error("Error deleting asset:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Failed to delete asset" }),
    };
  }
};

