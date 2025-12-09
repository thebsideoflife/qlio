import { APIGatewayProxyHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { checkAuth } from '../utils/auth';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});

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
    if (asset.s3VideoUrl && asset.s3VideoUrl.startsWith('s3://')) {
        const s3Uri = asset.s3VideoUrl;
        const bucket = s3Uri.split('/')[2];
        const key = s3Uri.split('/').slice(3).join('/');
        
        try {
            const command = new GetObjectCommand({ Bucket: bucket, Key: key });
            const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
            asset.videoUrl = presignedUrl; 
        } catch (e) {
            console.error('Error signing URL for asset:', assetId, e);
        }
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
