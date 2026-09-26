import {
  isRenderJobExpired,
  isSceneRenderStuck,
  isTransientRenderError,
  MAX_RENDER_JOB_MS,
  planSegmentReuse,
  SCENE_RENDER_TIMEOUT_ERROR,
  SCENE_RENDER_TIMEOUT_MS,
  shouldReplaceStoredRender,
} from "./renderReuse";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const segments = [{ id: "s1" }, { id: "s2" }, { id: "s3" }, { id: "s4" }];
const hashes: Record<string, string> = { s1: "a", s2: "b", s3: "c", s4: "d" };
const plan = planSegmentReuse(
  segments,
  [
    { segmentId: "s1", bucket: "b", key: "k1", contentHash: "a" },
    { segmentId: "s2", bucket: "b", key: "k2", contentHash: "old" },
    { segmentId: "s3", bucket: "b", key: "", contentHash: "c" },
  ],
  (segment) => hashes[segment.id],
);
assert(
  plan.reuse.map((item) => item.segment.id).join() === "s1",
  "reuses only the render whose hash matches and has a file",
);
assert(
  plan.render.map((segment) => segment.id).join() === "s2,s3,s4",
  "renders stale, file-less and never-rendered scenes",
);
assert(
  planSegmentReuse(segments, undefined, () => "x").render.length === 4,
  "renders everything when nothing is stored",
);

assert(
  shouldReplaceStoredRender(undefined, "2026-09-26T00:00:00Z"),
  "fills an empty slot",
);
assert(
  shouldReplaceStoredRender(
    { segmentId: "s1", renderedAt: "2026-09-25T00:00:00Z" },
    "2026-09-26T00:00:00Z",
  ),
  "replaces a render older than the job",
);
assert(
  !shouldReplaceStoredRender(
    { segmentId: "s1", renderedAt: "2026-09-27T00:00:00Z" },
    "2026-09-26T00:00:00Z",
  ),
  "keeps a render newer than the job",
);

assert(
  isTransientRenderError(
    "ServiceException: We currently do not have sufficient capacity in the region you requested.",
  ),
  "Lambda capacity error is transient",
);
assert(
  isTransientRenderError("InternalError: We encountered an internal error. Please try again."),
  "S3 500 is transient",
);
assert(isTransientRenderError("Rate Exceeded."), "throttle is transient");
assert(
  !isTransientRenderError("Composition CaptionedVideoPortrait not found"),
  "code errors are not transient",
);
assert(!isTransientRenderError(undefined), "missing message is not transient");

// Stuck-state limits: every in-flight scene and job must end on its own.
const now = Date.parse("2026-09-26T18:00:00.000Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
assert(
  !isSceneRenderStuck(ago(SCENE_RENDER_TIMEOUT_MS - 1000), undefined, now),
  "a scene inside the limit is not stuck",
);
assert(
  isSceneRenderStuck(ago(SCENE_RENDER_TIMEOUT_MS + 1000), undefined, now),
  "a scene past the limit is stuck",
);
assert(
  isSceneRenderStuck(undefined, ago(SCENE_RENDER_TIMEOUT_MS + 1000), now),
  "falls back to the launch request time",
);
assert(
  !isSceneRenderStuck(ago(1000), ago(SCENE_RENDER_TIMEOUT_MS + 1000), now),
  "the latest launch time wins over the original request",
);
assert(
  isSceneRenderStuck(undefined, undefined, now),
  "a scene with no readable start time is stuck",
);
assert(
  isTransientRenderError(SCENE_RENDER_TIMEOUT_ERROR),
  "a stuck scene is retried automatically",
);
assert(!isRenderJobExpired(ago(MAX_RENDER_JOB_MS - 1000), now), "job inside limit");
assert(isRenderJobExpired(ago(MAX_RENDER_JOB_MS + 1000), now), "job past limit");
assert(isRenderJobExpired(undefined, now), "job with no start time is expired");
assert(isRenderJobExpired("garbage", now), "job with bad start time is expired");

console.log("renderReuse tests passed");
