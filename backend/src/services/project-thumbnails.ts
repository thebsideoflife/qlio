/**
 * Project cover thumbnails (FFmpeg frame extract → S3 / CloudFront).
 * Shared by export-metadata and dashboard ensure endpoints.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { AssetInfo } from "./twelvelabs";
import {
  computeSegmentMetadataFingerprint,
  projectThumbnailTimestamp,
} from "./export-metadata";
import { extractFrameToS3 } from "../utils/thumbnailExtract";
import { presignS3Uri } from "../utils/s3";

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** Skip duplicate FFmpeg if another Lambda is already extracting this cover. */
const THUMBNAIL_LOCK_MS = 120_000;

export interface ProjectSegmentBounds {
  startTime: number;
  endTime: number;
}

/** Fingerprint of the segment used for the project cover frame. */
export function computeProjectThumbnailFingerprint(
  segments: ProjectSegmentBounds[],
): string | null {
  if (segments.length === 0) return null;
  const sorted = [...segments].sort((a, b) => a.startTime - b.startTime);
  const target = sorted.length >= 2 ? sorted[1] : sorted[0];
  return computeSegmentMetadataFingerprint(
    target.startTime,
    target.endTime,
  );
}

export function resolveAssetSourceKey(asset: AssetInfo): string | undefined {
  if (asset.s3Key) return asset.s3Key;
  if (asset.s3VideoUrl?.startsWith("s3://")) {
    return asset.s3VideoUrl.replace("s3://", "").split("/").slice(1).join("/");
  }
  return undefined;
}

export function projectCoverThumbnailKey(projectId: string): string {
  return `thumbnails/projects/${projectId}/cover.jpg`;
}

export interface EnsureProjectCoverResult {
  thumbnailKey: string;
  thumbnailContentHash: string;
  thumbnailUrl: string;
  generated: boolean;
}

export async function ensureProjectCoverThumbnail(params: {
  projectId: string;
  segments: ProjectSegmentBounds[];
  asset: AssetInfo;
  bucketName: string;
  projectsTable: string;
  existingThumbnailKey?: string;
  existingThumbnailContentHash?: string;
  presignTtlSec?: number;
}): Promise<EnsureProjectCoverResult | null> {
  const {
    projectId,
    segments,
    asset,
    bucketName,
    projectsTable,
    existingThumbnailKey,
    existingThumbnailContentHash,
    presignTtlSec = 43_200,
  } = params;

  const fingerprint = computeProjectThumbnailFingerprint(segments);
  if (!fingerprint) return null;

  const thumbTimestamp = projectThumbnailTimestamp(segments);
  if (thumbTimestamp === null) return null;

  const sourceKey = resolveAssetSourceKey(asset);
  if (!sourceKey) {
    console.warn(`[Thumbnails] No source key for asset ${asset.assetId}`);
    return null;
  }

  const thumbnailKey = existingThumbnailKey || projectCoverThumbnailKey(projectId);
  const isFresh =
    !!existingThumbnailKey &&
    existingThumbnailContentHash === fingerprint;

  if (!isFresh) {
    const lockUntil = Date.now() + THUMBNAIL_LOCK_MS;
    let acquiredLock = false;

    try {
      await docClient.send(
        new UpdateCommand({
          TableName: projectsTable,
          Key: { projectId },
          UpdateExpression: "SET thumbnailLockUntil = :lockUntil",
          ConditionExpression:
            "attribute_not_exists(thumbnailLockUntil) OR thumbnailLockUntil < :now",
          ExpressionAttributeValues: {
            ":lockUntil": lockUntil,
            ":now": Date.now(),
          },
        }),
      );
      acquiredLock = true;
    } catch (err: unknown) {
      const name = err instanceof Error ? (err as { name?: string }).name : "";
      if (name === "ConditionalCheckFailedException") {
        console.log(
          `[Thumbnails] Project ${projectId} extract already in progress, skipping FFmpeg`,
        );
      } else {
        throw err;
      }
    }

    if (acquiredLock) {
      try {
        await extractFrameToS3({
          sourceBucket: bucketName,
          sourceKey,
          timestampSec: thumbTimestamp,
          destBucket: bucketName,
          destKey: thumbnailKey,
        });

        await docClient.send(
          new UpdateCommand({
            TableName: projectsTable,
            Key: { projectId },
            UpdateExpression:
              "SET thumbnailKey = :key, thumbnailContentHash = :hash, updatedAt = :updatedAt REMOVE thumbnailLockUntil",
            ExpressionAttributeValues: {
              ":key": thumbnailKey,
              ":hash": fingerprint,
              ":updatedAt": new Date().toISOString(),
            },
          }),
        );
      } catch (extractErr) {
        await docClient.send(
          new UpdateCommand({
            TableName: projectsTable,
            Key: { projectId },
            UpdateExpression: "REMOVE thumbnailLockUntil",
          }),
        );
        throw extractErr;
      }
    } else {
      // Another Lambda is extracting a new cover — don't presign stale art
      return null;
    }
  }

  const thumbnailUrl = await presignS3Uri(
    `s3://${bucketName}/${thumbnailKey}`,
    presignTtlSec,
  );

  if (!thumbnailUrl) return null;

  return {
    thumbnailKey,
    thumbnailContentHash: fingerprint,
    thumbnailUrl,
    generated: !isFresh,
  };
}
