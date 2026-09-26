/**
 * Delivery-package filenames must carry each scene's project number, so a
 * partial export (e.g. only scene 6) is not renumbered from 1.
 *
 * Run: npx tsx src/utils/exportPackageLayout.test.ts
 */
import { buildExportPackageLayout } from "./exportPackageLayout";

let checks = 0;
let failures = 0;

function assertEqual<T>(actual: T, expected: T, message: string): void {
  checks++;
  if (actual !== expected) {
    failures++;
    console.error(
      `  FAIL: ${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

{
  const layout = buildExportPackageLayout({
    projectTitle: "Partial",
    scenes: [{ segmentId: "f", title: "6. Scene Six", sceneNumber: 6 }],
  });
  assertEqual(
    layout.scenes[0].thumbnailFilename,
    "scene_06_Scene_Six.jpg",
    "lone scene 6 thumbnail is not renumbered",
  );
  assertEqual(
    layout.scenes[0].videoFilename,
    "scene_06_Scene_Six.mp4",
    "lone scene 6 video is not renumbered",
  );
  assertEqual(layout.scenes[0].sceneNumber, 6, "layout sceneNumber");
}

{
  const layout = buildExportPackageLayout({
    projectTitle: "Fallback",
    scenes: [
      { segmentId: "a", title: "One" },
      { segmentId: "b", title: "Two" },
    ],
  });
  assertEqual(
    layout.scenes[1].thumbnailFilename,
    "scene_02_Two.jpg",
    "falls back to export order without a sceneNumber",
  );
}

if (failures > 0) {
  console.error(`FAILED: ${failures}/${checks} checks`);
  process.exit(1);
}

console.log(`OK: ${checks} export package layout checks`);
