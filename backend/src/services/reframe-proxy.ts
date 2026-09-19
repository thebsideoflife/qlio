/**
 * 360p video-only proxy for shot-hold reframing (`proxy/<assetId>.mp4`).
 *
 * SporeLabs downloads this instead of the master. It MUST keep every source
 * frame at its source timestamp (no fps filter, passthrough) so proxy frame N
 * is source frame N — the same integer grid the editor and export use.
 *
 * Built from the RAW asset key (never `annotated/`, which has burned overlays),
 * reading the master straight from a presigned URL so a 1h master never lands
 * in /tmp. A 1h mezzanine master is too much decode for one Lambda inside 15
 * minutes, so long sources fan out: each worker (this same Lambda, invoked with
 * `isProxyChunk`) encodes a frame-exact slice, and the parts are joined with
 * the concat demuxer (`-c copy`, no re-encode).
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { createReadStream, createWriteStream, promises as fs } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import * as path from "path";

const FFMPEG_PATH = process.env.FFMPEG_PATH || "/opt/bin/ffmpeg";
const FFPROBE_PATH = process.env.FFPROBE_PATH || "/opt/bin/ffprobe";

/** Bump when encode settings change; a stale proxy is rebuilt (new ETag → new SporeLabs cache key). */
export const PROXY_VERSION = "2";
export const PROXY_HEIGHT = 360;
/** SporeLabs fetches the proxy once, shortly after submit. */
export const PROXY_URL_TTL_SEC = 20 * 60;
/** Master read URL: long enough for ffmpeg's range requests over a whole slice. */
const SOURCE_URL_TTL_SEC = 60 * 60;

/** ≈ 6 min of 1080p24 per worker. Scales down for 4K / high-fps sources. */
const TARGET_CHUNK_PIXELS = 360 * 24 * 1920 * 1080;
const MIN_CHUNK_SEC = 60;
const MAX_CHUNK_SEC = 600;
const MAX_CHUNKS = 40;
const CHUNK_CONCURRENCY = 16;
const HEARTBEAT_MS = 30_000;
/** Leave the caller room to mark the job failed before Lambda kills us. */
const DEADLINE_MARGIN_MS = 45_000;

export function proxyKeyForAsset(assetId: string): string {
  return `proxy/${assetId}.mp4`;
}

// ============================================================================
// FPS / PROBE
// ============================================================================

/**
 * Mirror of zeevee/src/lib/sourceFps.ts and cutSegments.ts canonicalizeFps.
 * The fps we send SporeLabs must be the same grid the editor and export use.
 */
const CANONICAL_FPS = [
  24000 / 1001,
  24,
  25,
  30000 / 1001,
  30,
  50,
  60000 / 1001,
  60,
  120000 / 1001,
  120,
];
const CANONICAL_FPS_MAX_DELTA = 0.012;

export function canonicalizeFps(fps: number): number {
  let best = fps;
  let bestDelta = CANONICAL_FPS_MAX_DELTA;
  for (const candidate of CANONICAL_FPS) {
    const delta = Math.abs(fps - candidate);
    if (delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }
  return best;
}

function parseFrameRate(raw?: string): number | null {
  if (!raw) return null;
  const [num, den] = raw.split("/").map(Number);
  const value = den ? num / den : num;
  return Number.isFinite(value) && value > 0 ? value : null;
}

export interface SourceVideoInfo {
  fps: number;
  width: number;
  height: number;
  /** Seconds; NaN when the container does not say. */
  durationSec: number;
  /** Container frame count when present (mp4 stts); otherwise null. */
  frameCount: number | null;
}

/** Same stream fields and precedence as cutSegments.probeSourceVideo (export). */
export async function probeSourceVideo(input: string): Promise<SourceVideoInfo> {
  const { stdout } = await runTool(
    FFPROBE_PATH,
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries",
      "stream=width,height,r_frame_rate,avg_frame_rate,nb_frames:format=duration",
      "-of", "json",
      input,
    ],
    60_000,
    input,
  );
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{
      width?: number;
      height?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
      nb_frames?: string;
    }>;
    format?: { duration?: string };
  };
  const stream = parsed.streams?.[0];
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  if (!(width > 0) || !(height > 0)) {
    throw new Error("ffprobe could not read source video dimensions");
  }
  const fps =
    parseFrameRate(stream?.avg_frame_rate) ??
    parseFrameRate(stream?.r_frame_rate);
  if (!(fps && fps > 0)) {
    throw new Error("ffprobe could not read source frame rate");
  }
  const nbFrames = Number(stream?.nb_frames);
  return {
    fps: canonicalizeFps(fps),
    width,
    height,
    durationSec: Number(parsed.format?.duration),
    frameCount: Number.isInteger(nbFrames) && nbFrames > 0 ? nbFrames : null,
  };
}

