import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3Client = new S3Client({});

/**
 * Parses an S3 URI and generates a presigned URL.
 * @param s3Uri The S3 URI (e.g., s3://bucket/key)
 * @param expiresIn Expiration time in seconds (default: 3600)
 * @returns The presigned URL or null if invalid/error
 */
export const presignS3Uri = async (
  s3Uri: string,
  expiresIn: number = 3600
): Promise<string | null> => {
  if (!s3Uri || !s3Uri.startsWith("s3://")) return null;

  try {
    const parts = s3Uri.replace("s3://", "").split("/");
    const bucket = parts[0];
    const key = parts.slice(1).join("/");
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    return await getSignedUrl(s3Client, command, { expiresIn });
  } catch (e) {
    console.error("Error signing S3 URI:", s3Uri, e);
    return null;
  }
};

