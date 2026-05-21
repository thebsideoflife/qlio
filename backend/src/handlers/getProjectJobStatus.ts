import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { checkAuth } from "../utils/auth";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;

// Jobs stuck in pending/analyzing for longer than this are considered failed (OOM, timeout, etc.)
const STALE_JOB_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

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

    // Check if a job is stale (stuck in pending/analyzing too long)
    const isStaleJob = (job: any): boolean => {
      if (!job || !job.startedAt) return false;
      if (job.status !== "pending" && job.status !== "analyzing") return false;
      const ageMs = Date.now() - new Date(job.startedAt).getTime();
      return ageMs > STALE_JOB_THRESHOLD_MS;
    };

    // Mark a stale job as failed in DynamoDB (fire-and-forget, don't block response)
    const markJobAsFailed = (jobType: "generationJob" | "framingJob", job: any) => {
      const now = new Date().toISOString();
      docClient
        .send(
          new UpdateCommand({
            TableName: PROJECTS_TABLE,
            Key: { projectId },
            UpdateExpression: `set ${jobType}.#status = :s, ${jobType}.completedAt = :c, ${jobType}.#error = :e, updatedAt = :u`,
            ExpressionAttributeNames: { "#status": "status", "#error": "error" },
            ExpressionAttributeValues: {
              ":s": "failed",
              ":c": now,
              ":e": "Job timed out (likely OOM or Lambda crash)",
              ":u": now,
            },
          })
        )
        .catch((err) => console.error(`Failed to mark stale ${jobType} as failed:`, err));
    };

    // Extract job status, detecting and marking stale jobs as failed
    const extractJobStatus = (job: any, jobType: "generationJob" | "framingJob"): JobStatus | null => {
      if (!job) return null;

      // If job is stale, mark it as failed and return the failed status
      if (isStaleJob(job)) {
        console.log(
          `[JobStatus] Detected stale ${jobType}: ${job.jobId} started ${job.startedAt}, marking as failed`
        );
        markJobAsFailed(jobType, job);
        return {
          status: "failed",
          jobId: job.jobId,
          startedAt: job.startedAt,
          completedAt: new Date().toISOString(),
          error: "Job timed out (likely OOM or Lambda crash)",
          segmentCount: job.segmentCount,
        };
      }

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
      generationJob: extractJobStatus(project.generationJob, "generationJob"),
      framingJob: extractJobStatus(project.framingJob, "framingJob"),
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
