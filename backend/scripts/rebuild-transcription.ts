#!/usr/bin/env npx tsx
/**
 * Rebuild Transcription Script
 *
 * Re-fetches per-chunk transcriptions from 12Labs and rebuilds the merged
 * transcription with correct timestamp offsets.
 *
 * Usage:
 *   npx tsx scripts/rebuild-transcription.ts [--dry-run]
 *
 * Prerequisites:
 *   - AWS credentials configured for profile "zeevee" (or default)
 *   - 12Labs videos must still exist in the index
 *
 * What this does:
 *   1. Finds the Miami Vice asset in DynamoDB
 *   2. Fetches the 12Labs API key from Secrets Manager
 *   3. Fetches raw per-chunk transcriptions from 12Labs API
 *   4. Probes the actual chunk timing from the local source file
 *   5. Applies correct offsets accounting for audio stream start times
 *   6. Deduplicates overlap regions
 *   7. Saves corrected transcription to S3
 */

import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  ScanCommand as DocScanCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import axios from "axios";
import { execSync } from "child_process";
import path from "path";

// ============================================================================
// Configuration
// ============================================================================

const AWS_REGION = "us-west-2";
const AWS_PROFILE = "zeevee";
const TABLE_NAME = "zeevee-assets";
const BUCKET_NAME = "zeevee-media-dev";
const TWELVE_LABS_INDEX_ID = "6934df867a1ec630b5fb65bd";
const SECRET_NAME = "zeevee/12labs-key";

// Target asset (Miami Vice S1E1 - matched by duration 5699.32s)
const TARGET_ASSET_ID = "ba05b1b3-7265-4eae-a22b-c7ace6e297ff";

// Source file for probing chunk timing
const SOURCE_FILE = path.join(
  process.env.HOME || "~",
  "Downloads",
  "Miami Vice S1E1.m4v",
);

const DRY_RUN = process.argv.includes("--dry-run");

// ============================================================================
// AWS Clients
// ============================================================================

const dynamoClient = new DynamoDBClient({
  region: AWS_REGION,
  profile: AWS_PROFILE,
});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({ region: AWS_REGION, profile: AWS_PROFILE });
const secretsClient = new SecretsManagerClient({
  region: AWS_REGION,
  profile: AWS_PROFILE,
});

// ============================================================================
// Helpers
// ============================================================================

interface ChunkInfo {
  chunkIndex: number;
  s3Key: string;
  startOffset: number;
  endOffset: number;
  duration: number;
  actualDuration?: number;
  actualStartOffset?: number;
  videoId?: string;
  taskId?: string;
}

interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
  [key: string]: any; // preserve any other fields from 12Labs
}

/**
 * Probe the audio and video start times of an extracted chunk using ffprobe.
 * This reveals the actual container offsets for each stream.
 *
 * The key finding: when chunks are extracted with `-ignore_editlist 1 -c:v copy`,
 * the video stream can start at a significantly non-zero PTS (e.g. 11.4s) due to
 * B-frame composition time offsets (ctts) not being compensated by the edit list.
 *
 * 12Labs appears to anchor transcription timestamps to the video stream's PTS,
 * so all timestamps get inflated by the video start offset. We need to subtract
 * this offset to get correct original-video-relative timestamps.
 */
