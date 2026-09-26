/**
 * Delivery-folder layout for the export package.
 *
 * Run: npx tsx src/lib/exportPackage.test.ts
 */
import {
  applyFreshVideoUrls,
  buildExportPackageLayout,
  localizeExportMetadataDocument,
  padSceneNumber,
  sanitizeFolderName,
  sceneAssetSlug,
} from "./exportPackage";
import {
  EXPORT_METADATA_VERSION,
  type ExportMetadataDocument,
} from "./exportMetadataJson";

let checks = 0;
let failures = 0;

function assert(condition: boolean, message: string): void {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assert(
    actual === expected,
    `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

{
  assertEqual(
    sanitizeFolderName("Remembering Hayden Panettiere"),
    "Remembering Hayden Panettiere",
    "keeps project title spaces",
  );
  assertEqual(
    sanitizeFolderName('Foo / Bar: "Baz"?'),
    "Foo Bar Baz",
    "strips illegal filename characters",
  );
  assertEqual(sanitizeFolderName("   "), "Export", "falls back when empty");
}

{
  assertEqual(
    sceneAssetSlug("Juliette Woos Deacon"),
    "Juliette_Woos_Deacon",
    "underscores scene titles",
  );
  assertEqual(
    sceneAssetSlug("1. Mother calls Juliette"),
    "Mother_calls_Juliette",
    "strips leading scene numbers",
  );
  assertEqual(
    sceneAssetSlug("Never Gonna Find Another Love Like Mine"),
    "Never_Gonna_Find_Another_Love_Like_Mine",
    "long title slug",
  );
  assertEqual(padSceneNumber(1), "01", "pads scene 1");
  assertEqual(padSceneNumber(12), "12", "does not pad scene 12");
}

{
  const layout = buildExportPackageLayout({
    projectTitle: "Remembering Hayden Panettiere",
    scenes: [
      { segmentId: "a", title: "Juliette Woos Deacon" },
      { segmentId: "b", title: "Mother calls Juliette" },
      { segmentId: "c", title: "Never Gonna Find Another Love Like Mine" },
    ],
  });

  assertEqual(
    layout.rootFolder,
    "Remembering Hayden Panettiere",
    "root folder is the project title",
  );
  assertEqual(
    layout.posterFolder,
    "Remembering Hayden Panettiere Poster Art",
    "poster art folder",
  );
  assertEqual(
    layout.posterFilename,
    "Remembering Hayden Panettiere poster.jpg",
    "poster filename",
  );
  assertEqual(
    layout.posterPath,
    "Remembering Hayden Panettiere/Remembering Hayden Panettiere Poster Art/Remembering Hayden Panettiere poster.jpg",
    "poster path",
  );
  assertEqual(
    layout.videoFolder,
    "Remembering Hayden Panettiere Video Scenes",
    "video scenes folder",
  );
  assertEqual(
    layout.metadataFilename,
    "remembering-hayden-panettiere-metadata.json",
    "kebab-case metadata filename",
  );
  assertEqual(
    layout.zipFilename,
    "Remembering Hayden Panettiere.zip",
    "zip filename",
  );

  assertEqual(
    layout.scenes[0].thumbnailFilename,
    "scene_01_Juliette_Woos_Deacon.jpg",
    "scene 1 thumbnail",
  );
  assertEqual(
    layout.scenes[0].videoFilename,
    "scene_01_Juliette_Woos_Deacon.mp4",
    "scene 1 video shares the thumbnail scene prefix",
  );
  assertEqual(
    layout.scenes[0].videoPath,
    "Remembering Hayden Panettiere/Remembering Hayden Panettiere Video Scenes/scene_01_Juliette_Woos_Deacon.mp4",
    "scene 1 video path",
  );
  assertEqual(
    layout.scenes[0].thumbnailPath,
    "Remembering Hayden Panettiere/scene_01_Juliette_Woos_Deacon.jpg",
    "scene thumbnails live at package root",
  );
  assertEqual(
    layout.scenes[1].thumbnailFilename,
    "scene_02_Mother_calls_Juliette.jpg",
    "scene 2 thumbnail",
  );
  assertEqual(
    layout.scenes[2].thumbnailFilename,
    "scene_03_Never_Gonna_Find_Another_Love_Like_Mine.jpg",
    "scene 3 thumbnail",
  );
}

{
  const layout = buildExportPackageLayout({
    projectTitle: "Dupe",
    scenes: [
      { segmentId: "a", title: "Cold Open" },
      { segmentId: "b", title: "Cold Open" },
    ],
  });
  assertEqual(layout.scenes[0].videoFilename, "scene_01_Cold_Open.mp4", "first duplicate");
  assertEqual(
    layout.scenes[1].videoFilename,
    "scene_02_Cold_Open_2.mp4",
    "second duplicate gets a suffix",
  );
}

{
  const layout = buildExportPackageLayout({
    projectTitle: "Remembering Hayden Panettiere",
    scenes: [{ segmentId: "a", title: "Juliette Woos Deacon" }],
  });
  const document: ExportMetadataDocument = {
    exportVersion: EXPORT_METADATA_VERSION,
    projectId: "p1",
    projectTitle: "Remembering Hayden Panettiere",
    exportedAt: "2026-08-18T00:00:00.000Z",
    options: {},
    projectThumbnailUrl: "https://cdn.example/cover.jpg?sig=1",
    scenes: [
      {
        sceneNumber: 1,
        segmentId: "a",
        editorTitle: "Juliette Woos Deacon",
        startTimeSec: 0,
        endTimeSec: 10,
        durationSec: 10,
        thumbnailUrl: "https://cdn.example/thumb.jpg?sig=1",
      },
    ],
  };
  const localized = localizeExportMetadataDocument(document, layout, {
    includePoster: true,
    includeThumbnails: true,
  });
  assertEqual(
    localized.projectThumbnailUrl,
    "Remembering Hayden Panettiere Poster Art/Remembering Hayden Panettiere poster.jpg",
    "metadata poster path is local",
  );
  assertEqual(
    localized.scenes[0].thumbnailUrl,
    "scene_01_Juliette_Woos_Deacon.jpg",
    "metadata thumbnail path is local",
  );
  assertEqual(
    document.projectThumbnailUrl,
    "https://cdn.example/cover.jpg?sig=1",
    "does not mutate the original document",
  );

  const partial = localizeExportMetadataDocument(document, layout, {
    includePoster: false,
    includeThumbnails: true,
    includedThumbnailSegmentIds: new Set(),
  });
  assertEqual(
    partial.projectThumbnailUrl,
    document.projectThumbnailUrl,
    "does not localize a poster that was not archived",
  );
  assertEqual(
    partial.scenes[0].thumbnailUrl,
    document.scenes[0].thumbnailUrl,
    "does not localize a thumbnail that was not archived",
  );
}

{
  const scenes = [
    { segmentId: "a", title: "One", videoUrl: "https://old/a.mp4" },
    { segmentId: "b", title: "Two", videoUrl: "https://old/b.mp4" },
    { segmentId: "c", title: "Three" },
  ];
  const refreshed = applyFreshVideoUrls(
    scenes,
    new Map([
      ["a", "https://fresh/a.mp4"],
      ["c", "https://fresh/c.mp4"],
    ]),
  );
  assertEqual(
    refreshed[0].videoUrl,
    "https://fresh/a.mp4",
    "replaces a stale scene URL",
  );
  assertEqual(
    refreshed[1].videoUrl,
    "https://old/b.mp4",
    "keeps URLs that were not refreshed",
  );
  assertEqual(
    refreshed[2].videoUrl,
    "https://fresh/c.mp4",
    "fills a missing scene URL",
  );
  assertEqual(scenes[0].videoUrl, "https://old/a.mp4", "does not mutate input");
}

if (failures > 0) {
  console.error(`FAILED: ${failures}/${checks} checks`);
  process.exit(1);
}

console.log(`OK: ${checks} export package checks`);
