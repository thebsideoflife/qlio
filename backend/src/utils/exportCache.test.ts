import { computeExportPackageFingerprint } from "./exportPackageFingerprint";
import { isSameRenderArtifact } from "./renderArtifactCache";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const source = {
  bucket: "remotion-bucket",
  key: "renders/new-render/scene.mp4",
};
const persisted = {
  bucket: "delivery-bucket",
  key: "projects/project/segments/scene.mp4",
  renderedAt: "2026-08-19T00:00:00.000Z",
  contentHash: "caption-inputs",
  sourceBucket: source.bucket,
  sourceKey: source.key,
};

assert(
  isSameRenderArtifact(persisted, source, "caption-inputs"),
  "the exact copied Remotion output can be reused",
);
assert(
  !isSameRenderArtifact(
    { ...persisted, sourceKey: "renders/old-render/scene.mp4" },
    source,
    "caption-inputs",
  ),
  "a new Remotion output replaces the persisted MP4 even with the same input hash",
);
assert(
  !isSameRenderArtifact(
    {
      bucket: persisted.bucket,
      key: persisted.key,
      renderedAt: persisted.renderedAt,
      contentHash: persisted.contentHash,
    },
    source,
    "caption-inputs",
  ),
  "legacy cache entries without a source revision are refreshed",
);

const request = {
  segmentIds: ["scene"],
  includeThumbnails: true,
  includePoster: true,
  projectTitle: "Project",
  metadataDocument: { scenes: [{ segmentId: "scene", title: "First" }] },
};
const render = {
  segmentId: "scene",
  bucket: persisted.bucket,
  key: persisted.key,
  renderedAt: persisted.renderedAt,
  contentHash: persisted.contentHash,
  sourceBucket: persisted.sourceBucket,
  sourceKey: persisted.sourceKey,
};
const firstPackage = computeExportPackageFingerprint(request, [render]);

assert(
  firstPackage === computeExportPackageFingerprint(request, [render]),
  "an unchanged package keeps a stable fingerprint",
);
assert(
  firstPackage !==
    computeExportPackageFingerprint(request, [
      {
        ...render,
        renderedAt: "2026-08-19T00:05:00.000Z",
        sourceKey: "renders/newer-render/scene.mp4",
      },
    ]),
  "a newly rendered MP4 invalidates the delivery ZIP",
);
assert(
  firstPackage !==
    computeExportPackageFingerprint(
      {
        ...request,
        metadataDocument: {
          scenes: [{ segmentId: "scene", title: "Updated" }],
        },
      },
      [render],
    ),
  "updated metadata invalidates the delivery ZIP",
);
assert(
  firstPackage ===
    computeExportPackageFingerprint(request, [
      render,
      {
        ...render,
        segmentId: "unselected",
        sourceKey: "renders/other/scene.mp4",
      },
    ]),
  "an unselected render does not invalidate the package",
);

console.log("exportCache.test: ok");
