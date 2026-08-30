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

    await extractClip(sourcePath, accuratePath, 5.2, 2, "accurate");
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
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testArgumentConstruction();
  await testNonKeyframeRegression();
  console.log("videoClip tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
