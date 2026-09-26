import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { checkAuth } from "../utils/auth";
import { RENDER_PIPELINE_VERSION } from "../utils/segmentRenderFingerprint";
import { getActiveAgentRun } from "../services/iq-agent/thread";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const RENDER_JOBS_TABLE = process.env.RENDER_JOBS_TABLE;

/**
 * The export the panel should resume, or null. Only a job that exists and is
 * still rendering is reported: a slot naming a finished or expired-away (TTL)
 * job is released here, so reopening the panel can never resume into a job
 * that will never answer.
 */
async function resolveActiveRenderJob(
  projectId: string,
  activeRenderJobId: unknown,
): Promise<string | null> {
  if (typeof activeRenderJobId !== "string" || !activeRenderJobId) return null;
  if (!RENDER_JOBS_TABLE) return activeRenderJobId;
  const { Item: job } = await docClient.send(
    new GetCommand({
      TableName: RENDER_JOBS_TABLE,
      Key: { jobId: activeRenderJobId },
      ProjectionExpression: "#status",
      ExpressionAttributeNames: { "#status": "status" },
    }),
  );
  // Still rendering (even past its limit): polling it finalizes it.
  if (job?.status === "rendering") return activeRenderJobId;
  await docClient
    .send(
      new UpdateCommand({
        TableName: PROJECTS_TABLE,
        Key: { projectId },
        UpdateExpression: "REMOVE activeRenderJobId",
        ConditionExpression: "activeRenderJobId = :jobId",
        ExpressionAttributeValues: { ":jobId": activeRenderJobId },
      }),
    )
    .catch((error: { name?: string }) => {
      if (error.name !== "ConditionalCheckFailedException") throw error;
    });
  return null;
}

// Jobs stuck in pending/analyzing for longer than this are considered failed (OOM, timeout, etc.)
const STALE_JOB_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

interface JobStatus {
  status: string;
  jobId?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  segmentCount?: number;
  segmentErrors?: Array<{ segmentId: string; error: string }>;
  segmentWarnings?: Array<{
    segmentId: string;
    code: string;
    message: string;
  }>;
}

/** Just enough for a client to know the agent owns the cut right now. */
interface AgentRunStatus {
  runId: string;
  status: string;
  stage: string;
  startedAt?: string;
}

interface ProjectJobStatusResponse {
  projectId: string;
  generationJob: JobStatus | null;
  framingJob: JobStatus | null;
  exportMetadataJob: JobStatus | null;
  exportPackageJob: JobStatus | null;
  // Include active render job if any
  activeRenderJobId: string | null;
  /** Null when no live agent run owns this project. Also null if the lookup failed. */
  agentRun: AgentRunStatus | null;
  renderPipelineVersion: number;
}

/**
 * Fails open: a project with no agent thread, or an unreachable table, reads as
 * "no agent running" rather than breaking the poll every other panel depends on.
 */
async function readAgentRun(projectId: string): Promise<AgentRunStatus | null> {
  if (!process.env.AGENT_THREADS_TABLE) return null;
  try {
    const run = await getActiveAgentRun(projectId);
    if (!run) return null;
    return {
      runId: run.runId,
      status: run.status,
      stage: run.stage,
      startedAt: run.startedAt,
    };
  } catch (err) {
    console.warn("[JobStatus] agent run lookup failed:", err);
    return null;
  }
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
    const [result, agentRun] = await Promise.all([
      docClient.send(
        new GetCommand({
          TableName: PROJECTS_TABLE,
          Key: { projectId },
          // Only fetch job-related fields
          ProjectionExpression: "projectId, generationJob, framingJob, exportMetadataJob, exportPackageJob, activeRenderJobId",
        })
      ),
      readAgentRun(projectId),
    ]);

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
    const isStaleJob = (
      job: any,
      activeStatuses: string[] = ["pending", "analyzing"],
    ): boolean => {
      if (!job || !job.startedAt) return false;
      if (!activeStatuses.includes(job.status)) return false;
      // Long jobs (SporeLabs framing) heartbeat; age runs from the last beat.
      const ageMs =
        Date.now() - new Date(job.heartbeatAt ?? job.startedAt).getTime();
      return ageMs > STALE_JOB_THRESHOLD_MS;
    };

    // Mark a stale job as failed in DynamoDB (fire-and-forget, don't block response)
    const markJobAsFailed = (
      jobType: "generationJob" | "framingJob" | "exportMetadataJob" | "exportPackageJob",
      job: any,
    ) => {
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
    const extractJobStatus = (
      job: any,
      jobType: "generationJob" | "framingJob" | "exportMetadataJob" | "exportPackageJob",
    ): JobStatus | null => {
      if (!job) return null;

      // If job is stale, mark it as failed and return the failed status
      const activeStatuses =
        jobType === "exportMetadataJob"
          ? ["pending", "generating"]
          : jobType === "exportPackageJob"
            ? ["pending", "packaging"]
            : ["pending", "analyzing"];

      if (isStaleJob(job, activeStatuses)) {
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

      const base: JobStatus = {
        status: job.status,
        jobId: job.jobId,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        error: job.error,
        segmentCount: job.segmentCount,
      };

      if (jobType === "exportMetadataJob") {
        if (job.segmentErrors?.length) {
          base.segmentErrors = job.segmentErrors;
        }
        if (job.segmentWarnings?.length) {
          base.segmentWarnings = job.segmentWarnings;
        }
      }

      return base;
    };

    const response: ProjectJobStatusResponse = {
      projectId,
      generationJob: extractJobStatus(project.generationJob, "generationJob"),
      framingJob: extractJobStatus(project.framingJob, "framingJob"),
      exportMetadataJob: extractJobStatus(
        project.exportMetadataJob,
        "exportMetadataJob",
      ),
      exportPackageJob: extractJobStatus(
        project.exportPackageJob,
        "exportPackageJob",
      ),
      activeRenderJobId: await resolveActiveRenderJob(
        projectId,
        project.activeRenderJobId,
      ),
      agentRun,
      // Lets an editor tab loaded before a renderer change notice it's stale.
      renderPipelineVersion: RENDER_PIPELINE_VERSION,
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
