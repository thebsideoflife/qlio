/**
 * Shot-hold framing: result mapping, fallbacks, progress, continuation, and
 * the proxy slice plan.
 *
 * Run: npx tsx src/services/shot-hold-framing.test.ts
 */
import {
  CONTINUE_BELOW_MS,
  MAX_CONTINUATIONS,
  mapReframeResult,
  progressToCompletedCount,
  runShotHoldFraming,
  type FramingKeyframe,
  type ShotHoldDeps,
  type ShotHoldJobInput,
} from "./shot-hold-framing";
import { buildProxyEncodeArgs, planProxyChunks } from "./reframe-proxy";
import type { ReframeJob, ReframeRequest } from "./sporelabs-reframe";

let checks = 0;
let failures = 0;

function assert(condition: boolean, message: string): void {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}

const FPS = 24000 / 1001;

function fallback(): FramingKeyframe {
  return {
    id: "ai-kf-fb-x",
    time: 0,
    focusX: 0.5,
    focusY: 0.5,
    zoom: 0.5,
    aiReasoning: "fallback",
    isAiGenerated: true,
  };
}

const SEGMENTS = [
  { id: "s1", startTime: 12.5, endTime: 98 },
  { id: "s2", startTime: 100, endTime: 130 },
  { id: "s3", startTime: 200, endTime: 210 },
];

// ============================================================================
// mapReframeResult
// ============================================================================
{
  // A cut at source frame 1234: time = 1234/fps - start, not re-rounded.
  const cutTime = 1234 / FPS - 12.5;
  const { keyframes, missing } = mapReframeResult(
    {
      fps: FPS,
      segments: [
        {
          id: "s1",
          start: 12.5,
          end: 98,
          shots: 2,
          keyframes: [
            { time: cutTime, zoom: 0.8, focusX: 0.2, focusY: 0.5, sourceFrame: 1234, reason: "two-shot" },
            { time: 0, zoom: 1, focusX: 0.43, focusY: 0.5, sourceFrame: 300, reason: "single subject" },
          ],
        },
        {
          id: "s2",
          start: 100,
          end: 130,
          shots: 1,
          keyframes: [
            { time: 0, zoom: 1.2, focusX: -0.1, focusY: 0.5, reason: "" },
            { time: 45, zoom: 1, focusX: 0.5, focusY: 0.5, reason: "past end" },
            { time: 3, zoom: NaN, focusX: 0.5, focusY: 0.5, reason: "garbage" },
          ],
        },
        { id: "ghost", start: 0, end: 1, shots: 1, keyframes: [] },
      ],
    },
    SEGMENTS,
    fallback,
  );

  const s1 = keyframes.get(0)!;
  assert(s1.length === 2, "s1 keeps both holds");
  assert(s1[0].time === 0 && s1[1].time === cutTime, "sorted, times passed through unchanged");
  assert(
    Math.round((12.5 + s1[1].time) * FPS) === 1234,
    "time still lands on sourceFrame",
  );
  assert(s1[0].aiReasoning === "single subject", "aiReasoning = reason");
  assert(s1.every((k) => k.isAiGenerated), "isAiGenerated");
  assert(new Set(s1.map((k) => k.id)).size === 2 && s1[0].id.length >= 32, "fresh UUID ids");
  assert(s1[0].focusX === 0.43 && s1[1].zoom === 0.8, "zoom/focus mapped");
  assert(!("sourceFrame" in s1[0]), "sourceFrame is not persisted");

  const s2 = keyframes.get(1)!;
  assert(s2.length === 1, "s2 drops keyframes past segment end and non-finite ones");
  assert(s2[0].zoom === 1 && s2[0].focusX === 0, "values clamped to [0,1]");
  assert(s2[0].aiReasoning === "shot hold", "empty reason gets a default");

  const s3 = keyframes.get(2)!;
  assert(missing.length === 1 && missing[0] === "s3", "missing segment reported");
  assert(s3.length === 1 && s3[0].time === 0 && s3[0].zoom === 0.5, "missing segment gets fallback");
  assert(!!s3[0].aiReasoning?.includes("no framing"), "fallback reason explains why");
  assert(keyframes.size === 3, "every requested segment has keyframes");
}
{
  // Service skipped t=0 → first hold starts at the segment open.
  const { keyframes } = mapReframeResult(
    {
      fps: FPS,
      segments: [
        {
          id: "s1",
          start: 12.5,
          end: 98,
          shots: 1,
          keyframes: [{ time: 2, zoom: 1, focusX: 0.5, focusY: 0.5 }],
        },
      ],
    },
    [SEGMENTS[0]],
    fallback,
  );
  assert(keyframes.get(0)![0].time === 0, "first keyframe forced to t=0");
}
{
  const { keyframes, missing } = mapReframeResult(undefined, SEGMENTS, fallback);
  assert(missing.length === 3 && keyframes.size === 3, "no result → all fallback");
}

