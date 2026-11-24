/**
 * Pure helpers for the Qlio Thumbnail Runbook: code filters (Step 5), the
 * 16:9 crop (Step 7), the brightness lift, upscale method and file naming.
 * No I/O here, so every rule is unit-tested (scripts/test-thumbnail-math.ts).
 */

/** Bump when selection changes enough that stored picks should be redone. Mirrored in zeevee/src/lib/segmentMetadataFingerprint.ts. */
export const THUMBNAIL_PICK_VERSION = 2;

/** A small grayscale copy of a candidate frame, row-major, 0–255. */
export interface GrayFrame {
  width: number;
  height: number;
  data: Uint8Array;
}

export function meanLuma(frame: GrayFrame): number {
  let sum = 0;
  for (let i = 0; i < frame.data.length; i++) sum += frame.data[i];
  return frame.data.length ? sum / frame.data.length : 0;
}

/** Variance of the 4-neighbour Laplacian: the runbook's blur measure. */
export function laplacianVariance(frame: GrayFrame): number {
  const { width: w, height: h, data } = frame;
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = data[i - w] + data[i + w] + data[i - 1] + data[i + 1] - 4 * data[i];
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** 64-bit difference hash (9×8 box-averaged), as a hex string. */
export function differenceHash(frame: GrayFrame): string {
  const cols = 9;
  const rows = 8;
  const cells: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c * frame.width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((c + 1) * frame.width) / cols));
      const y0 = Math.floor((r * frame.height) / rows);
      const y1 = Math.max(y0 + 1, Math.floor(((r + 1) * frame.height) / rows));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += frame.data[y * frame.width + x];
          n++;
        }
      }
      cells.push(sum / Math.max(1, n));
    }
  }
  let bits = "";
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      bits += cells[r * cols + c] > cells[r * cols + c + 1] ? "1" : "0";
    }
  }
  let hex = "";
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

export function hammingDistance(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d + Math.abs(a.length - b.length) * 4;
}

export interface CandidateStats {
  time: number;
  luma: number;
  sharpness: number;
  hash: string;
}

export interface FilterResult {
  kept: CandidateStats[];
  rejected: Array<{ time: number; reason: string }>;
}

/** Runbook Step 5 thresholds that code can check without face tooling. */
export const BLACK_LUMA = 16;
export const WHITE_LUMA = 240;
export const NEAR_DUPLICATE_DISTANCE = 6;
/**
 * The whole-frame hash cannot see a change of expression in a static shot,
 * so two frames only count as near-duplicates when they are also this close
 * in time. Otherwise a still two-hander would collapse to one candidate.
 */
export const NEAR_DUPLICATE_SECONDS = 2;
/** Sharpness below this (on the small analysis frame) is a soft frame anyway. */
export const SHARPNESS_FLOOR = 15;
export const SHARPNESS_PERCENTILE = 0.4;
export const MAX_SURVIVORS = 12;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * Step 5: drop black/fades, soft frames (below the scene's 40th percentile or
 * the floor) and near-duplicates (keep the sharper), then keep up to
 * `max` survivors spread across the scene, not all from one shot.
 */