// ============================================================================
// PLANNING + ENCODE ARGS (pure)
// ============================================================================

export interface ProxyChunkPlan {
  index: number;
  startFrame: number;
  /** null = encode to end of source. */
  frameCount: number | null;
}

/**
 * Split the source into frame-exact slices. The last slice runs to EOF and
 * absorbs the remainder (0.5× to 1.5× a chunk), so a duration estimate that is
 * a little long never yields an empty trailing slice.
 */
export function planProxyChunks(info: SourceVideoInfo): ProxyChunkPlan[] {
  const totalFrames =
    info.frameCount ??
    (Number.isFinite(info.durationSec) && info.durationSec > 0
      ? Math.floor(info.durationSec * info.fps)
      : 0);
  const minFrames = Math.round(MIN_CHUNK_SEC * info.fps);
  const maxFrames = Math.round(MAX_CHUNK_SEC * info.fps);
  let chunkFrames = Math.min(
    maxFrames,
    Math.max(minFrames, Math.floor(TARGET_CHUNK_PIXELS / (info.width * info.height))),
  );
  let count = totalFrames > 0 ? Math.round(totalFrames / chunkFrames) : 1;
  if (count > MAX_CHUNKS) {
    count = MAX_CHUNKS;
    chunkFrames = Math.floor(totalFrames / MAX_CHUNKS);
  }
  if (count <= 1) return [{ index: 0, startFrame: 0, frameCount: null }];
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    startFrame: i * chunkFrames,
    frameCount: i === count - 1 ? null : chunkFrames,
  }));
}

/**
 * ffmpeg args for one slice (or the whole proxy). Input seek lands half a frame
 * before `startFrame`, so accurate seek drops frame startFrame-1 and keeps
 * startFrame; `-frames:v` stops exactly at the next slice's first frame.
 */
export function buildProxyEncodeArgs(params: {
  inputUrl: string;
  outputPath: string;
  fps: number;
  startFrame: number;
  frameCount: number | null;
}): string[] {
  const { inputUrl, outputPath, fps, startFrame, frameCount } = params;
  const seek =
    startFrame > 0 ? ["-ss", ((startFrame - 0.5) / fps).toFixed(6)] : [];
  const limit = frameCount != null ? ["-frames:v", String(frameCount)] : [];
  return [
    "-hide_banner",
    "-nostdin",
    "-v", "error",
    "-y",
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "10",
    "-rw_timeout", "30000000",
    ...seek,
    "-i", inputUrl,
    "-map", "0:v:0",
    "-an", "-sn", "-dn",
    "-vf", `scale=-2:${PROXY_HEIGHT}`,
    "-fps_mode", "passthrough",
    "-c:v", "libx264",
    "-preset", "veryfast",
    // 23, not 28: on Nashville, crf 28 moved 30 of 679 holds off the reviewed
    // result (softer faces shift the focus cue); 23 moved 18, at ~190 MB/hour.
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    ...limit,
    "-movflags", "+faststart",
    outputPath,
  ];
}

// ============================================================================
// PROCESS HELPERS
// ============================================================================

/** Strip presigned URLs from tool output before it reaches a log or an error. */
function redact(text: string, secret?: string): string {
  let out = secret ? text.split(secret).join("<source-url>") : text;
  out = out.replace(/https?:\/\/\S+/g, "<url>");
  return out;
}

