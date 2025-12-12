import type { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { checkAuth } from "../utils/auth";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const s3Client = new S3Client({});

const RENDER_JOBS_TABLE = process.env.RENDER_JOBS_TABLE!;
const RENDERS_BUCKET = process.env.RENDERS_BUCKET!;

export const handler: APIGatewayProxyHandler = async (event) => {
  // Auth check
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  const jobId = event.pathParameters?.jobId;
  if (!jobId) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing jobId" }),
    };
  }

  // Get render job
  const result = await docClient.send(
    new GetCommand({
      TableName: RENDER_JOBS_TABLE,
      Key: { jobId },
    })
  );

  if (!result.Item) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Render job not found" }),
    };
  }

  const job = result.Item;

  // If completed, generate presigned URL for download
  let downloadUrl: string | undefined;
  if (job.status === "completed" && job.outputKey) {
    try {
      const command = new GetObjectCommand({
        Bucket: RENDERS_BUCKET,
        Key: job.outputKey,
      });
      downloadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    } catch (error) {
      console.error("Error generating presigned URL:", error);
    }
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jobId: job.jobId,
      projectId: job.projectId,
      status: job.status,
      progress: job.progress || 0,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
      error: job.error,
      downloadUrl,
    }),
  };
};
