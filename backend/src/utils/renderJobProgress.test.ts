/**
 * advanceRenderJob: every in-flight scene and job ends on its own, finished
 * work is never thrown away, and retries stop at the job ceiling.
 *
 * Run: npx tsx src/utils/renderJobProgress.test.ts
 */
import {
  advanceRenderJob,
  JOB_TIMEOUT_ERROR,
  PENDING_LAUNCH_TIMEOUT_MS,
  type SceneProbe,
  type SegmentRender,
} from "./renderJobProgress";
import {
  MAX_RENDER_JOB_MS,
  SCENE_RENDER_TIMEOUT_ERROR,
  SCENE_RENDER_TIMEOUT_MS,
} from "./renderReuse";

let checks = 0;
let failures = 0;

function assert(condition: boolean, message: string): void {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}

const now = Date.parse("2026-09-26T18:00:00.000Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
const MIN = 60 * 1000;

function scene(id: string, extra: Partial<SegmentRender> = {}): SegmentRender {
  return {
    segmentId: id,
    title: id.toUpperCase(),
    renderId: `r-${id}`,
    bucketName: "b",
    outputKey: `renders/r-${id}/out.mp4`,
    status: "rendering",
    attempts: 1,
    launchedAt: ago(2 * MIN),
    ...extra,
  };
}

const inFlight: SceneProbe = async () => ({ done: false, overallProgress: 0.4 });
const done: SceneProbe = async () => ({ done: true, overallProgress: 1 });
const unreadable: SceneProbe = async () => {
  throw new Error("progress file missing");
};

async function run(
  scenes: SegmentRender[],
  probe: SceneProbe,
  createdAt = ago(5 * MIN),
) {
  return advanceRenderJob({
    job: { createdAt, segments: scenes.map((s) => ({ id: s.segmentId })) },
    segmentRenders: scenes,
    probe,
    now,
    canRetry: true,
    concurrency: 4,
  });
}

async function main() {
  console.log("healthy scene keeps rendering with progress");
  let r = await run([scene("s1")], inFlight);
  assert(r.status === "rendering", "job still rendering");
  assert(r.progressById.get("s1") === 40, "progress reported");
  assert(!r.changed, "nothing to write");

  console.log("finished scenes complete the job");
  r = await run([scene("s1"), scene("s2")], done);
  assert(r.status === "completed", "job completed");
  assert(r.completedCount === 2, "both scenes counted");

  console.log("in-flight scene past its limit fails and is retried");
  r = await run(
    [scene("s1", { launchedAt: ago(SCENE_RENDER_TIMEOUT_MS + MIN) })],
    inFlight,
  );
  assert(r.changed, "change is written");
  assert(r.status === "rendering", "job waits for the retry");
  assert(r.segmentRenders[0].status === "failed", "scene waits out backoff first");
  assert(r.segmentRenders[0].error === SCENE_RENDER_TIMEOUT_ERROR, "timeout error");

  console.log("unreadable progress past the limit still ends the scene");
  r = await run(
    [scene("s1", { launchedAt: ago(SCENE_RENDER_TIMEOUT_MS + MIN) })],
    unreadable,
  );
  assert(r.segmentRenders[0].status === "failed", "scene ended");

  console.log("unreadable progress inside the limit waits");
  r = await run([scene("s1")], unreadable);
  assert(r.segmentRenders[0].status === "rendering", "scene still in flight");
  assert(!r.changed, "nothing to write");

  console.log("timed-out scene past backoff is relaunched");
  r = await run(
    [
      scene("s1", {
        status: "failed",
        error: SCENE_RENDER_TIMEOUT_ERROR,
        failedAt: ago(5 * MIN),
      }),
    ],
    inFlight,
  );
  assert(r.retryIds.join() === "s1", "scene handed back for another attempt");
  assert(r.segmentRenders[0].attempts === 2, "attempt counted");

  console.log("retries stop after the last attempt");
  r = await run(
    [
      scene("s1", {
        status: "failed",
        error: SCENE_RENDER_TIMEOUT_ERROR,
        failedAt: ago(10 * MIN),
        attempts: 4,
      }),
    ],
    inFlight,
  );
  assert(r.retryIds.length === 0, "no more retries");
  assert(r.status === "failed", "job ends");

  console.log("scene never launched past the launch limit fails");
  r = await run(
    [scene("s1", { renderId: "", launchRequestedAt: ago(PENDING_LAUNCH_TIMEOUT_MS + MIN) })],
    inFlight,
  );
  assert(r.segmentRenders[0].status === "failed", "unlaunched scene ended");

  console.log("scene never launched with no readable time fails");
  r = await run([scene("s1", { renderId: "", launchRequestedAt: undefined })], inFlight, "garbage");
  assert(r.segmentRenders[0].status === "failed", "unlaunched scene ended");

  console.log("job past its ceiling keeps finished scenes and ends the rest");
  r = await run(
    [scene("s1"), scene("s2")],
    async (s) => (s.segmentId === "s1" ? { done: true, overallProgress: 1 } : { done: false, overallProgress: 0.5 }),
    ago(MAX_RENDER_JOB_MS + MIN),
  );
  assert(r.status === "failed", "job ends");
  assert(r.segmentRenders[0].status === "completed", "finished scene is kept");
  assert(r.segmentRenders[1].error === JOB_TIMEOUT_ERROR, "the rest time out");
  assert(r.retryIds.length === 0, "nothing retried past the ceiling");
  assert(r.error?.startsWith(JOB_TIMEOUT_ERROR) === true, "job error explains the timeout");

  console.log("job past its ceiling whose scenes all finished completes");
  r = await run([scene("s1"), scene("s2")], done, ago(MAX_RENDER_JOB_MS + MIN));
  assert(r.status === "completed", "finished work is not thrown away");

  console.log("job with an unreadable start time ends");
  r = await run([scene("s1")], inFlight, "garbage");
  assert(r.status === "failed", "job ends");

  console.log("fatal Remotion error fails the scene");
  r = await run([scene("s1")], async () => ({
    done: false,
    fatalError: "Composition not found",
    overallProgress: 0,
  }));
  assert(r.status === "failed", "non-transient error ends the job");
  assert(r.error?.includes("Composition not found") === true, "error surfaced");

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