function runTool(
  bin: string,
  args: string[],
  timeoutMs: number,
  secretArg?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Math.max(1_000, timeoutMs));
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`${path.basename(bin)} failed to start: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const tail = redact(stderr.trim(), secretArg).slice(-800);
      if (timedOut) {
        reject(
          new Error(
            `${path.basename(bin)} exceeded its ${Math.round(timeoutMs / 1000)}s budget`,
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(new Error(`${path.basename(bin)} exited ${code}: ${tail}`));
        return;
      }
      resolve({ stdout, stderr: tail });
    });
  });
}

async function countVideoPackets(filePath: string): Promise<number> {
  const { stdout } = await runTool(
    FFPROBE_PATH,
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-count_packets",
      "-show_entries", "stream=nb_read_packets",
      "-of", "csv=p=0",
      filePath,
    ],
    120_000,
  );
  const n = parseInt(stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

function withHeartbeat<T>(
  onHeartbeat: (() => Promise<unknown>) | undefined,
  work: Promise<T>,
): Promise<T> {
  if (!onHeartbeat) return work;
  const timer = setInterval(() => {
    onHeartbeat().catch(() => {});
  }, HEARTBEAT_MS);
  return work.finally(() => clearInterval(timer));
}

async function presignGet(
  s3: S3Client,
  bucket: string,
  key: string,
  expiresIn: number,
): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn,
  });
}

// ============================================================================
// CHUNK WORKER (runs in its own invocation)
// ============================================================================

export interface ProxyChunkPayload {
  isProxyChunk: true;
  bucket: string;
  rawKey: string;
  partKey: string;
  fps: number;
  startFrame: number;
  frameCount: number | null;
}

export interface ProxyChunkResult {
  partKey: string;
  frames: number;
}

export async function runProxyChunk(
  s3: S3Client,
  payload: ProxyChunkPayload,
  remainingMs: number,
): Promise<ProxyChunkResult> {
  const sourceUrl = await presignGet(s3, payload.bucket, payload.rawKey, SOURCE_URL_TTL_SEC);
  const outPath = `/tmp/proxy-part-${randomUUID()}.mp4`;
  try {
    const started = Date.now();
    await runTool(
      FFMPEG_PATH,
      buildProxyEncodeArgs({
        inputUrl: sourceUrl,
        outputPath: outPath,
        fps: payload.fps,
        startFrame: payload.startFrame,
        frameCount: payload.frameCount,
      }),
      remainingMs - DEADLINE_MARGIN_MS,
      sourceUrl,
    );
    const frames = await countVideoPackets(outPath);
    await new Upload({
      client: s3,
      params: {
        Bucket: payload.bucket,
        Key: payload.partKey,
        Body: createReadStream(outPath),
        ContentType: "video/mp4",
      },
    }).done();
    console.log(
      `[Proxy] Part ${payload.partKey}: frames ${payload.startFrame}+${frames} in ${Math.round((Date.now() - started) / 1000)}s`,
    );
    return { partKey: payload.partKey, frames };
  } finally {
    await fs.rm(outPath, { force: true }).catch(() => {});
  }
}

// ============================================================================
// ORCHESTRATOR
// ============================================================================

export interface ReframeProxy {
  key: string;
  /** Without quotes. */
  etag: string;
  /** Presigned GET, PROXY_URL_TTL_SEC. Never log. */
  url: string;
  fps: number;
  width: number;
  height: number;
  reused: boolean;
}

export interface EnsureProxyParams {
  s3: S3Client;
  lambda: LambdaClient;
  bucket: string;
  assetId: string;
  rawKey: string;
  /** This Lambda; chunk workers are self-invocations. */
  selfFunctionName?: string;
  /** Epoch ms by which this call must return. */
  deadlineAt: number;
  onHeartbeat?: () => Promise<unknown>;
}

function stripQuotes(etag?: string): string {
  return (etag ?? "").replace(/"/g, "");
}

async function headOrNull(s3: S3Client, bucket: string, key: string) {
  try {
    return await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err: any) {
    const status = err?.$metadata?.httpStatusCode;
    if (err?.name === "NotFound" || status === 404) return null;
    throw err;
  }
}

function infoFromMetadata(meta?: Record<string, string>): SourceVideoInfo | null {
  const fps = Number(meta?.fps);
  const width = Number(meta?.width);
  const height = Number(meta?.height);
  if (!(fps > 0) || !(width > 0) || !(height > 0)) return null;
  return { fps, width, height, durationSec: NaN, frameCount: null };
}

export async function ensureReframeProxy(
  params: EnsureProxyParams,
): Promise<ReframeProxy> {
  const { s3, bucket, assetId, rawKey } = params;
  const proxyKey = proxyKeyForAsset(assetId);

  const rawHead = await headOrNull(s3, bucket, rawKey);
  if (!rawHead) throw new Error(`Source video not found in S3 for asset ${assetId}`);
  const sourceEtag = stripQuotes(rawHead.ETag);

  const existing = await headOrNull(s3, bucket, proxyKey);
  if (
    existing &&
    existing.Metadata?.["proxy-version"] === PROXY_VERSION &&
    existing.Metadata?.["source-etag"] === sourceEtag
  ) {
    let info = infoFromMetadata(existing.Metadata);
    if (!info) {
      info = await probeSourceVideo(
        await presignGet(s3, bucket, rawKey, SOURCE_URL_TTL_SEC),
      );
    }
    console.log(`[Proxy] Reusing ${proxyKey} (fps ${info.fps}, ${info.width}x${info.height})`);
    return {
      key: proxyKey,
      etag: stripQuotes(existing.ETag),
      url: await presignGet(s3, bucket, proxyKey, PROXY_URL_TTL_SEC),
      fps: info.fps,
      width: info.width,
      height: info.height,
      reused: true,
    };
  }

  const sourceUrl = await presignGet(s3, bucket, rawKey, SOURCE_URL_TTL_SEC);
  const info = await probeSourceVideo(sourceUrl);
  const plan = planProxyChunks(info);
  const token = randomUUID();
  const workDir = `/tmp/proxy-${token}`;
  const outPath = path.join(workDir, "proxy.mp4");
  await fs.mkdir(workDir, { recursive: true });

  const started = Date.now();
  console.log(
    `[Proxy] Building ${proxyKey}: ${info.width}x${info.height} @ ${info.fps.toFixed(3)}fps, ` +
      `${Number.isFinite(info.durationSec) ? info.durationSec.toFixed(0) : "?"}s, ${plan.length} slice(s)`,
  );

  const partKeys: string[] = [];
  try {
    const budgetMs = () => params.deadlineAt - Date.now() - DEADLINE_MARGIN_MS;
    if (plan.length === 1) {
      await withHeartbeat(
        params.onHeartbeat,
        runTool(
          FFMPEG_PATH,
          buildProxyEncodeArgs({
            inputUrl: sourceUrl,
            outputPath: outPath,
            fps: info.fps,
            startFrame: 0,
            frameCount: null,
          }),
          budgetMs(),
          sourceUrl,
        ),
      );
    } else {
      const results = await withHeartbeat(
        params.onHeartbeat,
        encodeSlicesInParallel(params, info, plan, token, partKeys),
      );
      // Every slice but the last must be exactly full, or frame N would drift.
      for (const r of results.slice(0, -1)) {
        const expected = plan[r.index].frameCount;
        if (r.frames !== expected) {
          throw new Error(
            `Proxy slice ${r.index} has ${r.frames} frames, expected ${expected}`,
          );
        }
      }
      const listPath = path.join(workDir, "parts.txt");
      const lines: string[] = [];
      for (const r of results) {
        const local = path.join(workDir, `part-${r.index}.mp4`);
        const obj = await s3.send(
          new GetObjectCommand({ Bucket: bucket, Key: r.partKey }),
        );
        await pipeline(obj.Body as Readable, createWriteStream(local));
        lines.push(`file '${local}'`);
      }
      await fs.writeFile(listPath, lines.join("\n") + "\n");
      await runTool(
        FFMPEG_PATH,
        [
          "-hide_banner", "-nostdin", "-v", "error", "-y",
          "-f", "concat", "-safe", "0", "-i", listPath,
          "-c", "copy",
          "-movflags", "+faststart",
          outPath,
        ],
        budgetMs(),
      );
      for (const r of results) {
        await fs.rm(path.join(workDir, `part-${r.index}.mp4`), { force: true });
      }
    }

    const frames = await countVideoPackets(outPath);
    if (info.frameCount != null && frames !== info.frameCount) {
      // Containers with edit lists can report a different count; flag, don't fail.
      console.warn(
        `[Proxy] ${proxyKey}: ${frames} frames vs source container nb_frames ${info.frameCount}`,
      );
    }

    await new Upload({
      client: s3,
      params: {
        Bucket: bucket,
        Key: proxyKey,
        Body: createReadStream(outPath),
        ContentType: "video/mp4",
        Metadata: {
          "proxy-version": PROXY_VERSION,
          "source-etag": sourceEtag,
          fps: String(info.fps),
          width: String(info.width),
          height: String(info.height),
          frames: String(frames),
        },
      },
    }).done();

    const head = await headOrNull(s3, bucket, proxyKey);
    if (!head) throw new Error(`Proxy ${proxyKey} missing right after upload`);
    console.log(
      `[Proxy] Built ${proxyKey}: ${frames} frames, ${Math.round((head.ContentLength ?? 0) / 1e6)}MB in ${Math.round((Date.now() - started) / 1000)}s`,
    );

    return {
      key: proxyKey,
      etag: stripQuotes(head.ETag),
      url: await presignGet(s3, bucket, proxyKey, PROXY_URL_TTL_SEC),
      fps: info.fps,
      width: info.width,
      height: info.height,
      reused: false,
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    await Promise.all(
      partKeys.map((Key) =>
        s3.send(new DeleteObjectCommand({ Bucket: bucket, Key })).catch(() => {}),
      ),
    );
  }
}

async function encodeSlicesInParallel(
  params: EnsureProxyParams,
  info: SourceVideoInfo,
  plan: ProxyChunkPlan[],
  token: string,
  partKeys: string[],
): Promise<Array<ProxyChunkResult & { index: number }>> {
  if (!params.selfFunctionName) {
    throw new Error("AWS_LAMBDA_FUNCTION_NAME is required to fan out proxy slices");
  }
  const results: Array<ProxyChunkResult & { index: number }> = new Array(plan.length);
  const queue = [...plan];

  const invokeOne = async (chunk: ProxyChunkPlan) => {
    const partKey = `proxy/parts/${params.assetId}/${token}/${chunk.index}.mp4`;
    partKeys.push(partKey);
    const payload: ProxyChunkPayload = {
      isProxyChunk: true,
      bucket: params.bucket,
      rawKey: params.rawKey,
      partKey,
      fps: info.fps,
      startFrame: chunk.startFrame,
      frameCount: chunk.frameCount,
    };
    const res = await params.lambda.send(
      new InvokeCommand({
        FunctionName: params.selfFunctionName,
        InvocationType: "RequestResponse",
        Payload: JSON.stringify(payload),
      }),
    );
    const text = res.Payload ? Buffer.from(res.Payload).toString("utf8") : "";
    if (res.FunctionError) {
      let message = text.slice(0, 500);
      try {
        message = JSON.parse(text).errorMessage ?? message;
      } catch {}
      throw new Error(`Proxy slice ${chunk.index} failed: ${redact(message)}`);
    }
    const out = JSON.parse(text) as ProxyChunkResult;
    results[chunk.index] = { ...out, index: chunk.index };
  };

  const workers = Array.from(
    { length: Math.min(CHUNK_CONCURRENCY, queue.length) },
    async () => {
      while (queue.length > 0) {
        await invokeOne(queue.shift()!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
