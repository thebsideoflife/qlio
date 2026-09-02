import { spawn } from "child_process";

/** Rough input seek before accurate output trim (seconds). */
export const PRE_SEEK_WINDOW_SEC = 2;

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
 * so clip boundaries match segment.startTime exactly — required for caption sync.
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

  return [
    "-ignore_editlist",
    "1",
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
