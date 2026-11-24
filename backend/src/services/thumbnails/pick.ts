/**
 * Per-scene thumbnail selection (Qlio Thumbnail Runbook Steps 3–7):
 * pull candidates at 2 fps inside the scene, filter them in code, have Claude
 * score the survivors against the scene brief, keep the best few, and export
 * the chosen frame as a 1920×1080 JPEG. The whole-title pass (Step 6b) is in
 * setPass.ts.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  SPORELABS_SONNET_MODEL,
  sporelabsChatCompletions,
  type SporeLabsContentPart,
} from "../sporelabs";
import {
  brightnessLift,
  candidateFps,
  crop16x9,
  differenceHash,
  filterCandidates,
  laplacianVariance,
  meanLuma,
  safeWindow,
  TARGET_HEIGHT,
  TARGET_WIDTH,
  upscalePlan,
  type CandidateStats,
  type Crop,
  type FacePosition,
  type GrayFrame,
} from "./frameMath";
import {
  rankCandidates,
  baseTotal,
  type BalanceCandidate,
  type CandidateScores,
  type CandidateAttributes,
} from "./balance";
import { SCENE_SCORING_SYSTEM, sceneScoringUser } from "./prompts";

const execFileAsync = promisify(execFile);
const s3 = new S3Client({});
const FFMPEG_PATH = process.env.FFMPEG_PATH || "/opt/bin/ffmpeg";
const FFPROBE_PATH = process.env.FFPROBE_PATH || "/opt/bin/ffprobe";

import { THUMBNAIL_PICK_VERSION } from "./frameMath";
export { THUMBNAIL_PICK_VERSION };
/** Candidates kept per scene after scoring, for the set pass and review. */
const KEEP_PER_SCENE = 4;
const PREVIEW_WIDTH = 512;
const ANALYSIS_W = 160;
const ANALYSIS_H = 90;

export interface StoredThumbnailCandidate extends BalanceCandidate {
  face: FacePosition | null;
  total: number;
  note: string;
  /** 512 px preview, for the set pass and the contact sheet. */
  previewKey: string;
}

export interface ThumbnailExport {
  time: number;
  crop: Crop;
  frameWidth: number;
  frameHeight: number;
  sarCorrected: boolean;
  upscale: { method: string; factor: number; source_crop: string; sar_corrected: boolean };
  brightness: { gamma: number; mean_luma_before: number; mean_luma_after: number } | null;
}

export interface StoredThumbnailPick {
  version: number;
  contentHash: string;
  brief: {
    emotion: string;
    spoiler_sensitivity: "High" | "Medium" | "Low";
    title_line: string | null;
    title_line_time: number | null;
    turn_time: number | null;
  };
  candidates: StoredThumbnailCandidate[];
  chosen: number;
  runnerUp: number;
  pulled: number;
  scored: number;
  rejected: Array<{ time: number; reason: string }>;
  flags: string[];
  rationale: string;
  /** What was last written to thumbnailKey. */
  exported?: ThumbnailExport;
  /** Criterion 9, from the set pass. */
  variety?: number;
}

export interface SourceInfo {
  width: number;
  height: number;
  /** Sample aspect ratio (pixel width ÷ height). */
  sar: number;
}

export async function probeSource(url: string): Promise<SourceInfo> {
  const { stdout } = await execFileAsync(
    FFPROBE_PATH,
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,sample_aspect_ratio", "-of", "json", url],
    { timeout: 60_000 },
  );
  const stream = JSON.parse(stdout).streams?.[0] ?? {};
  const [n, d] = String(stream.sample_aspect_ratio ?? "1:1").split(":").map(Number);
  const sar = n > 0 && d > 0 ? n / d : 1;
  return { width: Number(stream.width) || 1920, height: Number(stream.height) || 1080, sar };
}

/** Square-pixel conversion first (Uprez step 1). */
const SQUARE_PIXELS = "scale=trunc(iw*sar/2)*2:ih,setsar=1";

export async function pullCandidates(
  url: string,
  start: number,
  end: number,
  dir: string,
): Promise<number[]> {
  const fps = candidateFps(end - start);
  await execFileAsync(
    FFMPEG_PATH,
    [
      "-v", "error",
      "-ss", start.toFixed(3),
      "-t", (end - start).toFixed(3),
      "-i", url,
      "-vf", `${SQUARE_PIXELS},fps=${fps.toFixed(4)},scale=${PREVIEW_WIDTH}:-2`,
      "-q:v", "3",
      path.join(dir, "%04d.jpg"),
    ],
    { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 },
  );
  const files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".jpg")).sort();
  return files.map((_, i) => start + i / fps);
}