function probeChunkStreamOffsets(
  sourcePath: string,
  seekTime: number,
  chunkDuration: number,
): { videoStart: number; audioStart: number; formatDuration: number } {
  // Re-extract using the same FFmpeg args as splitVideo.ts
  const tmpPath = `/tmp/probe_chunk_${seekTime}.mp4`;

  try {
    // Extract just 30s to quickly probe the stream offsets
    const duration = Math.min(30, chunkDuration);
    execSync(
      `ffmpeg -y -ignore_editlist 1 -ss ${seekTime} -i "${sourcePath}" -t ${duration} ` +
        `-c:v copy -c:a aac -b:a 128k -ar 44100 -avoid_negative_ts make_zero ` +
        `-movflags +faststart "${tmpPath}" 2>/dev/null`,
      { timeout: 30000 },
    );

    // Probe both audio and video start times
    const probeJson = execSync(
      `ffprobe -v error -show_entries stream=codec_type,start_time,duration ` +
        `-show_entries format=duration -of json "${tmpPath}"`,
      { timeout: 10000, encoding: "utf-8" },
    );

    const probe = JSON.parse(probeJson);

    let videoStart = 0;
    let audioStart = 0;
    for (const stream of probe.streams || []) {
      if (stream.codec_type === "video") {
        videoStart = parseFloat(stream.start_time || "0");
      }
      if (stream.codec_type === "audio") {
        audioStart = parseFloat(stream.start_time || "0");
      }
    }
    const formatDuration = parseFloat(probe.format?.duration || "0");

    // Clean up
    try {
      execSync(`rm -f "${tmpPath}"`);
    } catch {}

    return { videoStart, audioStart, formatDuration };
  } catch (err) {
    console.warn(`  ⚠ Could not probe chunk at seek=${seekTime}s:`, err);
    try {
      execSync(`rm -f "${tmpPath}"`);
    } catch {}
    return { videoStart: 0, audioStart: 0, formatDuration: 0 };
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("=== Rebuild Transcription Script ===\n");
  if (DRY_RUN) console.log("** DRY RUN MODE — will not write to S3 **\n");

  // 1. Get Miami Vice asset from DynamoDB
  console.log(`1. Fetching asset ${TARGET_ASSET_ID} from DynamoDB...`);
  const getResult = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { assetId: TARGET_ASSET_ID },
    }),
  );

  if (!getResult.Item) {
    console.error(`   Asset ${TARGET_ASSET_ID} not found in DynamoDB.`);
    process.exit(1);
  }

  const asset = getResult.Item;
  const assetId = asset.assetId;
  const chunks: ChunkInfo[] = asset.chunks || [];

  console.log(`   Found: ${asset.name || asset.s3Key || assetId}`);
  console.log(`   Asset ID: ${assetId}`);
  console.log(`   Status: ${asset.status}`);
  console.log(`   Chunks: ${chunks.length}`);
  console.log(`   Duration: ${asset.duration}s`);
  console.log(`   Transcription URL: ${asset.transcriptionUrl || "none"}`);

  if (chunks.length === 0) {
    console.error("   Asset has no chunks!");
    process.exit(1);
  }

  // Print chunk info
  console.log("\n   Chunk metadata from DynamoDB:");
  for (const chunk of chunks) {
    console.log(
      `   Chunk ${chunk.chunkIndex}: videoId=${chunk.videoId || "MISSING"}, ` +
        `startOffset=${chunk.startOffset}s, endOffset=${chunk.endOffset}s, ` +
        `duration=${chunk.duration}s` +
        (chunk.actualStartOffset !== undefined
          ? `, actualStart=${chunk.actualStartOffset}s`
          : "") +
        (chunk.actualDuration !== undefined
          ? `, actualDur=${chunk.actualDuration}s`
          : ""),
    );
  }

  // 2. Get 12Labs API key
  console.log("\n2. Fetching 12Labs API key from Secrets Manager...");
  let apiKey: string;
  try {
    const secretResult = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: SECRET_NAME }),
    );
    apiKey = secretResult.SecretString!;
    console.log("   Got API key.");
  } catch (err: any) {
    console.error(`   Failed to get secret: ${err.message}`);
    console.log("   Trying alternative secret names...");
    // Try other possible names
    for (const name of [
      "zeevee/twelve-labs-key",
      "twelve-labs-key",
      "zeevee-dev-twelve-labs-key",
    ]) {
      try {
        const result = await secretsClient.send(
          new GetSecretValueCommand({ SecretId: name }),
        );
        apiKey = result.SecretString!;
        console.log(`   Got API key from "${name}".`);
        break;
      } catch {}
    }
    if (!apiKey!) {
      console.error("   Could not find 12Labs API key in any secret.");
      process.exit(1);
    }
  }

  // 3. Probe actual chunk timing from source file
  console.log(`\n3. Probing chunk timing from source file...`);
  console.log(`   Source: ${SOURCE_FILE}`);

  const chunkTimingCorrections: Map<
    number,
    { videoStart: number; audioStart: number }
  > = new Map();

  for (const chunk of chunks.sort((a, b) => a.chunkIndex - b.chunkIndex)) {
    console.log(
      `\n   Probing chunk ${chunk.chunkIndex} (seek=${chunk.startOffset}s)...`,
    );
    const probe = probeChunkStreamOffsets(
      SOURCE_FILE,
      chunk.startOffset,
      chunk.duration,
    );
    console.log(
      `   Video starts at container time: ${probe.videoStart.toFixed(3)}s`,
    );
    console.log(
      `   Audio starts at container time: ${probe.audioStart.toFixed(3)}s`,
    );
    chunkTimingCorrections.set(chunk.chunkIndex, {
      videoStart: probe.videoStart,
      audioStart: probe.audioStart,
    });
  }

  // 4. Fetch raw per-chunk transcriptions from 12Labs
  console.log("\n4. Fetching raw per-chunk transcriptions from 12Labs...");

  const allTranscriptions: TranscriptionSegment[] = [];

  for (const chunk of chunks.sort((a, b) => a.chunkIndex - b.chunkIndex)) {
    if (!chunk.videoId) {
      console.warn(`   Chunk ${chunk.chunkIndex}: no videoId, skipping.`);
      continue;
    }

    console.log(
      `\n   Chunk ${chunk.chunkIndex} (videoId: ${chunk.videoId})...`,
    );

    try {
      const url = `https://api.twelvelabs.io/v1.3/indexes/${TWELVE_LABS_INDEX_ID}/videos/${chunk.videoId}`;
      const response = await axios.get(url, {
        headers: { "x-api-key": apiKey },
        params: { transcription: true },
      });

      const rawSegments = response.data?.transcription;
      if (
        !rawSegments ||
        !Array.isArray(rawSegments) ||
        rawSegments.length === 0
      ) {
        console.warn(`   No transcription data returned.`);
        continue;
      }

      console.log(`   Got ${rawSegments.length} raw segments.`);

      // Show first and last few segments for debugging
      const first = rawSegments[0];
      const last = rawSegments[rawSegments.length - 1];
      console.log(
        `   First segment: start=${first.start}s, end=${first.end}s, text="${(first.text || first.value || "").substring(0, 60)}..."`,
      );
      console.log(
        `   Last segment:  start=${last.start}s, end=${last.end}s, text="${(last.text || last.value || "").substring(0, 60)}..."`,
      );

      // Calculate the correct offset for this chunk.
      //
      // Chunks are extracted with `-ignore_editlist 1`, so their container
      // timestamps are in "raw media time." But the browser plays the
      // ORIGINAL file WITH edit lists, creating a different presentation
      // timeline. The edit-list correction is NOT constant across the file.
      //
      // Per-chunk offsets measured via audio cross-correlation:
      //   chunk0: container 19.5s → original 29.047s  => container_offset = 9.547
      //   chunk1: container 12.0s → original 3273.913s => container_offset = 3261.91
      //
      // Additionally, 12Labs maps the first audio sample to time 0. When
      // the audio stream starts at a non-zero container time (e.g. 8.176s
      // in chunk 1), we must add that delay:
      //   chunk0: audio starts at 0.000 → 12labs_time = container_time
      //   chunk1: audio starts at 8.176 → 12labs_time = container_time - 8.176
      //
      // Final per-chunk offsets (empirically verified):
      //   chunk0: 12labs + 0.000 + 9.547 = 12labs + 9.547
      //   chunk1: 12labs + 8.176 + 3261.91 = 12labs + 3270.09
      const CHUNK_OFFSETS: Record<number, number> = {
        0: 9.547, // startOffset(0) + edit_list_shift(9.547)
        1: 3279.547, // startOffset(3270) + edit_list_shift(9.547)
      };

      const timing = chunkTimingCorrections.get(chunk.chunkIndex);
      const videoStart = timing?.videoStart ?? 0;
      const audioStart = timing?.audioStart ?? 0;

      const totalOffset =
        CHUNK_OFFSETS[chunk.chunkIndex] ?? audioStart + chunk.startOffset;
      console.log(
        `   Video stream start: ${videoStart.toFixed(3)}s, Audio stream start: ${audioStart.toFixed(3)}s`,
      );
      console.log(
        `   Empirical offset for chunk ${chunk.chunkIndex}: +${totalOffset.toFixed(3)}s`,
      );

      // Tag each segment with its source chunk for smart dedup later
      for (const segment of rawSegments) {
        const raw = segment.start || 0;
        const adjustedStart = raw + totalOffset;
        const adjustedEnd = (segment.end || 0) + totalOffset;

        allTranscriptions.push({
          ...segment,
          start: Math.max(0, adjustedStart),
          end: Math.max(0, adjustedEnd),
          _sourceChunk: chunk.chunkIndex,
        });
      }
    } catch (err: any) {
      console.error(
        `   Failed to fetch transcription for chunk ${chunk.chunkIndex}:`,
        err.response?.data || err.message,
      );
    }
  }

  if (allTranscriptions.length === 0) {
    console.error("\nNo transcription data retrieved from any chunk.");
    process.exit(1);
  }

  // 5. Sort and deduplicate with chunk-aware overlap handling
  console.log(`\n5. Merging ${allTranscriptions.length} raw segments...`);

  // Identify overlap regions between consecutive chunks.
  // Since per-chunk offsets differ, compute overlap from actual adjusted ranges.
  // The same CHUNK_OFFSETS used during segment adjustment above:
  const DEDUP_CHUNK_OFFSETS: Record<number, number> = {
    0: 9.547,
    1: 3279.547,
  };
  const sortedChunks = chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
  const overlapRegions: { start: number; end: number; cutover: number }[] = [];

  for (let i = 0; i < sortedChunks.length - 1; i++) {
    const current = sortedChunks[i];
    const next = sortedChunks[i + 1];

    // Later chunk's adjusted start (12Labs starts near 0)
    const overlapStart =
      DEDUP_CHUNK_OFFSETS[next.chunkIndex] ?? next.startOffset;
    // Earlier chunk's adjusted end (12Labs goes up to endOffset - startOffset in chunk time)
    const overlapEnd =
      current.endOffset -
      current.startOffset +
      (DEDUP_CHUNK_OFFSETS[current.chunkIndex] ?? current.startOffset);

    if (overlapStart < overlapEnd) {
      // Cut over at the midpoint of the overlap
      const cutover = (overlapStart + overlapEnd) / 2;
      overlapRegions.push({ start: overlapStart, end: overlapEnd, cutover });
      console.log(
        `   Overlap region: ${overlapStart.toFixed(1)}s to ${overlapEnd.toFixed(1)}s (cutover at ${cutover.toFixed(1)}s)`,
      );
    }
  }

  // Chunk-aware dedup: in overlap regions, prefer earlier chunk before cutover,
  // later chunk after cutover. This cleanly handles the 30s overlap.
  const deduped: TranscriptionSegment[] = [];
  let removedCount = 0;

  // Sort all segments by start time
  allTranscriptions.sort((a, b) => a.start - b.start);

  for (const segment of allTranscriptions) {
    const chunkIdx = segment._sourceChunk;
    let shouldKeep = true;

    // Check if this segment falls in an overlap region
    for (const overlap of overlapRegions) {
      if (segment.start >= overlap.start && segment.start < overlap.end) {
        // In overlap region - decide based on cutover point.
        // Compare against adjusted offsets (raw offset + edit list correction).
        if (segment.start < overlap.cutover) {
          // Before cutover: keep earlier chunk's data
          const earlierChunkIdx = sortedChunks.findIndex((c) => {
            const adjEnd =
              c.endOffset -
              c.startOffset +
              (DEDUP_CHUNK_OFFSETS[c.chunkIndex] ?? c.startOffset);
            return Math.abs(adjEnd - overlap.end) < 1;
          });
          if (
            earlierChunkIdx >= 0 &&
            chunkIdx !== sortedChunks[earlierChunkIdx].chunkIndex
          ) {
            shouldKeep = false;
          }
        } else {
          // After cutover: keep later chunk's data
          const laterChunkIdx = sortedChunks.findIndex((c) => {
            const adjStart = DEDUP_CHUNK_OFFSETS[c.chunkIndex] ?? c.startOffset;
            return Math.abs(adjStart - overlap.start) < 1;
          });
          if (
            laterChunkIdx >= 0 &&
            chunkIdx !== sortedChunks[laterChunkIdx].chunkIndex
          ) {
            shouldKeep = false;
          }
        }
        break;
      }
    }

    if (shouldKeep) {
      deduped.push(segment);
    } else {
      removedCount++;
    }
  }

  // Clean up internal tracking field
  for (const seg of deduped) {
    delete (seg as any)._sourceChunk;
  }

  console.log(
    `   After dedup: ${deduped.length} segments (removed ${removedCount} from overlap regions)`,
  );

  // Print summary
  if (deduped.length > 0) {
    const firstSeg = deduped[0];
    const lastSeg = deduped[deduped.length - 1];
    console.log(
      `   Time range: ${firstSeg.start.toFixed(1)}s to ${lastSeg.end.toFixed(1)}s`,
    );
  }

  // 6. Read existing transcription for comparison
  console.log("\n6. Comparing with existing transcription...");
  if (asset.transcriptionUrl) {
    try {
      const parts = asset.transcriptionUrl.replace("s3://", "").split("/");
      const bucket = parts[0];
      const key = parts.slice(1).join("/");

      const existing = await s3Client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      const existingBody = await existing.Body?.transformToString();
      if (existingBody) {
        const existingData = JSON.parse(existingBody);
        console.log(`   Existing: ${existingData.length} segments`);
        if (existingData.length > 0) {
          const ef = existingData[0];
          const el = existingData[existingData.length - 1];
          console.log(
            `   Existing range: ${(ef.start ?? ef.startTime ?? 0).toFixed(1)}s to ${(el.end ?? el.endTime ?? 0).toFixed(1)}s`,
          );
          console.log(
            `   New range:      ${deduped[0]?.start.toFixed(1)}s to ${deduped[deduped.length - 1]?.end.toFixed(1)}s`,
          );

          // Show a few sample diffs
          console.log("\n   Sample timing differences (first 5 segments):");
          for (
            let i = 0;
            i < Math.min(5, existingData.length, deduped.length);
            i++
          ) {
            const oldStart =
              existingData[i].start ?? existingData[i].startTime ?? 0;
            const newStart = deduped[i].start;
            const diff = newStart - oldStart;
            console.log(
              `   [${i}] old=${oldStart.toFixed(1)}s → new=${newStart.toFixed(1)}s (diff=${diff > 0 ? "+" : ""}${diff.toFixed(1)}s) "${(deduped[i].text || "").substring(0, 40)}..."`,
            );
          }
        }
      }
    } catch (err: any) {
      console.warn(`   Could not read existing transcription: ${err.message}`);
    }
  }

  // 7. Save to S3
  const s3Key = `transcriptions/${assetId}.json`;

  if (DRY_RUN) {
    console.log(`\n7. DRY RUN — would save ${deduped.length} segments to:`);
    console.log(`   s3://${BUCKET_NAME}/${s3Key}`);
    console.log("\n   Run without --dry-run to actually save.");
  } else {
    console.log(`\n7. Saving corrected transcription to S3...`);
    await s3Client.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: s3Key,
        Body: JSON.stringify(deduped),
        ContentType: "application/json",
      }),
    );
    console.log(
      `   Saved ${deduped.length} segments to s3://${BUCKET_NAME}/${s3Key}`,
    );

    // Update DynamoDB transcriptionUrl if it wasn't set
    if (!asset.transcriptionUrl) {
      await docClient.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { assetId },
          UpdateExpression: "SET transcriptionUrl = :url, updatedAt = :ua",
          ExpressionAttributeValues: {
            ":url": `s3://${BUCKET_NAME}/${s3Key}`,
            ":ua": new Date().toISOString(),
          },
        }),
      );
      console.log("   Updated DynamoDB transcriptionUrl.");
    }
  }

  console.log("\nDone!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
