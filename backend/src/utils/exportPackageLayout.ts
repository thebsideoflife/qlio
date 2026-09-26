const ILLEGAL_FS_CHARS = new Set('<>:"/\\|?*');

export function sanitizeFolderName(name: string): string {
  let cleaned = "";
  for (const char of name) {
    const code = char.charCodeAt(0);
    if (code < 32 || ILLEGAL_FS_CHARS.has(char)) continue;
    cleaned += char;
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 80) || "Export";
}

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

export function safeExportFilenameBase(title: string): string {
  const slug = title
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
  return slug || "export";
}

function uniqueSlug(base: string, used: Set<string>): string {
  let slug = base;
  let n = 2;
  while (used.has(slug.toLowerCase())) {
    slug = `${base}_${n}`;
    n += 1;
  }
  used.add(slug.toLowerCase());
  return slug;
}

export interface ExportPackageLayout {
  rootFolder: string;
  posterFolder: string;
  posterFilename: string;
  posterPath: string;
  videoFolder: string;
  metadataFilename: string;
  zipFilename: string;
  scenes: Array<{
    segmentId: string;
    sceneNumber: number;
    slug: string;
    thumbnailFilename: string;
    thumbnailPath: string;
    videoFilename: string;
    videoPath: string;
  }>;
}

export function buildExportPackageLayout(params: {
  projectTitle: string;
  /**
   * sceneNumber is the scene's position in the full project (1-based), so a
   * partial export keeps Qlio's numbering. Falls back to export order.
   */
  scenes: Array<{ segmentId: string; title: string; sceneNumber?: number }>;
}): ExportPackageLayout {
  const rootFolder = sanitizeFolderName(params.projectTitle || "Untitled");
  const posterFolder = `${rootFolder} Poster Art`;
  const posterFilename = `${rootFolder} poster.jpg`;
  const videoFolder = `${rootFolder} Video Scenes`;
  const metadataFilename = `${safeExportFilenameBase(params.projectTitle)}-metadata.json`;
  const usedSlugs = new Set<string>();

  const scenes = params.scenes.map((scene, index) => {
    const sceneNumber = scene.sceneNumber ?? index + 1;
    const slug = uniqueSlug(sceneAssetSlug(scene.title), usedSlugs);
    const thumbnailFilename = `scene_${padSceneNumber(sceneNumber)}_${slug}.jpg`;
    const videoFilename = `scene_${padSceneNumber(sceneNumber)}_${slug}.mp4`;
    return {
      segmentId: scene.segmentId,
      sceneNumber,
      slug,
      thumbnailFilename,
      thumbnailPath: `${rootFolder}/${thumbnailFilename}`,
      videoFilename,
      videoPath: `${rootFolder}/${videoFolder}/${videoFilename}`,
    };
  });

  return {
    rootFolder,
    posterFolder,
    posterFilename,
    posterPath: `${rootFolder}/${posterFolder}/${posterFilename}`,
    videoFolder,
    metadataFilename,
    zipFilename: `${rootFolder}.zip`,
    scenes,
  };
}

export function localizeExportMetadataDocument(
  document: {
    projectThumbnailUrl?: string | null;
    scenes: Array<{ segmentId: string; thumbnailUrl?: string | null }>;
    [key: string]: unknown;
  },
  layout: ExportPackageLayout,
  options: {
    includePoster: boolean;
    includeThumbnails: boolean;
    includedThumbnailSegmentIds?: ReadonlySet<string>;
  },
): typeof document {
  const localized = {
    ...document,
    scenes: document.scenes.map((scene) => ({ ...scene })),
  };

  if (options.includePoster) {
    localized.projectThumbnailUrl = `${layout.posterFolder}/${layout.posterFilename}`;
  }

  if (options.includeThumbnails) {
    const byId = new Map(layout.scenes.map((s) => [s.segmentId, s]));
    localized.scenes = localized.scenes.map((scene) => {
      if (
        options.includedThumbnailSegmentIds &&
        !options.includedThumbnailSegmentIds.has(scene.segmentId)
      ) {
        return scene;
      }
      const entry = byId.get(scene.segmentId);
      if (!entry) return scene;
      return { ...scene, thumbnailUrl: entry.thumbnailFilename };
    });
  }

  return localized;
}

export function exportPackageObjectKey(
  projectId: string,
  jobId: string,
): string {
  return `projects/${projectId}/exports/${jobId}.zip`;
}
