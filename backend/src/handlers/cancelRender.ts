import type { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { checkAuth } from "../utils/auth";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const RENDER_JOBS_TABLE = process.env.RENDER_JOBS_TABLE!;
const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;

export const CANCELLED_ERROR = "Export cancelled";

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(body),
  };
}

function isConditionalFailure(error: unknown): boolean {
  return (error as { name?: string }).name === "ConditionalCheckFailedException";
}

/**
 * POST /renders/{jobId}/cancel
 *
 * The user's way out of any export: ends the job and frees the project's
 * export slot at once, whatever state the job is in. Remotion work already
 * launched finishes in the background and is ignored. Idempotent.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  const jobId = event.pathParameters?.jobId;
  if (!jobId) return json(400, { error: "Missing jobId" });

  const result = await docClient.send(
    new GetCommand({ TableName: RENDER_JOBS_TABLE, Key: { jobId } }),
  );
  const job = result.Item;
  if (!job) return json(404, { error: "Render job not found" });

  let cancelled = false;
  if (job.status === "rendering") {
    try {
      // Bumping rev makes any status check racing this one discard its write.
      await docClient.send(
        new UpdateCommand({
          TableName: RENDER_JOBS_TABLE,
          Key: { jobId },
          UpdateExpression:
            "SET #status = :failed, #error = :error, updatedAt = :now, rev = if_not_exists(rev, :zero) + :one",
          ConditionExpression: "#status = :rendering",
          ExpressionAttributeNames: { "#status": "status", "#error": "error" },
          ExpressionAttributeValues: {
            ":failed": "failed",
            ":rendering": "rendering",
            ":error": CANCELLED_ERROR,
            ":now": new Date().toISOString(),
            ":zero": 0,
            ":one": 1,
          },
        }),
      );
      cancelled = true;
    } catch (error) {
      // It finished on its own in the meantime; still free the slot below.
      if (!isConditionalFailure(error)) throw error;
    }
  }

  // Always release, even for a job that already ended, so the slot can never
  // stay held by a job that isn't running.
  if (typeof job.projectId === "string" && job.projectId) {
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: PROJECTS_TABLE,
          Key: { projectId: job.projectId },
          UpdateExpression: "REMOVE activeRenderJobId SET updatedAt = :now",
          ConditionExpression: "activeRenderJobId = :jobId",
          ExpressionAttributeValues: {
            ":now": new Date().toISOString(),
            ":jobId": jobId,
          },
        }),
      );
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }
  }

  console.log(`Cancel requested for render ${jobId}: cancelled=${cancelled}`);
  return json(200, { jobId, cancelled });
};
