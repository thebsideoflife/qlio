import { APIGatewayProxyHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { checkAuth } from '../utils/auth';
import { presignS3Uri } from '../utils/s3';
import { computeProjectThumbnailFingerprint } from '../services/project-thumbnails';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const BUCKET_NAME = process.env.BUCKET_NAME;
const PRESIGN_TTL_SEC = 43_200;

interface Segment {
  startTime: number;
  endTime: number;
}

interface ProjectSummary {
  projectId: string;
  assetId: string;
  title: string;
  createdAt: string;
  segmentCount: number;
  firstSegmentStartTime: number | null;
  thumbnailUrl: string | null;
  /** True when cover frame is missing or segment bounds changed since last extract. */
  thumbnailStale: boolean;
}

export const handler: APIGatewayProxyHandler = async (event) => {
  // Auth Check
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  try {
    const assetId = event.queryStringParameters?.assetId;

    // If assetId is provided, filter by asset
    if (assetId) {
      const result = await docClient.send(
        new QueryCommand({
          TableName: PROJECTS_TABLE,
          IndexName: 'AssetIdIndex',
          KeyConditionExpression: 'assetId = :assetId',
          ExpressionAttributeValues: {
            ':assetId': assetId,
          },
        })
      );

      const projects: ProjectSummary[] = await Promise.all(
        (result.Items || []).map(async (item) => {
          const segments: Segment[] = item.segments || [];
          const sortedSegments = [...segments].sort(
            (a, b) => a.startTime - b.startTime,
          );
          const expectedHash = computeProjectThumbnailFingerprint(segments);
          const thumbnailStale =
            segments.length > 0 &&
            (!item.thumbnailKey ||
              !item.thumbnailContentHash ||
              !expectedHash ||
              item.thumbnailContentHash !== expectedHash);
          // Skip presign for stale covers — client triggers ensure + re-list
          let thumbnailUrl: string | null = null;
          if (item.thumbnailKey && BUCKET_NAME && !thumbnailStale) {
            thumbnailUrl = await presignS3Uri(
              `s3://${BUCKET_NAME}/${item.thumbnailKey}`,
              PRESIGN_TTL_SEC,
            );
          }
          return {
            projectId: item.projectId,
            assetId: item.assetId,
            title: item.title,
            createdAt: item.createdAt,
            segmentCount: segments.length,
            firstSegmentStartTime:
              sortedSegments.length > 0 ? sortedSegments[0].startTime : null,
            thumbnailUrl,
            thumbnailStale,
          };
        }),
      );

      projects.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify(projects),
      };
    }

    // If no assetId, return all projects (for future use)
    // For now, we'll just return empty array to keep it simple
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify([]),
    };
  } catch (error) {
    console.error('Error listing projects:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: 'Failed to list projects' }),
    };
  }
};