// ============================================================================
// progressToCompletedCount
// ============================================================================
{
  assert(progressToCompletedCount(undefined, 10) === 0, "no progress → 0");
  assert(
    progressToCompletedCount({ stage: "mystery", done: 5, total: 5 }, 10) === 0,
    "unknown stage → 0",
  );
  const stages = ["cache", "download", "analyze", "plan"];
  let prev = -1;
  let monotonic = true;
  for (const stage of stages) {
    for (const done of [0, 5, 10]) {
      const n = progressToCompletedCount({ stage, done, total: 10 }, 20);
      if (n < prev) monotonic = false;
      prev = n;
    }
  }
  assert(monotonic, "progress is monotonic across stages");
  assert(
    progressToCompletedCount({ stage: "plan", done: 1, total: 1 }, 20) === 19,
    "never reports all segments done before results are written",
  );
  assert(
    progressToCompletedCount({ stage: "analyze", done: 0, total: 0 }, 20) === 2,
    "total 0 counts the stage as just started",
  );
}

// ============================================================================
// runShotHoldFraming
// ============================================================================

type Harness = {
  deps: ShotHoldDeps;
  calls: {
    updates: Record<string, unknown>[];
    submitted: ReframeRequest[];
    polled: string[];
    written: Map<number, FramingKeyframe[]>[];
    continued: ShotHoldJobInput[];
    proxies: number;
  };
};

function harness(opts: {
  stored?: { jobId?: string; sporelabsJobId?: string } | null;
  polls?: ReframeJob[];
  remaining?: number[];
  updateOk?: (u: Record<string, unknown>) => boolean;
  proxySize?: { width: number; height: number };
  proxyFps?: number;
  proxyBounds?: { frameCount?: number | null; durationSec?: number | null };
}): Harness {
  const calls: Harness["calls"] = {
    updates: [],
    submitted: [],
    polled: [],
    written: [],
    continued: [],
    proxies: 0,
  };
  const polls = opts.polls ?? [];
  const remaining = opts.remaining ?? [600_000];
  let pollIndex = 0;
  let remainingIndex = 0;
  const deps: ShotHoldDeps = {
    readJob: async () =>
      opts.stored === undefined ? { jobId: "job-1" } : opts.stored,
    updateJob: async (u) => {
      calls.updates.push(u);
      return opts.updateOk ? opts.updateOk(u) : true;
    },
    getAsset: async () => ({ assetId: "asset-1", rawKey: "raw/asset-1.mp4" }),
    ensureProxy: async () => {
      calls.proxies++;
      return {
        url: "https://bucket/proxy/asset-1.mp4?sig",
        etag: "etag123",
        fps: opts.proxyFps ?? FPS,
        width: opts.proxySize?.width ?? 1920,
        height: opts.proxySize?.height ?? 1080,
        ...opts.proxyBounds,
      };
    },
    submitReframe: async (req) => {
      calls.submitted.push(req);
      return { id: "rf_new", object: "video.reframe", status: "queued" };
    },
    getReframe: async (id) => {
      calls.polled.push(id);
      return polls[Math.min(pollIndex++, polls.length - 1)];
    },
    writeResults: async (k) => {
      calls.written.push(k);
    },
    makeFallbackKeyframe: fallback,
    invokeContinuation: async (next) => {
      calls.continued.push(next);
    },
    remainingMs: () => remaining[Math.min(remainingIndex++, remaining.length - 1)],
    sleep: async () => {},
  };
  return { deps, calls };
}

const INPUT: ShotHoldJobInput = {
  projectId: "p1",
  jobId: "job-1",
  segments: SEGMENTS,
  targetAspectRatio: "9:16",
};

