/**
 * Showcase catalogue mapping (Qlio rows → mobile Catalogue shape).
 *
 * Run: npx tsx src/utils/showcaseCatalogue.test.ts
 */
import {
  buildCatalogue,
  hueFromId,
  mapAssetKind,
  resolveNote,
  resolveRenderLocation,
  type RenderLocation,
  type ShowcaseAssetRow,
  type ShowcaseProjectRow,
} from "./showcaseCatalogue";

let checks = 0;
let failures = 0;

function assertEqual<T>(actual: T, expected: T, message: string): void {
  checks++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(
      `  FAIL: ${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertTrue(actual: boolean, message: string): void {
  checks++;
  if (!actual) {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}

const RENDERS_BUCKET = "zeevee-renders-dev";
const REMOTION_BUCKET = "remotionlambda-uswest2-0g1upoverr";
const NASHVILLE_PROJECT_ID = "dc1a5723-6142-40ea-89b6-4cf257c56501";
const BOURDAIN_PROJECT_ID = "36e52c4c-220f-4223-9831-e0387604eb85";

const nashville: ShowcaseProjectRow = {
  projectId: NASHVILLE_PROJECT_ID,
  assetId: "asset-nashville",
  title: "Lionsgate Cut 081926",
  thumbnailKey: "thumbnails/projects/nashville/cover.jpg",
  metadata: { assetType: "tv" },
  // Deliberately out of order to prove the sort.
  segments: [
    { id: "seg-b", startTime: 90, endTime: 120.5, title: "Second" },
    { id: "seg-a", startTime: 10, endTime: 40, description: "Cold open" },
    { id: "seg-unrendered", startTime: 200, endTime: 260 },
  ],
  segmentRenders: [
    {
      segmentId: "seg-a",
      bucket: RENDERS_BUCKET,
      key: "projects/nashville/segments/seg-a.mp4",
      sourceBucket: REMOTION_BUCKET,
      sourceKey: "remotion/seg-a.mp4",
    },
    { segmentId: "seg-b", bucket: REMOTION_BUCKET, key: "remotion/seg-b.mp4" },
    { segmentId: "seg-unrendered" },
  ],
  segmentMetadata: [
    {
      segmentId: "seg-a",
      thumbnailKey: "thumbnails/projects/nashville/seg-a.jpg",
      descriptions: { short: "Short A" },
    },
    { segmentId: "seg-b", descriptions: { two_sentences: "Two sentences B" } },
  ],
};

const bourdain: ShowcaseProjectRow = {
  projectId: BOURDAIN_PROJECT_ID,
  assetId: "asset-bourdain",
  title: "Why the French don't suck",
  metadata: { assetType: "movie" },
  segments: [{ id: "seg-1", startTime: 0, endTime: 12 }],
  // No renders at all → series must be dropped.
  segmentRenders: [],
};

function testPureHelpers(): void {
  assertEqual(
    hueFromId(NASHVILLE_PROJECT_ID),
    hueFromId(NASHVILLE_PROJECT_ID),
    "hue is deterministic",
  );
  const hue = hueFromId(BOURDAIN_PROJECT_ID);
  assertTrue(hue >= 0 && hue < 360, "hue stays inside 0..359");
  assertTrue(
    hue !== hueFromId(NASHVILLE_PROJECT_ID),
    "different projects get different hues",
  );

  assertEqual(mapAssetKind("tv"), "series", "tv maps to series");
  assertEqual(
    mapAssetKind("MOVIE"),
    "film",
    "movie maps to film (case-insensitive)",
  );
  assertEqual(mapAssetKind("other"), "clip", "other maps to clip");
  assertEqual(mapAssetKind(null), "clip", "missing assetType maps to clip");

  assertEqual(
    resolveRenderLocation(
      {
        bucket: RENDERS_BUCKET,
        key: "projects/p1/segments/s1.mp4",
        sourceBucket: REMOTION_BUCKET,
        sourceKey: "remotion/s1.mp4",
      },
      RENDERS_BUCKET,
    ),
    { bucket: RENDERS_BUCKET, key: "projects/p1/segments/s1.mp4" },
    "prefers the CORS renders bucket copy",
  );
  assertEqual(
    resolveRenderLocation(
      {
        bucket: REMOTION_BUCKET,
        key: "remotion/s1.mp4",
        sourceBucket: RENDERS_BUCKET,
        sourceKey: "projects/p1/segments/s1.mp4",
      },
      RENDERS_BUCKET,
    ),
    { bucket: RENDERS_BUCKET, key: "projects/p1/segments/s1.mp4" },
    "falls back to source when that is the renders bucket",
  );
  assertEqual(
    resolveRenderLocation(
      { sourceBucket: REMOTION_BUCKET, sourceKey: "remotion/s1.mp4" },
      RENDERS_BUCKET,
    ),
    { bucket: REMOTION_BUCKET, key: "remotion/s1.mp4" },
    "falls back to the Remotion key when no copy exists",
  );
  assertEqual(
    resolveRenderLocation({ bucket: RENDERS_BUCKET }, RENDERS_BUCKET),
    null,
    "render row without an object is skipped",
  );

  assertEqual(
    resolveNote(
      { description: "  Segment description  " },
      { descriptions: { short: "Short metadata" } },
    ),
    "Segment description",
    "segment description wins",
  );
  assertEqual(
    resolveNote({}, { descriptions: { short: "Short metadata", two_sentences: "Longer." } }),
    "Short metadata",
    "falls back to short metadata",
  );
  assertEqual(
    resolveNote({ keyDialogue: '"Quote"' }, { descriptions: {} }),
    '"Quote"',
    "falls back to key dialogue",
  );
  assertEqual(resolveNote({}, {}), null, "no note when nothing is written");
}

async function testBuildCatalogue(): Promise<void> {
  const assetRows: ShowcaseAssetRow[] = [
    {
      assetId: "asset-nashville",
      originalName: "nashville_master.mov",
      duration: 1234.5678,
    },
  ];

  const presignedVideos: RenderLocation[] = [];
  const catalogue = await buildCatalogue({
    selections: [
      { projectId: NASHVILLE_PROJECT_ID, featured: true },
      { projectId: BOURDAIN_PROJECT_ID, featured: false },
      { projectId: "missing-project", featured: false },
    ],
    projects: [bourdain, nashville],
    assets: assetRows,
    preferredRenderBucket: RENDERS_BUCKET,
    presignVideo: async (location) => {
      presignedVideos.push(location);
      return `https://signed.example/${location.bucket}/${location.key}`;
    },
    presignThumbnail: async (key) => `https://cdn.example/${key}?sig=1`,
  });

  assertEqual(
    catalogue.series.length,
    1,
    "series without playable renders are dropped",
  );
  const series = catalogue.series[0];
  assertEqual(series.id, NASHVILLE_PROJECT_ID, "series id is the projectId");
  assertEqual(
    series.title,
    "Lionsgate Cut 081926",
    "series title comes from the project",
  );
  assertEqual(
    series.featured,
    true,
    "featured flag follows the hardcoded list",
  );
  assertEqual(
    series.hue,
    hueFromId(NASHVILLE_PROJECT_ID),
    "hue is hash(projectId) % 360",
  );
  assertEqual(
    series.tagline,
    "Cold open",
    "tagline is the first available episode note",
  );
  assertEqual(series.assetId, "asset-nashville", "series links its source asset");
  assertEqual(
    series.posterUrl,
    "https://cdn.example/thumbnails/projects/nashville/cover.jpg?sig=1",
    "series poster is the project cover",
  );

  const episodes = series.episodes;
  assertEqual(
    episodes.map((episode) => episode.id),
    ["seg-a", "seg-b"],
    "episodes are rendered segments sorted by startTime",
  );
  assertEqual(episodes[0].seriesId, NASHVILLE_PROJECT_ID, "episode links its series");
  assertEqual(episodes[0].sourceIn, 10, "sourceIn is startTime");
  assertEqual(episodes[0].sourceOut, 40, "sourceOut is endTime");
  assertEqual(episodes[0].durationSec, 30, "durationSec is endTime - startTime");
  assertEqual(
    episodes[1].durationSec,
    30.5,
    "durationSec keeps fractional seconds",
  );
  assertEqual(
    episodes[0].note,
    "Cold open",
    "episode note prefers the segment description",
  );
  assertEqual(
    episodes[1].note,
    "Two sentences B",
    "episode note falls back to generated metadata",
  );
  assertEqual(episodes[1].title, "Second", "episode title comes from the segment");
  assertEqual(
    episodes[0].videoUrl,
    "https://signed.example/zeevee-renders-dev/projects/nashville/segments/seg-a.mp4",
    "videoUrl presigns the renders-bucket copy",
  );
  assertEqual(
    episodes[1].videoUrl,
    "https://signed.example/remotionlambda-uswest2-0g1upoverr/remotion/seg-b.mp4",
    "videoUrl falls back to the Remotion key",
  );
  assertEqual(
    episodes[0].posterUrl,
    "https://cdn.example/thumbnails/projects/nashville/seg-a.jpg?sig=1",
    "episode poster prefers the segment thumbnail",
  );
  assertEqual(
    episodes[1].posterUrl,
    "https://cdn.example/thumbnails/projects/nashville/cover.jpg?sig=1",
    "episode poster falls back to the project cover",
  );
  assertEqual(
    presignedVideos.length,
    2,
    "only segments with a rendered object get presigned",
  );

  assertEqual(catalogue.assets.length, 1, "one SourceAsset per referenced asset");
  const asset = catalogue.assets[0];
  assertEqual(asset.id, "asset-nashville", "SourceAsset id is the assetId");
  assertEqual(asset.kind, "series", "SourceAsset kind comes from assetType");
  assertEqual(asset.assetType, "tv", "SourceAsset keeps the raw assetType");
  assertEqual(
    asset.originalName,
    "nashville_master.mov",
    "SourceAsset exposes originalName",
  );
  assertEqual(
    asset.durationSec,
    1234.568,
    "SourceAsset duration is rounded to millis",
  );
  assertEqual(
    asset.title,
    "nashville_master.mov",
    "SourceAsset title falls back to originalName",
  );
}

