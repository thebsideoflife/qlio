/**
 * Extract a single JPEG frame from source video via FFmpeg (minimal use — one frame only).
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const execFileAsync = promisify(execFile);
const s3Client = new S3Client({});

const FFMPEG_PATH = process.env.FFMPEG_PATH || "/opt/bin/ffmpeg";

export async function extractFrameToS3(params: {
  sourceBucket: string;
  sourceKey: string;
  timestampSec: number;
  destBucket: string;
  destKey: string;
}): Promise<void> {
  const { sourceBucket, sourceKey, timestampSec, destBucket, destKey } = params;
  const tmpPath = `/tmp/frame-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;

  const presignedUrl = await getSignedUrl(
    s3Client,
    new GetObjectCommand({ Bucket: sourceBucket, Key: sourceKey }),
    { expiresIn: 900 },
  );

  const args = [
    "-ss",
    timestampSec.toFixed(3),
    "-i",
    presignedUrl,
    "-vframes",
    "1",
    "-q:v",
    "2",
    "-y",
    tmpPath,
  ];

  console.log(
    `[Thumbnail] FFmpeg frame at ${timestampSec.toFixed(1)}s → ${destKey}`,
  );

  try {
    await execFileAsync(FFMPEG_PATH, args, { timeout: 120_000 });

    const body = await fs.promises.readFile(tmpPath);
    await s3Client.send(
      new PutObjectCommand({
        Bucket: destBucket,
        Key: destKey,
        Body: body,
        ContentType: "image/jpeg",
      }),
    );
  } finally {
    try {
      await fs.promises.unlink(tmpPath);
    } catch {
      // ignore cleanup errors
    }
  }
}
