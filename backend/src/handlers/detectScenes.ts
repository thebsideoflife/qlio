import { Handler } from 'aws-lambda';
import { SecretsManager } from '@aws-sdk/client-secrets-manager';
import { TwelveLabsWrapper } from '../services/twelvelabs';

const secrets = new SecretsManager({ region: process.env.AWS_REGION || 'us-west-2' });

interface DetectScenesEvent {
  assetId: string;
  s3Key?: string;
  bucket?: string;
}

export const handler: Handler = async (event: DetectScenesEvent) => {
  console.log('detectScenes invoked', JSON.stringify(event));

  const { assetId } = event;
  if (!assetId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'assetId required' }) };
  }

  const bucket = event.bucket || process.env.BUCKET_NAME;
  if (!bucket) {
    return { statusCode: 400, body: JSON.stringify({ error: 'bucket required' }) };
  }

  const assetsTable = process.env.ASSETS_TABLE;
  if (!assetsTable) {
    throw new Error('ASSETS_TABLE environment variable is required');
  }

  const secretArn = process.env.SECRET_ARN;
  if (!secretArn) {
    throw new Error('SECRET_ARN environment variable is required');
  }

  const secretResponse = await secrets.getSecretValue({ SecretId: secretArn });
  const apiKey = secretResponse.SecretString;
  if (!apiKey) {
    throw new Error('Failed to retrieve Twelve Labs API key');
  }

  const indexId = process.env.TWELVE_LABS_INDEX_ID;
  if (!indexId) {
    throw new Error('TWELVE_LABS_INDEX_ID environment variable is required');
  }

  const twelveLabs = new TwelveLabsWrapper(apiKey, assetsTable, indexId);

  const result = await twelveLabs.detectScenes(assetId);

  return {
    statusCode: 200,
    body: JSON.stringify(result),
  };
};