export function filterCandidates(
  stats: CandidateStats[],
  max: number = MAX_SURVIVORS,
): FilterResult {
  const rejected: FilterResult["rejected"] = [];
  const lit = stats.filter((s) => {
    if (s.luma < BLACK_LUMA || s.luma > WHITE_LUMA) {
      rejected.push({ time: s.time, reason: s.luma < BLACK_LUMA ? "black or fade" : "white flash" });
      return false;
    }
    return true;
  });
  const cut = Math.max(SHARPNESS_FLOOR, percentile(lit.map((s) => s.sharpness), SHARPNESS_PERCENTILE));
  // With few frames the percentile would throw away most of the scene.
  const sharp = lit.filter((s) => {
    if (lit.length >= 6 ? s.sharpness < cut : s.sharpness < SHARPNESS_FLOOR) {
      rejected.push({ time: s.time, reason: "blur" });
      return false;
    }
    return true;
  });
  // Near-duplicates: walk sharpest first so the sharper of a pair survives.
  const unique: CandidateStats[] = [];
  for (const s of [...sharp].sort((a, b) => b.sharpness - a.sharpness)) {
    const dup = unique.find(
      (u) =>
        Math.abs(u.time - s.time) < NEAR_DUPLICATE_SECONDS &&
        hammingDistance(u.hash, s.hash) <= NEAR_DUPLICATE_DISTANCE,
    );
    if (dup) {
      rejected.push({ time: s.time, reason: `near-duplicate of ${dup.time.toFixed(2)}s` });
      continue;
    }
    unique.push(s);
  }
  // Spread: split the scene into `max` time buckets, best (sharpest) per bucket,
  // then fill any spare places with the next sharpest.
  unique.sort((a, b) => a.time - b.time);
  if (unique.length <= max) return { kept: unique, rejected };
  const t0 = unique[0].time;
  const t1 = unique[unique.length - 1].time;
  const span = Math.max(1e-6, t1 - t0);
  const buckets = new Map<number, CandidateStats>();
  for (const s of unique) {
    const b = Math.min(max - 1, Math.floor(((s.time - t0) / span) * max));
    const cur = buckets.get(b);
    if (!cur || s.sharpness > cur.sharpness) buckets.set(b, s);
  }
  const kept = new Set(buckets.values());
  for (const s of [...unique].sort((a, b) => b.sharpness - a.sharpness)) {
    if (kept.size >= max) break;
    kept.add(s);
  }
  for (const s of unique) {
    if (!kept.has(s)) rejected.push({ time: s.time, reason: "not needed for spread" });
  }
  return { kept: [...kept].sort((a, b) => a.time - b.time), rejected };
}

/** Frames per second for the candidate pull: 2 fps, capped at 240 frames. */
export function candidateFps(windowSec: number): number {
  if (!(windowSec > 0)) return 2;
  return Math.min(2, 240 / windowSec);
}

/** Step 4 window: inside the scene, 1 s from each edge (never empty). */
export function safeWindow(start: number, end: number): { start: number; end: number } {
  const inner = { start: start + 1, end: end - 1 };
  if (inner.end - inner.start >= 0.5) return inner;
  const mid = (start + end) / 2;
  return { start: Math.max(start, mid - 0.25), end: Math.min(end, mid + 0.25) };
}

/* ---- Step 7: crop, upscale method, brightness ------------------------- */

export const TARGET_WIDTH = 1920;
export const TARGET_HEIGHT = 1080;

export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FacePosition {
  /** Centre of the main subject, as fractions of the frame. */
  x: number;
  y: number;
  /** Subject (face) height as a fraction of the frame height. */
  h?: number;
}

/**
 * 16:9 crop of a square-pixel frame with the subject on the nearer vertical
 * third and room for title text on the other side. Prefers the widest crop:
 * it only zooms in when the subject is not already near a third, and never
 * so far that the upscale factor passes `maxFactor`.
 */
export function crop16x9(
  frameWidth: number,
  frameHeight: number,
  subject: FacePosition | null,
  maxFactor = 1.5,
): Crop {
  // Largest 16:9 box inside the frame
  let w = Math.min(frameWidth, (frameHeight * 16) / 9);
  let h = (w * 9) / 16;
  const fullX = (frameWidth - w) / 2;
  const fullY = (frameHeight - h) / 2;
  if (!subject) return roundCrop({ x: fullX, y: fullY, width: w, height: h });

  const sx = subject.x * frameWidth;
  const sy = subject.y * frameHeight;
  const relInFull = (sx - fullX) / w;
  const nearThird = Math.abs(relInFull - 1 / 3) <= 0.08 || Math.abs(relInFull - 2 / 3) <= 0.08;
  let third = Math.abs(relInFull - 1 / 3) < Math.abs(relInFull - 2 / 3) ? 1 / 3 : 2 / 3;
  if (!nearThird) {
    // Widest crop that puts the subject exactly on a third, within the frame
    // and within the upscale limit.
    const minWidth = Math.min(w, TARGET_WIDTH / maxFactor);
    let bestW = 0;
    for (const t of [1 / 3, 2 / 3]) {
      const fit = Math.min(w, sx / t, (frameWidth - sx) / (1 - t));
      if (fit > bestW) {
        bestW = fit;
        third = t;
      }
    }
    w = Math.max(minWidth, bestW);
    h = (w * 9) / 16;
  }
  let x = sx - third * w;
  // Keep the face's headroom: eyes about a third down, without cutting it.
  let y = sy - 0.4 * h;
  x = Math.max(0, Math.min(frameWidth - w, x));
  y = Math.max(0, Math.min(frameHeight - h, y));
  return roundCrop({ x, y, width: w, height: h });
}