export async function grayFrames(pattern: string, count: number): Promise<GrayFrame[]> {
  if (count === 0) return [];
  const { stdout } = await execFileAsync(
    FFMPEG_PATH,
    ["-v", "error", "-i", pattern, "-vf", `scale=${ANALYSIS_W}:${ANALYSIS_H},format=gray`, "-f", "rawvideo", "pipe:1"],
    { encoding: "buffer", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const size = ANALYSIS_W * ANALYSIS_H;
  const frames: GrayFrame[] = [];
  for (let i = 0; i < count && (i + 1) * size <= stdout.length; i++) {
    frames.push({ width: ANALYSIS_W, height: ANALYSIS_H, data: new Uint8Array(stdout.subarray(i * size, (i + 1) * size)) });
  }
  return frames;
}

interface ModelCandidate {
  n: number;
  usable?: boolean;
  reject_reason?: string | null;
  face_count?: number;
  eyes_open?: boolean;
  burned_text?: boolean;
  spoils?: boolean;
  unsafe?: boolean;
  source?: string;
  face?: { x?: number; y?: number; h?: number } | null;
  subject?: string;
  look?: string;
  setting?: string;
  shot?: string;
  emotion?: string;
  scores?: Partial<CandidateScores>;
  note?: string;
}

interface ModelReply {
  brief?: Partial<StoredThumbnailPick["brief"]>;
  candidates?: ModelCandidate[];
  rationale?: string;
}

function parseJson(text: string): ModelReply {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Thumbnail scoring returned no JSON");
  return JSON.parse(text.slice(start, end + 1)) as ModelReply;
}

const clampScore = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback;
};
const clamp01 = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
};
const SHOTS = new Set(["close-up", "two-shot", "wide"]);
const SOURCES = new Set(["cast", "presenter", "other_material"]);

/** Turn the model's judgments into eligible, ranked candidates (pure). */
export function judgeCandidates(
  reply: ModelReply,
  times: number[],
  previewKeys: string[],
): {
  ranked: StoredThumbnailCandidate[];
  rejected: Array<{ time: number; reason: string }>;
} {
  const rejected: Array<{ time: number; reason: string }> = [];
  const eligible: StoredThumbnailCandidate[] = [];
  const turn = Number(reply.brief?.turn_time);
  const high = reply.brief?.spoiler_sensitivity === "High";
  for (const c of reply.candidates ?? []) {
    const i = Number(c.n) - 1;
    if (!(i >= 0 && i < times.length)) continue;
    const time = times[i];
    const source = SOURCES.has(String(c.source)) ? (c.source as CandidateAttributes["source"]) : "cast";
    const faceless = !c.face_count;
    const reason =
      c.unsafe ? "content limits"
      : c.spoils ? "spoiler"
      : high && Number.isFinite(turn) && time >= turn ? "after the turn of a High scene"
      : c.burned_text ? "burned-in text"
      : c.eyes_open === false ? "eyes closed"
      : faceless && source !== "other_material" ? "no usable face"
      : c.usable === false ? c.reject_reason || "unusable"
      : null;
    if (reason) {
      rejected.push({ time, reason });
      continue;
    }
    const s = c.scores ?? {};
    const scores: CandidateScores = {
      face_emotion: clampScore(s.face_emotion, 1, 5, 1),
      reads_small: clampScore(s.reads_small, 1, 5, 1),
      focal_point: clampScore(s.focal_point, 1, 5, 1),
      character: clampScore(s.character, 1, 5, 3),
      title_tie: clampScore(s.title_tie, 1, 5, 1),
      tone: clampScore(s.tone, 1, 5, 1),
      crop_16x9: clampScore(s.crop_16x9, 1, 5, 1),
      eye_contact: clampScore(s.eye_contact, 0, 5, 0),
    };
    const x = clamp01(c.face?.x);
    const y = clamp01(c.face?.y);
    eligible.push({
      time,
      scores,
      attrs: {
        subject: String(c.subject || "unknown").slice(0, 80),
        look: String(c.look || "").slice(0, 80),
        setting: String(c.setting || "").slice(0, 60),
        shot: SHOTS.has(String(c.shot)) ? (c.shot as CandidateAttributes["shot"]) : "close-up",
        emotion: String(c.emotion || "").toLowerCase().slice(0, 30),
        source,
        gender: "unknown",
      },
      face: x != null && y != null ? { x, y, h: clamp01(c.face?.h) ?? undefined } : null,
      total: baseTotal(scores),
      note: String(c.note || "").slice(0, 200),
      previewKey: previewKeys[i],
    });
  }
  const ranked = rankCandidates(eligible) as StoredThumbnailCandidate[];
  return { ranked, rejected };
}

