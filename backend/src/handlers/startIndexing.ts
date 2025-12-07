import { S3Event, Handler } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { TwelveLabs } from 'twelvelabs-js';

const s3Client = new S3Client({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const secretsClient = new SecretsManagerClient({});

const TABLE_NAME = process.env.TABLE_NAME!;
const SECRET_ARN = process.env.SECRET_ARN!;
// We need an INDEX_ID. Assuming it's passed or we pick a default. 
// For now, let's assume it's in env or we fail. 
// I'll add it to env var in compute.tf later.
const TWELVE_LABS_INDEX_ID = process.env.TWELVE_LABS_INDEX_ID!; 

export const handler: Handler<S3Event> = async (event) => {
  try {
    // 1. Get 12Labs API Key
    const secretVal = await secretsClient.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
    const apiKey = secretVal.SecretString;
    if (!apiKey) throw new Error('12Labs API Key not found');

    const client = new TwelveLabs({ apiKey });

    for (const record of event.Records) {
      const bucket = record.s3.bucket.name;
      const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
      
      // Parse assetId from key "raw/assetId.mp4"
      const assetId = key.split('/')[1]?.split('.')[0];
      if (!assetId) {
        console.error('Could not parse assetId from key:', key);
        continue;
      }

      // 2. Generate Presigned URL for 12Labs to download
      const signedUrl = await getSignedUrl(s3Client, new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }), { expiresIn: 3600 });

      // 3. Call 12Labs to start indexing
      console.log(`Starting indexing for ${assetId}...`);
      
      const task = await client.tasks.create({
        indexId: TWELVE_LABS_INDEX_ID,
        videoUrl: signedUrl
      });

      const taskId = task.id;

      // 4. Update DynamoDB
      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          assetId,
          status: 'INDEXING',
          s3VideoUrl: `s3://${bucket}/${key}`,
          twelveLabsIndexId: TWELVE_LABS_INDEX_ID, // Storing index ID used
          twelveLabsTaskId: taskId,
          createdAt: new Date().toISOString(),
        }
      }));

      console.log(`Started indexing task ${taskId} for asset ${assetId}`);
    }
  } catch (error: any) {
    console.error('Error in start-indexing:', error);
    throw error;
  }
};

