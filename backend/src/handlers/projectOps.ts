import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  DeleteCommand,
  QueryCommand,
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
const RENDER_JOBS_TABLE = process.env.RENDER_JOBS_TABLE;

// SegmentRender stored in DynamoDB
interface SegmentRenderRecord {
  segmentId: string;
  title: string;
  bucketName: string;
  outputKey: string; // Exact S3 key - stored at render start
  status: "rendering" | "completed" | "failed";
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

    const method = event.httpMethod;

    if (method === "DELETE") {
      await docClient.send(
        new DeleteCommand({
          TableName: PROJECTS_TABLE,
          Key: { projectId },
        })
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

    // 5. Get last completed render job for this project (if any)
    let lastRenderDownloads: Array<{ segmentId: string; title: string; url: string }> | null = null;
    
    if (RENDER_JOBS_TABLE) {
      try {
        // Query for most recent render job (any status - check segments directly)
        const renderJobsResult = await docClient.send(
          new QueryCommand({
            TableName: RENDER_JOBS_TABLE,
            IndexName: "ProjectIdIndex",
            KeyConditionExpression: "projectId = :pid",
            ExpressionAttributeValues: {
              ":pid": projectId,
            },
            ScanIndexForward: false, // Most recent first
            Limit: 5, // Check a few recent jobs
          })
        );

        // Find the most recent job that has completed segments
        console.log(`Found ${renderJobsResult.Items?.length || 0} render jobs for project ${projectId}`);
        
        for (const job of renderJobsResult.Items || []) {
          console.log(`Checking job ${job.jobId}: status=${job.status}, segments=${job.segmentRenders?.length || 0}`);
          if (!job.segmentRenders) continue;
          
          const downloads: Array<{ segmentId: string; title: string; url: string }> = [];
          
          for (const seg of job.segmentRenders as SegmentRenderRecord[]) {
            console.log(`  Segment ${seg.segmentId}: status=${seg.status}, hasBucket=${!!seg.bucketName}, hasOutputKey=${!!seg.outputKey}`);
            
            if (seg.status === "completed" && seg.bucketName && seg.outputKey) {
              try {
                const url = await getSignedUrl(
                  s3Client,
                  new GetObjectCommand({ Bucket: seg.bucketName, Key: seg.outputKey }),
                  { expiresIn: 43200 } // 12 hours
                );
                downloads.push({ segmentId: seg.segmentId, title: seg.title, url });
              } catch (e) {
                console.error(`Failed to presign URL for segment ${seg.segmentId}:`, e);
              }
            }
          }
          
          // Use the first job that has at least one completed segment
          if (downloads.length > 0) {
            lastRenderDownloads = downloads;
            console.log(`Found ${downloads.length} cached renders from job ${job.jobId}`);
            break;
          }
        }
      } catch (e) {
        console.error("Failed to fetch last render job:", e);
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
