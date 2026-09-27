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

/** Filename a single scene video downloads as, matching the package layout. */
export function sceneVideoFilename(sceneNumber: number, title: string): string {
  return `scene_${padSceneNumber(sceneNumber)}_${sceneAssetSlug(title)}.mp4`;
}

export function safeExportFilenameBase(title: string): string {
  const slug = title
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
  return slug || "export";
}

/**
 * "2026-09-27 1542" in the producer's time zone, for the zip name only. An
 * unknown zone falls back to UTC rather than failing the export.
 */
export function zipTimestamp(at: Date, timeZone?: string): string {
  const format = (zone: string) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(at)
        .map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}${parts.minute}`;
  };
  try {
    return format(timeZone || "UTC");
  } catch {
    return format("UTC");
  }
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
  /** When set, the zip (only) is named "<Project> 2026-09-27 1542.zip". */
  exportedAt?: Date;
  timeZone?: string;
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
    zipFilename: params.exportedAt
      ? `${rootFolder} ${zipTimestamp(params.exportedAt, params.timeZone)}.zip`
      : `${rootFolder}.zip`,
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
