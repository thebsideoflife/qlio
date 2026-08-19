import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getSignedUrl as getCloudFrontSignedUrl } from "@aws-sdk/cloudfront-signer";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const s3Client = new S3Client({});
const secretsClient = new SecretsManagerClient({});

// CloudFront configuration from environment
const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN;
const CLOUDFRONT_KEY_PAIR_ID = process.env.CLOUDFRONT_KEY_PAIR_ID;
const CLOUDFRONT_PRIVATE_KEY_SECRET_ARN =
  process.env.CLOUDFRONT_PRIVATE_KEY_SECRET_ARN;

// Cache the private key to avoid repeated Secrets Manager calls
let cachedPrivateKey: string | null = null;

/**
 * Get the CloudFront private key from Secrets Manager (cached).
 */
async function getCloudFrontPrivateKey(): Promise<string | null> {
  if (cachedPrivateKey) return cachedPrivateKey;
  if (!CLOUDFRONT_PRIVATE_KEY_SECRET_ARN) return null;

  try {
    const response = await secretsClient.send(
      new GetSecretValueCommand({
        SecretId: CLOUDFRONT_PRIVATE_KEY_SECRET_ARN,
      }),
    );
    cachedPrivateKey = response.SecretString || null;
    return cachedPrivateKey;
  } catch (e) {
    console.error("Failed to get CloudFront private key:", e);
    return null;
  }
}

/**
 * Generate a CloudFront signed URL for an S3 object.
 * Falls back to S3 presigned URL if CloudFront is not configured.
 */
async function signWithCloudFront(
  bucket: string,
  key: string,
  expiresIn: number,
): Promise<string | null> {
  // Check if CloudFront is configured
  if (!CLOUDFRONT_DOMAIN || !CLOUDFRONT_KEY_PAIR_ID) {
    return null; // Fall back to S3 presigning
  }

  const privateKey = await getCloudFrontPrivateKey();
  if (!privateKey) {
    console.warn("CloudFront private key not available, falling back to S3");
    return null;
  }

  try {
    const url = `https://${CLOUDFRONT_DOMAIN}/${key}`;
    const dateLessThan = new Date(Date.now() + expiresIn * 1000).toISOString();

    const signedUrl = getCloudFrontSignedUrl({
      url,
      keyPairId: CLOUDFRONT_KEY_PAIR_ID,
      privateKey,
      dateLessThan,
    });

    console.log("Generated CloudFront signed URL:", {
      domain: CLOUDFRONT_DOMAIN,
      key,
      expiresIn,
    });

    return signedUrl;
  } catch (e) {
    console.error("Error generating CloudFront signed URL:", e);
    return null;
  }
}

/**
 * Generate an S3 presigned URL (fallback when CloudFront is not available).
 */
async function signWithS3(
  bucket: string,
  key: string,
  expiresIn: number,
): Promise<string | null> {
  try {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn });

    console.log("Generated S3 presigned URL:", {
      bucket,
      key,
      expiresIn,
      urlLength: signedUrl.length,
    });

    return signedUrl;
  } catch (e) {
    console.error("Error generating S3 presigned URL:", e);
    return null;
  }
}

/**
 * Parses an S3 URI and generates a signed URL.
 * Uses CloudFront if configured, otherwise falls back to S3 presigning.
 *
 * @param s3Uri The S3 URI (e.g., s3://bucket/key)
 * @param expiresIn Expiration time in seconds (default: 43200 = 12 hours)
 * @returns The signed URL or null if invalid/error
 */
export const presignS3Uri = async (
  s3Uri: string,
  expiresIn: number = 43200,
): Promise<string | null> => {
  if (!s3Uri || !s3Uri.startsWith("s3://")) {
    console.error("Invalid S3 URI:", s3Uri);
    return null;
  }

  const parts = s3Uri.replace("s3://", "").split("/");
  const bucket = parts[0];
  const key = parts.slice(1).join("/");

  if (!bucket || !key) {
    console.error("Failed to parse S3 URI - missing bucket or key:", s3Uri);
    return null;
  }

  // Try CloudFront first, fall back to S3
  const cloudFrontUrl = await signWithCloudFront(bucket, key, expiresIn);
  if (cloudFrontUrl) {
    return cloudFrontUrl;
  }

  // Fall back to S3 presigning
  return signWithS3(bucket, key, expiresIn);
};

export async function presignS3UriList(
  s3Uris: string[],
  expiresIn: number = 43200,
): Promise<string[]> {
  const uniqueUris = [...new Set(s3Uris)];
  const signed = await Promise.all(
    uniqueUris.map((uri) => presignS3Uri(uri, expiresIn)),
  );
  return signed.filter((url): url is string => url !== null);
}

export async function presignTranslationMap(
  translations: unknown,
  expiresIn: number = 43200,
): Promise<Record<string, string>> {
  if (!translations || typeof translations !== "object") return {};
  const signed: Record<string, string> = {};
  for (const [lang, uri] of Object.entries(
    translations as Record<string, unknown>,
  )) {
    if (typeof uri !== "string") continue;
    const url = await presignS3Uri(uri, expiresIn);
    if (url) signed[lang] = url;
  }
  return signed;
}