async function testMissingAssetRow(): Promise<void> {
  // An asset row we never read still yields a resolvable SourceAsset.
  const catalogue = await buildCatalogue({
    selections: [{ projectId: NASHVILLE_PROJECT_ID, featured: true }],
    projects: [nashville],
    assets: [],
    presignVideo: async () => "https://signed.example/v.mp4",
    presignThumbnail: async () => null,
  });

  assertEqual(
    catalogue.assets.length,
    1,
    "asset is emitted even when the assets row is missing",
  );
  assertEqual(
    catalogue.assets[0].durationSec,
    null,
    "missing duration stays null",
  );
  assertEqual(
    catalogue.assets[0].kind,
    "series",
    "kind still comes from project metadata",
  );
  assertEqual(
    catalogue.assets[0].title,
    "Lionsgate Cut 081926",
    "title falls back to the project title",
  );
  assertEqual(
    catalogue.series[0].episodes[0].posterUrl,
    null,
    "unpresignable poster stays null",
  );
}

async function main(): Promise<void> {
  testPureHelpers();
  await testBuildCatalogue();
  await testMissingAssetRow();

  if (failures > 0) {
    console.error(`FAILED: ${failures}/${checks} checks`);
    process.exit(1);
  }
  console.log(`OK: ${checks} showcase catalogue checks`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