function roundCrop(c: Crop): Crop {
  // Even sizes for the encoder; stay inside the frame.
  const width = Math.max(2, Math.floor(c.width / 2) * 2);
  const height = Math.max(2, Math.floor(c.height / 2) * 2);
  return { x: Math.max(0, Math.floor(c.x)), y: Math.max(0, Math.floor(c.y)), width, height };
}

export type UpscaleMethod = "none" | "lanczos";

/**
 * Uprez method from the factor (target width ÷ square-pixel crop width).
 * The runbook wants Real-ESRGAN above 1.5×; it cannot run on Lambda, so this
 * build uses Lanczos there and flags the scene for review.
 */
export function upscalePlan(cropWidth: number): {
  method: UpscaleMethod;
  factor: number;
  flag: string | null;
} {
  const factor = Math.round((TARGET_WIDTH / Math.max(1, cropWidth)) * 100) / 100;
  if (factor <= 1) return { method: "none", factor, flag: null };
  if (factor <= 1.5) return { method: "lanczos", factor, flag: null };
  if (factor > 4) {
    return { method: "lanczos", factor, flag: `source too small: ${factor}x upscale (runbook: stop and ask past 4x)` };
  }
  return { method: "lanczos", factor, flag: `lanczos ${factor}x (over 1.5x; Real-ESRGAN not available in this build)` };
}

export const LIFT_BELOW_LUMA = 55;
export const LIFT_TARGET_LUMA = 72;
export const MAX_GAMMA = 1.8;

/** Mean luma of `frame` after a gamma curve (exponent 1/gamma). */
export function lumaAfterGamma(frame: GrayFrame, gamma: number): number {
  const lut = new Float64Array(256);
  for (let v = 0; v < 256; v++) lut[v] = 255 * Math.pow(v / 255, 1 / gamma);
  let sum = 0;
  for (let i = 0; i < frame.data.length; i++) sum += lut[frame.data[i]];
  return frame.data.length ? sum / frame.data.length : 0;
}

/**
 * Brightness lift: one gamma on the whole image when the crop's mean luma is
 * under 55, chosen to land near 72, never above 1.8. Null when no lift.
 */
export function brightnessLift(
  crop: GrayFrame,
): { gamma: number; meanLumaBefore: number; meanLumaAfter: number } | null {
  const before = meanLuma(crop);
  if (before >= LIFT_BELOW_LUMA) return null;
  let lo = 1;
  let hi = MAX_GAMMA;
  if (lumaAfterGamma(crop, hi) < LIFT_TARGET_LUMA) lo = hi;
  else {
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (lumaAfterGamma(crop, mid) < LIFT_TARGET_LUMA) lo = mid;
      else hi = mid;
    }
  }
  const gamma = Math.round(Math.min(MAX_GAMMA, lo === MAX_GAMMA ? MAX_GAMMA : hi) * 100) / 100;
  return {
    gamma,
    meanLumaBefore: Math.round(before),
    meanLumaAfter: Math.round(lumaAfterGamma(crop, gamma)),
  };
}

/* ---- Naming (Fields) -------------------------------------------------- */

/** "The Show Title" → "the-show-title". */
export function showSlug(name: string | null | undefined): string {
  const slug = String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

/** `[show-name]_scene_[##]_[MMm][SSs].jpg`, minutes past 59 keep counting. */
export function thumbnailFilename(show: string, sceneNumber: number, startSec: number): string {
  const whole = Math.max(0, Math.floor(startSec + 1e-6));
  const mm = Math.floor(whole / 60);
  const ss = whole % 60;
  return `${showSlug(show)}_scene_${String(sceneNumber).padStart(2, "0")}_${String(mm).padStart(2, "0")}m${String(ss).padStart(2, "0")}s.jpg`;
}

export const THUMBNAIL_FILENAME_PATTERN = /^[a-z0-9-]+_scene_\d{2}_\d{2,3}m\d{2}s\.jpg$/;
