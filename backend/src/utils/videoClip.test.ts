import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  PRE_SEEK_WINDOW_SEC,
  buildExtractClipArgs,
  extractClip,
  formatFfmpegSeconds,
  probeClipTiming,
} from "./videoClip";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}: ${stderr}`));
    });
    child.on("error", reject);
  });
}

function assertSynchronized(
  timing: Awaited<ReturnType<typeof probeClipTiming>>,
  label: string,
): void {
  assert(timing.videoStartSec != null, `${label}: missing video start`);
  assert(timing.audioStartSec != null, `${label}: missing audio start`);
  const gap = Math.abs(timing.audioStartSec - timing.videoStartSec);
  assert(gap <= 0.1, `${label}: A/V start gap ${gap.toFixed(3)}s exceeds 100ms`);
}

async function testArgumentConstruction(): Promise<void> {
  const startTime = 185.77570238456082;
  const duration = 138.70178788797288;

  assert(formatFfmpegSeconds(startTime) === "185.775702", "formats seconds");

  const fastArgs = buildExtractClipArgs(
    "in.mp4",
    "out.mp4",
    startTime,
    duration,
    "fast",
  );
  assert(fastArgs.includes("copy"), "fast mode stream-copies video");
  assert(fastArgs.indexOf("-ss") < fastArgs.indexOf("-i"), "fast seek is input-side");

  const accurateArgs = buildExtractClipArgs(
    "in.mp4",
    "out.mp4",
    startTime,
    duration,
    "accurate",
    30,
  );
  const inputIndex = accurateArgs.indexOf("-i");
  const outputSeekIndex = accurateArgs.lastIndexOf("-ss");
  assert(outputSeekIndex > inputIndex, "accurate fine seek is output-side");
  assert(accurateArgs.includes("libx264"), "accurate mode re-encodes video");
  assert(!accurateArgs.includes("copy"), "accurate mode does not stream-copy");
  assert(
    accurateArgs[accurateArgs.indexOf("-ss") + 1] ===
      formatFfmpegSeconds(startTime - PRE_SEEK_WINDOW_SEC),
    "accurate mode uses a coarse pre-seek",
  );
  assert(
    accurateArgs[outputSeekIndex + 1] ===
      formatFfmpegSeconds(PRE_SEEK_WINDOW_SEC),
    "accurate mode fine-seeks the remaining window",
  );
  assert(accurateArgs.includes("-r"), "accurate mode pins output fps");
  assert(
    accurateArgs[accurateArgs.indexOf("-r") + 1] === "30",
    "accurate mode uses the provided fps",
  );
  assert(
    !accurateArgs.includes("-ignore_editlist"),
    "accurate mode honors the source edit list",
  );
}

function firstFrameLuma(clipPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-v", "error",
      "-i", clipPath,
      "-frames:v", "1",
      "-vf", "format=gray",
      "-f", "rawvideo",
      "-",
    ]);
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => chunks.push(data));
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
        return;
      }
      const pixels = Buffer.concat(chunks);
      let sum = 0;
      for (const value of pixels) sum += value;
      resolve(sum / pixels.length);
    });
    child.on("error", reject);
  });
}

/**
 * B-frame H.264 in MP4 carries an edit list that hides the decoder delay.
 * Ignoring it made clip frame 0 two source frames early, so every framing
 * cut in an export ran two frames ahead of its shot change.
 */
async function testEditListFrameAlignment(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-clip-elst-"));
  const sourcePath = path.join(tmpDir, "source.mp4");
  const clipPath = path.join(tmpDir, "clip.mp4");
  const fps = 30;
  const startFrame = 75;

  try {
    // Luma = 2 × frame number, so a clip's first frame names its source frame.
    await run("ffmpeg", [
      "-v", "error",
      "-f", "lavfi",
      "-i", `color=c=black:size=64x36:rate=${fps},format=gray,geq=lum='N*2'`,
      "-f", "lavfi",
      "-i", "sine=frequency=440:sample_rate=44100",
      "-t", "5",
      "-c:v", "libx264",
      "-preset", "medium",
      "-bf", "2",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-y", sourcePath,
    ]);

    await extractClip(
      sourcePath,
      clipPath,
      startFrame / fps,
      1,
      "accurate",
      fps,
    );
    const frame = (await firstFrameLuma(clipPath)) / 2;
    assert(
      Math.abs(frame - startFrame) < 0.5,
      `accurate mode: clip frame 0 is source frame ${frame.toFixed(1)}, expected ${startFrame}`,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function testNonKeyframeRegression(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-clip-test-"));
  const sourcePath = path.join(tmpDir, "source.mp4");
  const fastPath = path.join(tmpDir, "fast.mp4");
  const accuratePath = path.join(tmpDir, "accurate.mp4");

  try {
    // Three-second GOPs guarantee that 5.2s is not a keyframe.
    await run("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=44100",
      "-t",
      "9",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-g",
      "90",
      "-keyint_min",
      "90",
      "-sc_threshold",
      "0",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-y",
      sourcePath,
    ]);

    await extractClip(sourcePath, fastPath, 5.2, 2, "fast");
    const fastTiming = await probeClipTiming(fastPath);
    let fastModeFailedSyncCheck = false;
    try {
      assertSynchronized(fastTiming, "fast mode");
    } catch {
      fastModeFailedSyncCheck = true;
    }
    assert(
      fastModeFailedSyncCheck,
      "fixture must reproduce the non-keyframe fast-cut sync bug",
    );

    await extractClip(sourcePath, accuratePath, 5.2, 2, "accurate", 30);
    const accurateTiming = await probeClipTiming(accuratePath);
    assertSynchronized(accurateTiming, "accurate mode");
    assert(
      accurateTiming.durationSec != null,
      "accurate mode: missing output duration",
    );
    assert(
      Math.abs(accurateTiming.durationSec - 2) <= 0.1,
      `accurate mode: duration error ${(
        accurateTiming.durationSec - 2
      ).toFixed(3)}s exceeds 100ms`,
    );
    assert(
      accurateTiming.nbFrames != null,
      "accurate mode: missing frame count",
    );
    assert(
      Math.abs(accurateTiming.nbFrames - 60) <= 1,
      `accurate mode: expected ~60 frames, got ${accurateTiming.nbFrames}`,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testArgumentConstruction();
  await testNonKeyframeRegression();
  await testEditListFrameAlignment();
  console.log("videoClip tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
