import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { checkAuth } from "../utils/auth";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;

interface JobStatus {
  status: string;
  jobId?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  segmentCount?: number;
}

interface ProjectJobStatusResponse {
  projectId: string;
  generationJob: JobStatus | null;
  framingJob: JobStatus | null;
  // Include active render job if any
  activeRenderJobId: string | null;
}

/**
 * Slim job status endpoint for polling.
 * Returns only job status info - no segments, captions, or other project data.
 * Use GET /projects/:projectId when you need the full project.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

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

  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: PROJECTS_TABLE,
        Key: { projectId },
        // Only fetch job-related fields
        ProjectionExpression: "projectId, generationJob, framingJob, activeRenderJobId",
      })
    );

    if (!result.Item) {
      return {
        statusCode: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ error: "Project not found" }),
      };
    }

    const project = result.Item;

    // Extract only job status fields (strip any extra data)
    const extractJobStatus = (job: any): JobStatus | null => {
      if (!job) return null;
      return {
        status: job.status,
        jobId: job.jobId,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        error: job.error,
        segmentCount: job.segmentCount,
      };
    };

    const response: ProjectJobStatusResponse = {
      projectId,
      generationJob: extractJobStatus(project.generationJob),
      framingJob: extractJobStatus(project.framingJob),
      activeRenderJobId: project.activeRenderJobId || null,
    };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(response),
    };
  } catch (error) {
    console.error("Error getting project job status:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Failed to get project job status" }),
    };
  }
};
