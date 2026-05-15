import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { checkAuth } from "../utils/auth";
import { presignS3Uri } from "../utils/s3";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;

// Segment render info stored directly on project
interface StoredSegmentRender {
  segmentId: string;
  title: string;
  bucket: string;
  key: string;
  renderedAt: string;
}

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

    const method =
      (event as any).requestContext?.http?.method || event.httpMethod;

    if (method === "DELETE") {
      await docClient.send(
        new DeleteCommand({
          TableName: PROJECTS_TABLE,
          Key: { projectId },
        }),
      );

      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ message: "Project deleted successfully" }),
      };
    }

    // Default to GET logic
    // 2. Fetch Project
    const projectRes = await docClient.send(
      new GetCommand({
        TableName: PROJECTS_TABLE,
        Key: { projectId },
        ConsistentRead: true,
      }),
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
      }),
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

    // 5. Generate presigned URLs for stored segment renders
    // Renders are stored directly on project when they complete
    let lastRenderDownloads: Array<{
      segmentId: string;
      title: string;
      url: string;
    }> | null = null;

    const storedRenders: StoredSegmentRender[] = project.segmentRenders || [];
    if (storedRenders.length > 0) {
      const downloads: Array<{
        segmentId: string;
        title: string;
        url: string;
      }> = [];

      for (const render of storedRenders) {
        try {
          const url = await getSignedUrl(
            s3Client,
            new GetObjectCommand({ Bucket: render.bucket, Key: render.key }),
            { expiresIn: 43200 }, // 12 hours
          );
          downloads.push({
            segmentId: render.segmentId,
            title: render.title,
            url,
          });
        } catch (e) {
          console.error(
            `Failed to presign URL for segment ${render.segmentId}:`,
            e,
          );
        }
      }

      if (downloads.length > 0) {
        lastRenderDownloads = downloads;
        console.log(
          `Generated ${downloads.length} presigned URLs from stored renders`,
        );
      }
    }

    // Combine data
    const responseData = {
      ...project,
      asset,
      lastRenderDownloads,
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
    console.error("Error processing project request:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Failed to process project request" }),
    };
  }
};
