import { APIGatewayProxyHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { checkAuth } from '../utils/auth';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;

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

      const projects: ProjectSummary[] = (result.Items || []).map((item) => {
        const segments: Segment[] = item.segments || [];
        const sortedSegments = [...segments].sort((a, b) => a.startTime - b.startTime);
        return {
          projectId: item.projectId,
          assetId: item.assetId,
          title: item.title,
          createdAt: item.createdAt,
          segmentCount: segments.length,
          firstSegmentStartTime: sortedSegments.length > 0 ? sortedSegments[0].startTime : null,
        };
      });

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

