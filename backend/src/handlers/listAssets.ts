import { APIGatewayProxyHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { checkAuth } from '../utils/auth';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const s3Client = new S3Client({});

const TABLE_NAME = process.env.TABLE_NAME!;

export const handler: APIGatewayProxyHandler = async (event) => {
  // Auth Check
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  try {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
    }));

    const items = result.Items || [];
    
    // Sort by createdAt desc
    items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    // Generate presigned URLs for all items
    // Note: In a production app with many items, this might be slow and should be paginated or URLs generated on demand (like getAsset).
    // For this MVP, we'll map over them.
    const itemsWithUrls = await Promise.all(items.map(async (item) => {
        if (item.s3VideoUrl && item.s3VideoUrl.startsWith('s3://')) {
            const s3Uri = item.s3VideoUrl;
            const bucket = s3Uri.split('/')[2];
            const key = s3Uri.split('/').slice(3).join('/');
            
            try {
                const command = new GetObjectCommand({ Bucket: bucket, Key: key });
                const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
                return { ...item, id: item.assetId, videoUrl: presignedUrl };
            } catch (e) {
                console.warn('Failed to sign url for item', item.assetId);
                return { ...item, id: item.assetId };
            }
        }
        return { ...item, id: item.assetId };
    }));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(itemsWithUrls),
    };
  } catch (error) {
    console.error('Error listing assets:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: 'Failed to list assets' }),
    };
  }
};
