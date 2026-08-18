import {
  CopyObjectCommand,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3Client = new S3Client({});

export const RENDER_DOWNLOAD_TTL_SEC = 43_200;

export function corsRenderObjectKey(
  projectId: string,
  segmentId: string,
  ext = "mp4",
): string {
  return `projects/${projectId}/segments/${segmentId}.${ext}`;
}

function copySource(bucket: string, key: string): string {
  return `${bucket}/${key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

/**
 * Copy a Remotion output onto the CORS-enabled renders bucket so the editor
 * can fetch() it into a ZIP. Falls back to the source location on copy failure.
 */
export async function copyRenderToCorsBucket(params: {
  sourceBucket: string;
  sourceKey: string;
  destBucket: string;
  destKey: string;
}): Promise<{ bucket: string; key: string }> {
  const { sourceBucket, sourceKey, destBucket, destKey } = params;
  if (sourceBucket === destBucket && sourceKey === destKey) {
    return { bucket: destBucket, key: destKey };
  }

  await s3Client.send(
    new CopyObjectCommand({
      Bucket: destBucket,
      Key: destKey,
      CopySource: copySource(sourceBucket, sourceKey),
      MetadataDirective: "COPY",
      // Avoid needing s3:GetObjectTagging / PutObjectTagging across buckets
      TaggingDirective: "REPLACE",
    }),
  );

  return { bucket: destBucket, key: destKey };
}

export async function presignRenderDownload(
  bucket: string,
  key: string,
  expiresIn = RENDER_DOWNLOAD_TTL_SEC,
): Promise<string> {
  return getSignedUrl(
    s3Client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn },
  );
}
