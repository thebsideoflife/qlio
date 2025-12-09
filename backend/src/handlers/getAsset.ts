import { APIGatewayProxyHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { checkAuth } from '../utils/auth';
import { presignS3Uri } from '../utils/s3';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const TABLE_NAME = process.env.TABLE_NAME!;

export const handler: APIGatewayProxyHandler = async (event) => {
  // Auth Check
  const authResult = await checkAuth(event);
  if (authResult) return authResult;
  
  try {
    const assetId = event.pathParameters?.assetId;
    if (!assetId) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Missing assetId' }),
      };
    }

    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { assetId },
      ConsistentRead: true,
    }));

    if (!result.Item) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Asset not found' }),
      };
    }

    const asset = result.Item;
    // Map assetId to id for frontend compatibility
    asset.id = asset.assetId;

    // Generate Presigned URL for video playback
    if (asset.s3VideoUrl) {
        const presignedUrl = await presignS3Uri(asset.s3VideoUrl);
        if (presignedUrl) asset.videoUrl = presignedUrl;
        }

    // Generate Presigned URL for Thumbnail
    if (asset.thumbnailUrl) {
        const presignedUrl = await presignS3Uri(asset.thumbnailUrl);
        if (presignedUrl) asset.thumbnailUrl = presignedUrl;
    }

    // Generate Presigned URL for Transcription
    if (asset.transcriptionUrl) {
        const presignedUrl = await presignS3Uri(asset.transcriptionUrl);
        if (presignedUrl) asset.transcriptionUrl = presignedUrl;
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(asset),
    };
  } catch (error) {
    console.error('Error getting asset:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: 'Internal Server Error' }),
    };
  }
};
