import { spawn } from "child_process";

/** Rough input seek before accurate output trim (seconds). */
export const PRE_SEEK_WINDOW_SEC = 2;

/**
 * Longest short side (px) an accurate clip keeps. A 4K source re-encoded at
 * full size produced ~64 Mbps clips that exhausted Remotion's disk, memory and
 * per-chunk time; every export crops to at most 1080 px on the short side, so
 * the extra pixels never reach the output. Smaller sources pass through as-is.
 */
export const MAX_CLIP_SHORT_SIDE_PX = 1080;

/** Downscale so min(w, h) <= MAX_CLIP_SHORT_SIDE_PX, keeping aspect and even dims. */
export const CLIP_SCALE_FILTER =
  `scale=w='trunc(iw*min(1\\,${MAX_CLIP_SHORT_SIDE_PX}/min(iw\\,ih))/2)*2'` +
  `:h='trunc(ih*min(1\\,${MAX_CLIP_SHORT_SIDE_PX}/min(iw\\,ih))/2)*2'` +
  `:flags=lanczos`;

export type ExtractClipMode = "accurate" | "fast";

export function formatFfmpegSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`Invalid FFmpeg timestamp: ${seconds}`);
  }
  return seconds.toFixed(6).replace(/\.?0+$/, "") || "0";
}

export function formatFfmpegFps(fps: number): string {
  if (!(fps > 0) || !Number.isFinite(fps)) {
    throw new Error(`Invalid FFmpeg fps: ${fps}`);
  }
  return fps.toFixed(6).replace(/\.?0+$/, "");
}

/**
 * Build FFmpeg args for segment extraction.
 *
 * `fast` uses input-side seek + stream copy. Cuts land on the previous
 * keyframe, so clip t=0 can be seconds earlier than the requested start.
 *
 * `accurate` uses a coarse input seek plus output-side seek and re-encodes
 * so clip boundaries match segment.startTime exactly — required for caption sync
 * and for framing cuts to land on the source frame they were placed on.
 * Pass `fps` to pin the output timebase to the source/composition frame grid.
 */
export function buildExtractClipArgs(
  inputPath: string,
  outputPath: string,
  startTime: number,
  duration: number,
  mode: ExtractClipMode = "accurate",
  fps?: number,
): string[] {
  if (!(duration > 0)) {
    throw new Error(`Invalid clip duration: ${duration}`);
  }

  if (mode === "fast") {
    return [
      "-ignore_editlist",
      "1",
      "-ss",
      formatFfmpegSeconds(startTime),
      "-i",
      inputPath,
      "-t",
      formatFfmpegSeconds(duration),
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "44100",
      "-avoid_negative_ts",
      "make_zero",
      "-movflags",
      "+faststart",
      "-y",
      outputPath,
    ];
  }

  const preSeek = Math.max(0, startTime - PRE_SEEK_WINDOW_SEC);
  const fineSeek = startTime - preSeek;
  const rateArgs =
    fps != null && fps > 0
      ? ["-r", formatFfmpegFps(fps), "-vsync", "cfr"]
      : [];

  // Honor the source's edit list. The editor's <video>, the reframe proxy and
  // the transcript all play the edit-listed timeline; ignoring it shifts clip
  // frame n to an earlier source frame (2 frames on typical B-frame H.264), so
  // every framing cut lands that many frames before the shot change it marks.
  return [
    ...(preSeek > 0 ? ["-ss", formatFfmpegSeconds(preSeek)] : []),
    "-i",
    inputPath,
    "-ss",
    formatFfmpegSeconds(fineSeek),
    "-t",
    formatFfmpegSeconds(duration),
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-dn",
    "-vf",
    CLIP_SCALE_FILTER,
    "-c:v",
    "libx264",
    "-preset",
    // Intermediate clips are encoded again by Remotion. Ultrafast keeps exact
    // extraction within Lambda's CPU/time limit without affecting boundaries.
    "ultrafast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    ...rateArgs,
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "44100",
    "-movflags",
    "+faststart",
    "-y",
    outputPath,
  ];
}

export function extractClip(
  inputPath: string,
  outputPath: string,
  startTime: number,
  duration: number,
  mode: ExtractClipMode = "accurate",
  fps?: number,
): Promise<void> {
  const args = buildExtractClipArgs(
    inputPath,
    outputPath,
    startTime,
    duration,
    mode,
    fps,
  );

  return new Promise((resolve, reject) => {
    console.log(
      `Cutting clip (${mode}): start=${startTime}s, duration=${duration}s` +
        (fps != null ? `, fps=${fps}` : ""),
    );
    console.log("FFmpeg args:", args.join(" "));

    const ffmpeg = spawn("ffmpeg", args);

    let stderr = "";
    ffmpeg.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      console.error("FFmpeg stderr:", stderr);
      reject(new Error(`FFmpeg exited with code ${code}`));
    });
    ffmpeg.on("error", reject);
  });
}

/** Probe output timing after a cut (starts should be ~0 in accurate mode). */
export function probeClipTiming(localPath: string): Promise<{
  videoStartSec: number | null;
  audioStartSec: number | null;
  durationSec: number | null;
  nbFrames: number | null;
}> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=index,codec_type,start_time,nb_frames:format=duration",
      "-of",
      "json",
      localPath,
    ]);

    let stdout = "";
    let stderr = "";
    ffprobe.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    ffprobe.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    ffprobe.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as {
          streams?: Array<{
            codec_type?: string;
            start_time?: string;
            nb_frames?: string;
          }>;
          format?: { duration?: string };
        };
        let videoStartSec: number | null = null;
        let audioStartSec: number | null = null;
        let nbFrames: number | null = null;
        for (const stream of parsed.streams ?? []) {
          const start = Number(stream.start_time);
          if (!Number.isFinite(start)) continue;
          if (stream.codec_type === "video") {
            videoStartSec = start;
            const frames = Number(stream.nb_frames);
            if (Number.isFinite(frames) && frames > 0) nbFrames = frames;
          }
          if (stream.codec_type === "audio") audioStartSec = start;
        }
        const duration = Number(parsed.format?.duration);
        resolve({
          videoStartSec,
          audioStartSec,
          durationSec: Number.isFinite(duration) ? duration : null,
          nbFrames,
        });
      } catch (error) {
        reject(error);
      }
    });
    ffprobe.on("error", reject);
  });
}
