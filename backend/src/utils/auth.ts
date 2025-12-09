import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secretsClient = new SecretsManagerClient({});
let cachedPassword: string | null = null;

const getApiPassword = async (): Promise<string | null> => {
  if (cachedPassword) return cachedPassword;

  const secretArn = process.env.API_PASSWORD_SECRET_ARN;
  if (!secretArn) {
    console.error('API_PASSWORD_SECRET_ARN is not set');
    return null;
  }

  try {
    const data = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (data.SecretString) {
      cachedPassword = data.SecretString;
      return cachedPassword;
    }
  } catch (err) {
    console.error('Failed to retrieve API Password from Secrets Manager', err);
  }
  return null;
};

export const checkAuth = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult | null> => {
  // 1. Allow internal or service-to-service calls based on source (Optional/Advanced)
  // For AWS services (like S3 notifications or internal calls), they often invoke via Lambda ARN, 
  // not API Gateway, so this checkAuth might not even run if the handler doesn't call it.
  // BUT, if 12 Labs calls our webhook, it IS via API Gateway.
  
  // Webhook Bypass: Check if it's the webhook path
  // NOTE: This assumes the Lambda is triggered via API Gateway with this specific resource path.
  // Ideally, use API Gateway resource policies or a separate authorizer for webhooks.
  if (event.resource === '/webhook') {
      return null; 
  }

  // S3 Notification Bypass: S3 invokes Lambda directly, not via API Gateway with 'headers'.
  // However, checkAuth expects APIGatewayProxyEvent. If S3 triggers 'start-indexing', it sends S3Event.
  // 'start-indexing' handler does NOT call checkAuth, so this is fine.
  // But if we ever reuse this for non-APIGW events, we need a guard.
  if (!event.headers) {
      // Not an API Gateway event (e.g. S3 invoke), allow or handle differently.
      // For now, assume internal invokes are safe if they bypass APIGW.
      return null;
  }

  const apiPassword = await getApiPassword();
  
  if (!apiPassword) {
    console.error('API Password could not be retrieved');
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Server configuration error' }),
    };
  }

  const providedPassword = event.headers['x-api-password'] || event.headers['X-Api-Password'];

  if (providedPassword !== apiPassword) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  return null; // Auth successful
};
