import { APIGatewayProxyHandler, Handler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { checkAuth } from "../utils/auth";
import type { AssetInfo } from "../services/twelvelabs";
import {
  computeProjectThumbnailFingerprint,
  ensureProjectCoverThumbnail,
} from "../services/project-thumbnails";
import { mapWithConcurrency } from "../utils/concurrency";
import { presignS3Uri } from "../utils/s3";

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambdaClient = new LambdaClient({});

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const BUCKET_NAME = process.env.BUCKET_NAME!;
const SELF_FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME!;

const MAX_CONCURRENCY = 3;
const PRESIGN_TTL_SEC = 43_200;

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

interface AsyncThumbPayload {
  isAsyncJob: true;
  assetId: string;
}

type ProjectRow = {
  projectId: string;
  segments?: Array<{ startTime: number; endTime: number }>;
  thumbnailKey?: string;
  thumbnailContentHash?: string;
};

async function loadAsset(assetId: string): Promise<AssetInfo | null> {
  const assetRes = await docClient.send(
    new GetCommand({
      TableName: ASSETS_TABLE,
      Key: { assetId },
    }),
  );
  if (!assetRes.Item) return null;
  const item = assetRes.Item;
  return {
    assetId,
    isChunked: item.isChunked || false,
    chunks: item.chunks,
    twelveLabsVideoId: item.twelveLabsVideoId,
    duration: item.duration,
    s3VideoUrl: item.s3VideoUrl,
    s3Key: item.key,
  };
}

async function queryProjects(assetId: string): Promise<ProjectRow[]> {
  const projectsRes = await docClient.send(
    new QueryCommand({
      TableName: PROJECTS_TABLE,
      IndexName: "AssetIdIndex",
      KeyConditionExpression: "assetId = :assetId",
      ExpressionAttributeValues: { ":assetId": assetId },
    }),
  );
  return (projectsRes.Items || []) as ProjectRow[];
}

function projectsNeedingFfmpeg(projects: ProjectRow[]): ProjectRow[] {
  return projects.filter((project) => {
    const segments = project.segments || [];
    if (segments.length === 0) return false;
    const fingerprint = computeProjectThumbnailFingerprint(segments);
    return (
      !project.thumbnailKey ||
      !project.thumbnailContentHash ||
      project.thumbnailContentHash !== fingerprint
    );
  });
}

async function presignProjectThumbnails(
  projects: ProjectRow[],
): Promise<
  Array<{
    projectId: string;
    thumbnailUrl: string | null;
    generated: boolean;
    error?: string;
  }>
> {
  return mapWithConcurrency(projects, MAX_CONCURRENCY, async (project) => {
    const projectId = project.projectId;
    const segments = project.segments || [];
    if (segments.length === 0) {
      return { projectId, thumbnailUrl: null, generated: false };
    }
    if (!project.thumbnailKey) {
      return { projectId, thumbnailUrl: null, generated: false };
    }
    const thumbnailUrl = await presignS3Uri(
      `s3://${BUCKET_NAME}/${project.thumbnailKey}`,
      PRESIGN_TTL_SEC,
    );
    return { projectId, thumbnailUrl, generated: false };
  });
}

async function executeEnsureThumbnails(assetId: string): Promise<void> {
  const projects = await queryProjects(assetId);
  const needingWork = projectsNeedingFfmpeg(projects);
  if (needingWork.length === 0) return;

  const asset = await loadAsset(assetId);
  if (!asset) {
    console.error(`[Thumbnails] Async: asset ${assetId} not found`);
    return;
  }

  const workIds = new Set(needingWork.map((p) => p.projectId));

  console.log(
    `[Thumbnails] Async asset ${assetId}: generating ${workIds.size} covers`,
  );

  await mapWithConcurrency(needingWork, MAX_CONCURRENCY, async (project) => {
    const projectId = project.projectId;
    const segments = project.segments || [];
    try {
      await ensureProjectCoverThumbnail({
        projectId,
        segments,
        asset,
        bucketName: BUCKET_NAME,
        projectsTable: PROJECTS_TABLE,
        existingThumbnailKey: project.thumbnailKey,
        existingThumbnailContentHash: project.thumbnailContentHash,
        presignTtlSec: PRESIGN_TTL_SEC,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Thumbnails] Project ${projectId} failed:`, msg);
    }
  });
}

const handleApiRequest: APIGatewayProxyHandler = async (event) => {
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  try {
    const assetId = event.pathParameters?.assetId;
    if (!assetId) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Missing assetId" }),
      };
    }

    const projects = await queryProjects(assetId);
    if (projects.length === 0) {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ projects: [], status: "completed" }),
      };
    }

    const needingWork = projectsNeedingFfmpeg(projects);

    if (needingWork.length > 0) {
      await lambdaClient.send(
        new InvokeCommand({
          FunctionName: SELF_FUNCTION_NAME,
          InvocationType: "Event",
          Payload: JSON.stringify({ isAsyncJob: true, assetId } satisfies AsyncThumbPayload),
        }),
      );

      console.log(
        `[Thumbnails] Queued async ensure for asset ${assetId} (${needingWork.length} projects)`,
      );

      return {
        statusCode: 202,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          message: "Thumbnail generation started",
          status: "generating",
          pendingCount: needingWork.length,
        }),
      };
    }

    const results = await presignProjectThumbnails(projects);
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ projects: results, status: "completed" }),
    };
  } catch (error) {
    console.error("ensureAssetProjectThumbnails error:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error:
          error instanceof Error ? error.message : "Internal server error",
      }),
    };
  }
};

export const handler: Handler = async (event, context, callback) => {
  if (event.isAsyncJob) {
    await executeEnsureThumbnails((event as AsyncThumbPayload).assetId);
    return;
  }
  return handleApiRequest(event, context, callback);
};
