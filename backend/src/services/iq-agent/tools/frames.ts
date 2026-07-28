/**
 * view_frames — Claude looks at the video itself.
 *
 * FFmpeg grabs single frames straight from a presigned URL (no full download),
 * downscales them, caches them in S3 by rounded timestamp, and hands them back
 * as Anthropic image content blocks. Nothing else in this codebase sends images
 * to a model, so this is the one place that knows about image blocks.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { mapWithConcurrency } from "../../../utils/concurrency";
import { FRAMES_PER_CALL, FRAME_MAX_EDGE_PX, FRAME_TIMEOUT_MS } from "../config";
import { fmtTimecode } from "../ledger";
import {
  toolError,
  type ToolImage,
  type ToolResult,
  type VideoFacts,
} from "../types";
import { errorMessage } from "./search";

const execFileAsync = promisify(execFile);
const s3Client = new S3Client({});
const FFMPEG_PATH = process.env.FFMPEG_PATH || "/opt/bin/ffmpeg";
const EXTRACT_CONCURRENCY = 3;

export function normalizeTimestamps(
  input: unknown,
  videoDuration: number,
): { timestamps: number[]; warnings: string[] } {
  const warnings: string[] = [];
  const raw = Array.isArray(input) ? input : [];
  const numeric = raw
    .map((t) => Number(t))
    .filter((t) => Number.isFinite(t) && t >= 0);

  if (numeric.length < raw.length) {
    warnings.push("Some timestamps were not usable numbers and were dropped.");
  }

  const clamped = numeric.map((t) => {
    if (videoDuration > 0 && t > videoDuration) {
      // Step back slightly — the very last frame is often not decodable.
      const landed = Math.max(0, videoDuration - 0.5);
      warnings.push(
        `${fmtTimecode(t)} is past the end of the source; used ${fmtTimecode(landed)} instead.`,
      );
      return landed;
    }
    return t;
  });

  const unique = Array.from(new Set(clamped.map((t) => Math.round(t * 10) / 10)));
  if (unique.length < clamped.length) {
    warnings.push("Duplicate timestamps were collapsed.");
  }

  if (unique.length > FRAMES_PER_CALL) {
    warnings.push(
      `Requested ${unique.length} frames; only the first ${FRAMES_PER_CALL} were extracted. Call view_frames again for the rest.`,
    );
  }

  return { timestamps: unique.slice(0, FRAMES_PER_CALL), warnings };
}

export async function runViewFrames(params: {
  facts: VideoFacts;
  cacheBucket?: string;
  timestamps: unknown;
  purpose: string;
}): Promise<ToolResult> {
  const { facts, cacheBucket } = params;

  if (!facts.sourceBucket || !facts.sourceKey) {
    return toolError(
      "no_source_file",
      "The original video file could not be located in storage.",
      "Use watch_clip or read_transcript instead — frame extraction is unavailable for this asset.",
    );
  }

  const { timestamps, warnings } = normalizeTimestamps(
    params.timestamps,
    facts.duration,
  );

  if (timestamps.length === 0) {
    return toolError(
      "no_timestamps",
      "No usable timestamps were provided.",
      "Pass explicit source-timeline seconds, e.g. {timestamps: [412, 470.5], purpose: 'check the cut point'}.",
    );
  }

  let presignedUrl: string;
  try {
    presignedUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: facts.sourceBucket, Key: facts.sourceKey }),
      { expiresIn: 900 },
    );
  } catch (err) {
    return toolError(
      "presign_failed",
      `Could not open the source video: ${errorMessage(err)}`,
      "Use watch_clip or read_transcript instead for now.",
      { detail: errorMessage(err), retryable: true },
    );
  }

  const extracted = await mapWithConcurrency(
    timestamps,
    EXTRACT_CONCURRENCY,
    async (ts) => {
      try {
        const base64 = await getFrame({
          assetId: facts.assetId,
          timestampSec: ts,
          presignedUrl,
          cacheBucket,
        });
        return { ts, base64 };
      } catch (err) {
        return { ts, error: errorMessage(err) };
      }
    },
  );

  const images: ToolImage[] = [];
  const failures: string[] = [];

  for (const item of extracted) {
    if ("base64" in item && item.base64) {
      images.push({
        mediaType: "image/jpeg",
        base64: item.base64,
        label: `${fmtTimecode(item.ts)} (${item.ts.toFixed(1)}s)`,
      });
    } else {
      failures.push(`${fmtTimecode(item.ts)}: ${(item as { error?: string }).error ?? "no frame"}`);
    }
  }

  if (images.length === 0) {
    const detail = failures.join("; ");
    // A missing binary fails identically at every timestamp, and telling the
    // model to "try different timestamps" sends it round that loop forever.
    if (/ENOENT|EACCES|spawn/i.test(detail)) {
      return toolError(
        "ffmpeg_unavailable",
        "The frame extractor is not available in this environment, so view_frames cannot run at all right now.",
        "Do not retry view_frames this run. Use watch_clip to see what happens on screen, and read_transcript for what is said.",
        { detail },
      );
    }
    return toolError(
      "extract_failed",
      `No frames could be extracted. ${detail}`,
      "The timestamps may be past the end of the file or the source may be unreadable. Try different timestamps, or use watch_clip instead.",
      { detail, retryable: true },
    );
  }

  if (failures.length > 0) {
    warnings.push(`${failures.length} frame(s) failed: ${failures.join("; ")}`);
  }

  const list = images.map((img) => img.label).join(", ");

  return {
    ok: true,
    text: `${images.length} frame(s) at ${list}. You are checking: ${params.purpose}. The images follow in order.`,
    summary: `Looked at ${images.length} frame${images.length === 1 ? "" : "s"} · ${truncate(params.purpose, 50)}`,
    digest: {
      timestamps: images.map((i) => i.label),
      purpose: params.purpose.slice(0, 100),
    },
    warnings: warnings.length > 0 ? warnings : undefined,
    images,
  };
}

async function getFrame(params: {
  assetId: string;
  timestampSec: number;
  presignedUrl: string;
  cacheBucket?: string;
}): Promise<string> {
  const { assetId, timestampSec, presignedUrl, cacheBucket } = params;
  const rounded = Math.round(timestampSec * 10) / 10;
  // Keyed by render size: changing it must not keep serving the old images.
  const cacheKey = `agent/frames/${assetId}/${FRAME_MAX_EDGE_PX}/${rounded.toFixed(1)}.jpg`;

  if (cacheBucket) {
    const cached = await readFrameCache(cacheBucket, cacheKey);
    if (cached) return cached;
  }

  const tmpPath = `/tmp/iq-frame-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
  const args = [
    "-ss",
    rounded.toFixed(3),
    "-i",
    presignedUrl,
    "-vframes",
    "1",
    "-vf",
    `scale='min(${FRAME_MAX_EDGE_PX},iw)':-2`,
    "-q:v",
    "3",
    "-y",
    tmpPath,
  ];

  try {
    await execFileAsync(FFMPEG_PATH, args, { timeout: FRAME_TIMEOUT_MS });
    const buffer = await fs.promises.readFile(tmpPath);
    if (buffer.length === 0) throw new Error("ffmpeg produced an empty frame");
    const base64 = buffer.toString("base64");

    if (cacheBucket) {
      await s3Client
        .send(
          new PutObjectCommand({
            Bucket: cacheBucket,
            Key: cacheKey,
            Body: buffer,
            ContentType: "image/jpeg",
          }),
        )
        .catch((err) =>
          console.warn(`[IQAgent] frame cache write failed: ${errorMessage(err)}`),
        );
    }

    return base64;
  } finally {
    await fs.promises.unlink(tmpPath).catch(() => undefined);
  }
}

async function readFrameCache(
  bucket: string,
  key: string,
): Promise<string | null> {
  try {
    const response = await s3Client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    const bytes = await response.Body?.transformToByteArray();
    if (!bytes || bytes.length === 0) return null;
    return Buffer.from(bytes).toString("base64");
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name !== "NoSuchKey" && name !== "NotFound") {
      console.warn(`[IQAgent] frame cache read failed: ${errorMessage(err)}`);
    }
    return null;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
