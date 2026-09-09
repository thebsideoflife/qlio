import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { timingSafeEqual } from 'crypto';

/**
 * Auth for the public-facing showcase endpoints (qlio-showcase Expo app).
 *
 * Deliberately NOT `checkAuth`: the dashboard `x-api-password` user map stays
 * out of the demo app. The showcase app sends `Authorization: Bearer <key>`
 * (EXPO_PUBLIC_QLIO_API_KEY) and the key lives in its own Secrets Manager
 * secret referenced by SHOWCASE_API_KEY_SECRET_ARN.
 *
 * Accepted secret shapes: a bare key string, or JSON
 * {"key":"..."} / {"keys":["...","..."]} (rotate without downtime).
 */

const secretsClient = new SecretsManagerClient({});
let cachedKeys: string[] | null = null;

const getShowcaseKeys = async (): Promise<string[] | null> => {
  if (cachedKeys) return cachedKeys;

  const secretArn = process.env.SHOWCASE_API_KEY_SECRET_ARN;
  if (!secretArn) {
    console.error('SHOWCASE_API_KEY_SECRET_ARN is not set');
    return null;
  }

  try {
    const data = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: secretArn })
    );
    const secretString = data.SecretString?.trim();
    if (!secretString) return null;

    let keys: string[] = [];
    try {
      const parsed = JSON.parse(secretString);
      if (Array.isArray(parsed?.keys)) {
        keys = parsed.keys.filter((k: unknown): k is string => typeof k === 'string' && !!k.trim());
      } else if (typeof parsed?.key === 'string' && parsed.key.trim()) {
        keys = [parsed.key.trim()];
      }
    } catch {
      // Not JSON — the whole secret string is the key.
      keys = [secretString];
    }

    if (keys.length === 0) return null;
    cachedKeys = keys;
    return cachedKeys;
  } catch (err) {
    console.error('Failed to retrieve showcase read key from Secrets Manager', err);
  }
  return null;
};

const matches = (provided: string, expected: string): boolean => {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
};

export const extractBearerToken = (
  event: APIGatewayProxyEvent
): string | null => {
  const header =
    event.headers?.authorization ||
    event.headers?.Authorization ||
    null;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return null;
  const trimmed = token?.trim();
  return trimmed ? trimmed : null;
};

export const checkShowcaseAuth = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult | null> => {
  const deny = (statusCode: number, error: string): APIGatewayProxyResult => ({
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ error }),
  });

  const keys = await getShowcaseKeys();
  if (!keys) {
    console.error('Showcase read key could not be retrieved');
    return deny(500, 'Server configuration error');
  }

  const token = extractBearerToken(event);
  if (!token || !keys.some((key) => matches(token, key))) {
    return deny(401, 'Unauthorized');
  }

  return null;
};
