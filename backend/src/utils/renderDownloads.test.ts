/**
 * Render download helpers.
 *
 * Run: npx tsx src/utils/renderDownloads.test.ts
 */
import { corsRenderObjectKey } from "./renderDownloads";

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

assertEqual(
  corsRenderObjectKey("proj-1", "seg-2"),
  "projects/proj-1/segments/seg-2.mp4",
  "stable CORS-bucket object key",
);
assertEqual(
  corsRenderObjectKey("proj-1", "seg-2", "webm"),
  "projects/proj-1/segments/seg-2.webm",
  "honors output extension",
);

if (failures > 0) {
  console.error(`FAILED: ${failures}/${checks} checks`);
  process.exit(1);
}

console.log(`OK: ${checks} render download checks`);
