import {
  isTransientRenderError,
  planSegmentReuse,
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

console.log("renderReuse tests passed");