const COMPLETED: ReframeJob = {
  id: "rf_new",
  object: "video.reframe",
  status: "completed",
  result: {
    fps: FPS,
    versions: { clock: "clock-v3", crop: "subject-v4", job: "job-v1" },
    segments: [
      {
        id: "s1",
        start: 12.5,
        end: 98,
        shots: 1,
        keyframes: [{ time: 0, zoom: 1, focusX: 0.43, focusY: 0.5, reason: "single subject" }],
      },
      {
        id: "s2",
        start: 100,
        end: 130,
        shots: 1,
        keyframes: [{ time: 0, zoom: 1, focusX: 0.6, focusY: 0.5, reason: "single subject" }],
      },
    ],
  },
};

async function runTests() {
  // Vertical source into 9:16: nothing to crop, so fit without calling SporeLabs.
  {
    const { deps, calls } = harness({ proxySize: { width: 1080, height: 1920 } });
    const outcome = await runShotHoldFraming(INPUT, deps);
    assert(outcome === "completed", "vertical source completes");
    assert(calls.submitted.length === 0, "vertical source is not submitted");
    const kfs = [...calls.written[0].values()];
    assert(
      kfs.length === SEGMENTS.length && kfs.every((k) => k.length === 1 && k[0].zoom === 0 && k[0].time === 0),
      "vertical source gets one fit hold per segment",
    );
  }

  // Fresh run: proxy → one submit for all segments → poll → write.
  {
    const { deps, calls } = harness({
      polls: [
        { id: "rf_new", object: "video.reframe", status: "queued" },
        {
          id: "rf_new",
          object: "video.reframe",
          status: "in_progress",
          progress: { stage: "analyze", done: 3, total: 6 },
        },
        COMPLETED,
      ],
    });
    const outcome = await runShotHoldFraming(INPUT, deps);
    assert(outcome === "completed", "fresh run completes");
    assert(calls.proxies === 1, "proxy ensured once");
    assert(calls.submitted.length === 1, "one submit for the whole job");
    const req = calls.submitted[0];
    assert(req.segments.length === 3, "all segments in one request");
    assert(
      req.segments[0].start === 12.5 && req.segments[0].end === 98 && req.segments[0].id === "s1",
      "segment bounds sent on the source timeline",
    );
    assert(req.fps === FPS, "fps from proxy/source probe");
    assert(Math.abs(req.source_aspect - 16 / 9) < 1e-9, "source_aspect = width/height");
    assert(req.target_aspect === "9:16", "target aspect");
    assert(req.asset_key === "zeevee/asset-1/etag123", "asset_key from proxy ETag");
    assert(
      calls.updates.some((u) => u.sporelabsJobId === "rf_new"),
      "SporeLabs job id stored on framingJob",
    );
    assert(
      calls.updates.some((u) => typeof u.completedCount === "number" && (u.completedCount as number) > 0),
      "progress mapped to completedCount",
    );
    assert(calls.written.length === 1, "results written once");
    const written = calls.written[0];
    assert(written.get(0)![0].focusX === 0.43, "s1 mapped");
    assert(written.get(2)![0].zoom === 0.5, "s3 (absent from result) gets fallback");
  }

  // Segment bounds past the proxy's last frame are clamped before submit, with
  // a warning; a segment entirely past the end is dropped and falls back.
  // (Production case: VFR source, avg fps 31.055, proxy 5637 frames, stored
  // asset duration put a segment end at frame 5664.)
  {
    const fps = 31.055;
    const { deps, calls } = harness({
      polls: [COMPLETED],
      proxyFps: fps,
      proxyBounds: { frameCount: 5637, durationSec: 182.4 },
    });
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    };
    let outcome: string;
    try {
      outcome = await runShotHoldFraming(
        {
          ...INPUT,
          segments: [
            { id: "s1", startTime: 12.5, endTime: 98 },
            { id: "s2", startTime: 100, endTime: 5664 / fps },
            { id: "s3", startTime: 200, endTime: 210 },
          ],
        },
        deps,
      );
    } finally {
      console.warn = originalWarn;
    }
    assert(outcome === "completed", "clamped run completes");
    const req = calls.submitted[0];
    assert(req.segments.length === 2, "segment past the end is not submitted");
    assert(
      req.segments[0].start === 12.5 && req.segments[0].end === 98,
      "in-range segment untouched",
    );
    assert(
      Math.round(req.segments[1].end * fps) === 5637 && req.segments[1].start === 100,
      "end clamped onto the proxy's last frame",
    );
    const warn = warns.find((w) => w.includes("Clamped"));
    assert(
      !!warn &&
        warn.includes("5637 frames") &&
        warn.includes("s2.end") &&
        warn.includes("Dropped 1") &&
        warn.includes("s3"),
      `warning names the bound and the moved segments (${warn})`,
    );
    assert(!warns.some((w) => w.includes("?sig")), "warning never echoes the proxy URL");
    const written = calls.written[0];
    assert(
      written.size === 3 && written.get(2)![0].zoom === 0.5,
      "dropped segment still gets a fallback hold",
    );
  }

  // Duration-only bound (older proxy without a frame count) still clamps.
  {
    const { deps, calls } = harness({
      polls: [COMPLETED],
      proxyBounds: { frameCount: null, durationSec: 120 },
    });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await runShotHoldFraming(INPUT, deps);
    } finally {
      console.warn = originalWarn;
    }
    const req = calls.submitted[0];
    assert(
      req.segments.length === 2 && req.segments[1].end === 120,
      "container duration bounds the end when no frame count is known",
    );
  }

  // Every segment past the end: nothing to analyze, fail loudly.
  {
    const { deps, calls } = harness({
      polls: [COMPLETED],
      proxyFps: 25,
      proxyBounds: { frameCount: 250, durationSec: 10 },
    });
    const originalWarn = console.warn;
    console.warn = () => {};
    let message = "";
    try {
      await runShotHoldFraming(
        { ...INPUT, segments: [{ id: "s1", startTime: 20, endTime: 30 }] },
        deps,
      );
    } catch (err) {
      message = (err as Error).message;
    } finally {
      console.warn = originalWarn;
    }
    assert(message.includes("past the end"), "all-dropped run throws a clear error");
    assert(calls.submitted.length === 0, "nothing submitted when no segment is left");
  }

  // Time runs low after submit: hand off, don't poll, don't resubmit.
  {
    const { deps, calls } = harness({ remaining: [CONTINUE_BELOW_MS - 1] });
    const outcome = await runShotHoldFraming(INPUT, deps);
    assert(outcome === "continued", "low time → continued");
    assert(calls.submitted.length === 1, "submitted before handing off");
    assert(calls.polled.length === 0, "no poll when handing off");
    assert(calls.continued.length === 1, "one continuation invoked");
    assert(calls.continued[0].sporelabsJobId === "rf_new", "continuation carries SporeLabs id");
    assert(calls.continued[0].continuation === 1, "continuation counter incremented");
    assert(calls.written.length === 0, "nothing written on hand-off");
  }

  // Continuation payload resumes polling without proxy or submit.
  {
    const { deps, calls } = harness({ polls: [COMPLETED] });
    const outcome = await runShotHoldFraming(
      { ...INPUT, sporelabsJobId: "rf_prev", continuation: 1 },
      deps,
    );
    assert(outcome === "completed", "continuation completes");
    assert(calls.proxies === 0 && calls.submitted.length === 0, "continuation never resubmits");
    assert(calls.polled[0] === "rf_prev", "polls the stored job");
  }

  // Lambda async retry (no id in payload) resumes from the stored row.
  {
    const { deps, calls } = harness({
      stored: { jobId: "job-1", sporelabsJobId: "rf_stored" },
      polls: [COMPLETED],
    });
    await runShotHoldFraming(INPUT, deps);
    assert(calls.submitted.length === 0, "stored sporelabsJobId prevents resubmit");
    assert(calls.polled[0] === "rf_stored", "polls stored job");
  }

  // Poll loop hands off mid-way once time runs low.
  {
    const { deps, calls } = harness({
      stored: { jobId: "job-1", sporelabsJobId: "rf_stored" },
      polls: [{ id: "rf_stored", object: "video.reframe", status: "in_progress" }],
      remaining: [600_000, 500_000, 80_000],
    });
    const outcome = await runShotHoldFraming({ ...INPUT, continuation: 2 }, deps);
    assert(outcome === "continued", "mid-poll hand-off");
    assert(calls.polled.length === 2, "polled until time ran low");
    assert(calls.continued[0].continuation === 3, "counter carries across hand-offs");
  }

  // Continuation cap.
  {
    const { deps } = harness({ remaining: [1_000] });
    let threw = false;
    try {
      await runShotHoldFraming(
        { ...INPUT, sporelabsJobId: "rf_x", continuation: MAX_CONTINUATIONS },
        deps,
      );
    } catch (err) {
      threw = (err as Error).message.includes("continuations");
    }
    assert(threw, "gives up after MAX_CONTINUATIONS");
  }

  // Superseded before start / after proxy.
  {
    const { deps, calls } = harness({ stored: { jobId: "job-2" } });
    assert((await runShotHoldFraming(INPUT, deps)) === "superseded", "other job owns the row");
    assert(calls.proxies === 0 && calls.submitted.length === 0, "superseded does no work");
  }
  {
    const { deps, calls } = harness({
      updateOk: (u) => u.stage !== "submitting",
    });
    assert((await runShotHoldFraming(INPUT, deps)) === "superseded", "superseded during proxy");
    assert(calls.submitted.length === 0, "no paid submit once superseded");
  }

  // SporeLabs job failure → hard error with its message.
  {
    const { deps, calls } = harness({
      polls: [
        {
          id: "rf_new",
          object: "video.reframe",
          status: "failed",
          error: { message: "could not decode video" },
        },
      ],
    });
    let message = "";
    try {
      await runShotHoldFraming(INPUT, deps);
    } catch (err) {
      message = (err as Error).message;
    }
    assert(message.includes("could not decode video"), "failure message surfaced");
    assert(calls.written.length === 0, "nothing written on failure");
  }

  // ==========================================================================
  // Proxy slice plan + encode args
  // ==========================================================================
  {
    const hour = planProxyChunks({
      fps: FPS,
      width: 1920,
      height: 1080,
      durationSec: 3600,
      frameCount: 86314,
    });
    assert(hour.length === 10, `1h 1080p23.976 → 10 slices (got ${hour.length})`);
    let contiguous = true;
    for (let i = 1; i < hour.length; i++) {
      const prev = hour[i - 1];
      if (prev.frameCount == null || prev.startFrame + prev.frameCount !== hour[i].startFrame) {
        contiguous = false;
      }
    }
    assert(contiguous, "slices are contiguous on the frame grid");
    assert(hour[0].startFrame === 0, "first slice starts at frame 0");
    assert(hour[hour.length - 1].frameCount === null, "last slice runs to EOF");

    const short = planProxyChunks({ fps: FPS, width: 1920, height: 1080, durationSec: 300, frameCount: null });
    assert(short.length === 1, "5 min source → single pass");
    const unknown = planProxyChunks({ fps: 25, width: 1920, height: 1080, durationSec: NaN, frameCount: null });
    assert(unknown.length === 1, "unknown duration → single pass");
    const uhd = planProxyChunks({ fps: 60, width: 3840, height: 2160, durationSec: 7200, frameCount: null });
    assert(uhd.length <= 40 && uhd.length > 1, "4K60 2h is capped at 40 slices");

    const args = buildProxyEncodeArgs({
      inputUrl: "https://x",
      outputPath: "/tmp/p.mp4",
      fps: FPS,
      startFrame: 8640,
      frameCount: 8640,
    });
    const joined = args.join(" ");
    assert(joined.includes("-fps_mode passthrough"), "passthrough keeps every frame");
    assert(!/fps=/.test(joined), "no fps filter");
    assert(joined.includes("-an"), "video only");
    assert(joined.includes("scale=-2:360"), "360p");
    assert(joined.includes("-preset veryfast") && joined.includes("-crf 23"), "x264 veryfast crf 23");
    assert(joined.includes("-pix_fmt yuv420p") && joined.includes("+faststart"), "yuv420p + faststart");
    const ss = Number(args[args.indexOf("-ss") + 1]);
    assert(
      Math.floor(ss * FPS) === 8639 && Math.ceil(ss * FPS) === 8640,
      "seek lands between frame N-1 and N",
    );
    assert(args.indexOf("-ss") < args.indexOf("-i"), "input seek (accurate, before -i)");
    assert(args[args.indexOf("-frames:v") + 1] === "8640", "slice frame count");
    const first = buildProxyEncodeArgs({
      inputUrl: "https://x",
      outputPath: "/tmp/p.mp4",
      fps: FPS,
      startFrame: 0,
      frameCount: null,
    });
    assert(!first.includes("-ss") && !first.includes("-frames:v"), "whole-file pass has no seek/limit");
  }

  if (failures > 0) {
    console.error(`shot-hold-framing: ${failures}/${checks} checks failed`);
    process.exit(1);
  }
  console.log(`shot-hold-framing: ${checks} checks passed`);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
