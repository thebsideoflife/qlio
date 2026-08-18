import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import type {
  StoredSegmentMetadata,
  SegmentMetadataResponse,
} from "../types/segment-metadata";
import { pruneSegmentMetadata } from "../services/export-metadata";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { checkAuth } from "../utils/auth";
import { presignS3Uri, presignTranslationMap } from "../utils/s3";
import { inferOriginalTranscriptLanguage } from "../utils/transcript-format";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const BUCKET_NAME = process.env.BUCKET_NAME;
const PRESIGN_TTL_SEC = 43_200;

// Segment render info stored directly on project
interface StoredSegmentRender {
  segmentId: string;
  title: string;
  bucket: string;
  key: string;
  renderedAt: string;
  contentHash?: string;
}

async function deleteProjectThumbnails(projectId: string): Promise<void> {
  if (!BUCKET_NAME) return;
  const prefix = `thumbnails/projects/${projectId}/`;
  let continuationToken: string | undefined;

  do {
    const list = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    const keys = (list.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => !!k);
    if (keys.length > 0) {
      await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET_NAME,
          Delete: { Objects: keys.map((Key) => ({ Key })) },
        }),
      );
    }
    continuationToken = list.IsTruncated
      ? list.NextContinuationToken
      : undefined;
  } while (continuationToken);
}

async function signMediaKey(key: string | undefined): Promise<string | null> {
  if (!key || !BUCKET_NAME) return null;
  return presignS3Uri(`s3://${BUCKET_NAME}/${key}`, PRESIGN_TTL_SEC);
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
      try {
        await deleteProjectThumbnails(projectId);
      } catch (e) {
        console.error(`Failed to delete thumbnails for ${projectId}:`, e);
      }

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
      const inferredLanguage = inferOriginalTranscriptLanguage({
        assetId: String(asset.assetId || project.assetId),
        originalLanguage: asset.originalLanguage,
        transcriptionUrl: asset.transcriptionUrl,
      });
      if (inferredLanguage) asset.originalLanguage = inferredLanguage;

      if (asset.s3VideoUrl) {
        const presignedUrl = await presignS3Uri(asset.s3VideoUrl);
        if (presignedUrl) asset.videoUrl = presignedUrl;
      }

      if (asset.transcriptionUrl) {
        const presignedUrl = await presignS3Uri(asset.transcriptionUrl);
        if (presignedUrl) asset.transcriptionUrl = presignedUrl;
      }

      asset.translations = await presignTranslationMap(asset.translations);
    }

    // 5. Generate presigned URLs for stored segment renders
    // Renders are stored directly on project when they complete
    let lastRenderDownloads: Array<{
      segmentId: string;
      title: string;
      url: string;
      contentHash?: string;
    }> | null = null;

    const storedRenders: StoredSegmentRender[] = project.segmentRenders || [];
    if (storedRenders.length > 0) {
      const downloads: Array<{
        segmentId: string;
        title: string;
        url: string;
        contentHash?: string;
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
            contentHash: render.contentHash,
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

    // 6. Sign export metadata thumbnail URLs (drop rows for deleted segments)
    const validSegmentIds = new Set(
      ((project.segments || []) as Array<{ id: string }>).map((s) => s.id),
    );
    const storedMetadata = pruneSegmentMetadata(
      (project.segmentMetadata || []) as StoredSegmentMetadata[],
      validSegmentIds,
    );

    let segmentMetadataPublic: SegmentMetadataResponse[] | null = null;
    if (storedMetadata.length > 0) {
      segmentMetadataPublic = await Promise.all(
        storedMetadata.map(async (meta) => {
          const { thumbnailKey: _tk, ...rest } = meta;
          return {
            ...rest,
            thumbnailUrl: await signMediaKey(meta.thumbnailKey),
          };
        }),
      );
    }

    const thumbnailUrl = await signMediaKey(project.thumbnailKey);

    const {
      thumbnailKey: _projectThumbKey,
      thumbnailContentHash: _thumbHash,
      thumbnailLockUntil: _thumbLock,
      posterKey: _posterKey,
      exportMetadataJob: _exportMetadataJob,
      segmentMetadata: _segmentMetadata,
      ...projectPublic
    } = project;

    const responseData = {
      ...projectPublic,
      asset,
      lastRenderDownloads,
      segmentMetadata: segmentMetadataPublic ?? [],
      thumbnailUrl,
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