function transcriptExcerpt(
  words: Array<{ start: number; end: number; text: string }>,
  start: number,
  end: number,
): string {
  const inScene = words.filter((w) => w.end > start && w.start < end);
  const lines: string[] = [];
  let line: string[] = [];
  let lineStart = inScene[0]?.start ?? start;
  for (const w of inScene) {
    if (line.length && (w.start - lineStart > 6 || line.length >= 18)) {
      lines.push(`[${lineStart.toFixed(1)}] ${line.join(" ")}`);
      line = [];
      lineStart = w.start;
    }
    line.push(w.text);
  }
  if (line.length) lines.push(`[${lineStart.toFixed(1)}] ${line.join(" ")}`);
  return lines.join("\n").slice(0, 12_000);
}

export interface PickSceneParams {
  analysisUrl: string;
  bucket: string;
  projectId: string;
  segmentId: string;
  contentHash: string;
  sceneNumber: number;
  sceneTitle: string;
  sceneStart: number;
  sceneEnd: number;
  showTitle: string | null;
  descriptions: string[];
  transcriptWords: Array<{ start: number; end: number; text: string }>;
}

/** Steps 3–6 for one scene. Throws only on infrastructure failures. */
export async function pickSceneThumbnail(p: PickSceneParams): Promise<StoredThumbnailPick> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "thumbs-"));
  try {
    const win = safeWindow(p.sceneStart, p.sceneEnd);
    const times = await pullCandidates(p.analysisUrl, win.start, win.end, dir);
    const gray = await grayFrames(path.join(dir, "%04d.jpg"), times.length);
    const stats: CandidateStats[] = gray.map((g, i) => ({
      time: times[i],
      luma: meanLuma(g),
      sharpness: laplacianVariance(g),
      hash: differenceHash(g),
    }));
    const filtered = filterCandidates(stats);
    const flags: string[] = [];
    if (filtered.kept.length < 3) flags.push(`only ${filtered.kept.length} usable candidates after filters`);

    const keptFiles = filtered.kept.map((k) => path.join(dir, `${String(times.indexOf(k.time) + 1).padStart(4, "0")}.jpg`));
    const images = await Promise.all(keptFiles.map((f) => fs.promises.readFile(f)));
    const previewKeys = filtered.kept.map(
      (k) => `thumbnails/projects/${p.projectId}/candidates/${p.segmentId}/${k.time.toFixed(3)}.jpg`,
    );

    let reply: ModelReply = { candidates: [] };
    if (images.length > 0) {
      const content: SporeLabsContentPart[] = [
        {
          type: "text",
          text: sceneScoringUser({
            showTitle: p.showTitle,
            sceneNumber: p.sceneNumber,
            sceneTitle: p.sceneTitle,
            sceneStart: p.sceneStart,
            sceneEnd: p.sceneEnd,
            descriptions: p.descriptions,
            transcript: transcriptExcerpt(p.transcriptWords, p.sceneStart, p.sceneEnd),
            candidateTimes: filtered.kept.map((k) => k.time),
          }),
        },
      ];
      images.forEach((img, i) => {
        content.push({ type: "text", text: `#${i + 1}` });
        content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${img.toString("base64")}` } });
      });
      const result = await sporelabsChatCompletions({
        model: SPORELABS_SONNET_MODEL,
        messages: [
          { role: "system", content: SCENE_SCORING_SYSTEM },
          { role: "user", content },
        ],
        maxTokens: 6000,
        temperature: 0,
        timeoutMs: 150_000,
        attempts: 2,
      });
      reply = parseJson(String(result.content ?? ""));
    }

    const judged = judgeCandidates(reply, filtered.kept.map((k) => k.time), previewKeys);
    const ranked = judged.ranked.slice(0, KEEP_PER_SCENE);

    // Upload previews of the kept candidates (set pass and contact sheet)
    await Promise.all(
      ranked.map((c) => {
        const i = filtered.kept.findIndex((k) => k.time === c.time);
        return s3.send(new PutObjectCommand({ Bucket: p.bucket, Key: c.previewKey, Body: images[i], ContentType: "image/jpeg" }));
      }),
    );

    if (ranked.length === 0) flags.push("no usable candidate: needs a human pick");
    else if (ranked[0].scores.face_emotion < 3) flags.push("weak: no candidate scores 3 on face and emotion");
    if (ranked.length && ranked[0].scores.title_tie <= 2) flags.push("untied");

    const brief = reply.brief ?? {};
    return {
      version: THUMBNAIL_PICK_VERSION,
      contentHash: p.contentHash,
      brief: {
        emotion: String(brief.emotion || ""),
        spoiler_sensitivity:
          brief.spoiler_sensitivity === "High" || brief.spoiler_sensitivity === "Medium" ? brief.spoiler_sensitivity : "Low",
        title_line: brief.title_line ? String(brief.title_line) : null,
        title_line_time: Number.isFinite(Number(brief.title_line_time)) ? Number(brief.title_line_time) : null,
        turn_time: Number.isFinite(Number(brief.turn_time)) ? Number(brief.turn_time) : null,
      },
      candidates: ranked,
      chosen: ranked.length ? 0 : -1,
      runnerUp: ranked.length > 1 ? 1 : -1,
      pulled: times.length,
      scored: filtered.kept.length,
      rejected: [...filtered.rejected, ...judged.rejected]
        .filter((r) => r.reason !== "not needed for spread")
        .slice(0, 40),
      flags,
      rationale: String(reply.rationale || "").slice(0, 400),
    };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Step 7: cut the 16:9 crop from the source at full resolution, scale to
 * 1920×1080 (Lanczos), apply the brightness lift if the crop is dark, and
 * write a baseline sRGB JPEG with metadata stripped.
 */
export async function exportThumbnail(params: {
  sourceUrl: string;
  source: SourceInfo;
  time: number;
  face: FacePosition | null;
  bucket: string;
  key: string;
}): Promise<ThumbnailExport> {
  const tmp = path.join(os.tmpdir(), `thumb-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  try {
    const meta = await renderThumbnail({ ...params, outFile: tmp });
    await s3.send(
      new PutObjectCommand({
        Bucket: params.bucket,
        Key: params.key,
        Body: await fs.promises.readFile(tmp),
        ContentType: "image/jpeg",
      }),
    );
    return meta;
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

/** Step 7 to a local JPEG (exportThumbnail uploads it). */
export async function renderThumbnail(params: {
  sourceUrl: string;
  source: SourceInfo;
  time: number;
  face: FacePosition | null;
  outFile: string;
}): Promise<ThumbnailExport> {
  const { source } = params;
  const frameWidth = Math.round((source.width * source.sar) / 2) * 2;
  const frameHeight = source.height;
  const crop = crop16x9(frameWidth, frameHeight, params.face);
  const cropFilter = `${SQUARE_PIXELS},crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`;
  const seek = ["-ss", params.time.toFixed(3), "-i", params.sourceUrl, "-frames:v", "1"];

  // Measure the crop for the brightness rule
  const { stdout } = await execFileAsync(
    FFMPEG_PATH,
    ["-v", "error", ...seek, "-vf", `${cropFilter},scale=${ANALYSIS_W}:${ANALYSIS_H},format=gray`, "-f", "rawvideo", "pipe:1"],
    { encoding: "buffer", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const lift = brightnessLift({ width: ANALYSIS_W, height: ANALYSIS_H, data: new Uint8Array(stdout) });
  const gammaFilter = lift
    ? `,lutrgb=r='255*pow(val/255\\,1/${lift.gamma})':g='255*pow(val/255\\,1/${lift.gamma})':b='255*pow(val/255\\,1/${lift.gamma})'`
    : "";

  const plan = upscalePlan(crop.width);
  await execFileAsync(
    FFMPEG_PATH,
    [
      "-v", "error", ...seek,
      "-vf", `${cropFilter},scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:flags=lanczos${gammaFilter},format=yuvj420p`,
      "-map_metadata", "-1",
      "-q:v", "2",
      "-y", params.outFile,
    ],
    { timeout: 120_000 },
  );
  return {
    time: params.time,
    crop,
    frameWidth,
    frameHeight,
    sarCorrected: Math.abs(source.sar - 1) > 1e-3,
    upscale: {
      method: plan.method,
      factor: plan.factor,
      source_crop: `${crop.width}x${crop.height}`,
      sar_corrected: Math.abs(source.sar - 1) > 1e-3,
    },
    brightness: lift
      ? { gamma: lift.gamma, mean_luma_before: lift.meanLumaBefore, mean_luma_after: lift.meanLumaAfter }
      : null,
  };
}

/** Flag lines for an export (upscale fallback). */
export function exportFlags(e: ThumbnailExport): string[] {
  const plan = upscalePlan(e.crop.width);
  return plan.flag ? [plan.flag] : [];
}
