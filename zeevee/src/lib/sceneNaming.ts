/**
 * Scene file naming shared by the delivery package and single-scene downloads.
 * Kept dependency-free so the editor can use it without pulling in JSZip.
 * Mirrors backend/src/utils/exportPackageLayout.ts.
 */

export function sceneAssetSlug(title: string): string {
  const clean = title.replace(/^\d+\.\s*/, "").trim();
  const slug = clean
    .replace(/[^a-zA-Z0-9\s-_]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 80)
    .replace(/^_+|_+$/g, "");
  return slug || "scene";
}

export function padSceneNumber(sceneNumber: number): string {
  return String(Math.max(1, sceneNumber)).padStart(2, "0");
}

/** Filename a single scene video downloads as, matching the package layout. */
export function sceneVideoFilename(sceneNumber: number, title: string): string {
  return `scene_${padSceneNumber(sceneNumber)}_${sceneAssetSlug(title)}.mp4`;
}
