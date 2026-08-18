import JSZip from "jszip";
import {
  safeExportFilenameBase,
  type ExportMetadataDocument,
} from "./exportMetadataJson";

const ILLEGAL_FS_CHARS = new Set('<>:"/\\|?*');
// JSZip keeps source blobs and the generated archive in browser memory.
// Bound that peak instead of allowing large deliveries to crash the tab.
const MAX_CLIENT_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_CLIENT_ARCHIVE_LABEL = "512 MB";

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

export interface ExportPackageSceneInput {
  segmentId: string;
  title: string;
  videoUrl?: string | null;
  thumbnailUrl?: string | null;
}

export interface ExportPackageProgress {
  phase: "downloading" | "archiving";
  completed: number;
  total: number;
  label: string;
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

export function buildExportPackageLayout(params: {
  projectTitle: string;
  scenes: Array<{ segmentId: string; title: string }>;
}): ExportPackageLayout {
  const rootFolder = sanitizeFolderName(params.projectTitle || "Untitled");
  const posterFolder = `${rootFolder} Poster Art`;
  const posterFilename = `${rootFolder} poster.jpg`;
  const videoFolder = `${rootFolder} Video Scenes`;
  const metadataFilename = `${safeExportFilenameBase(params.projectTitle)}-metadata.json`;
  const usedSlugs = new Set<string>();

  const scenes = params.scenes.map((scene, index) => {
    const sceneNumber = index + 1;
    const slug = uniqueSlug(sceneAssetSlug(scene.title), usedSlugs);
    const thumbnailFilename = `scene_${padSceneNumber(sceneNumber)}_${slug}.jpg`;
    const videoFilename = `${slug}.mp4`;
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
  document: ExportMetadataDocument,
  layout: ExportPackageLayout,
  options: {
    includePoster: boolean;
    includeThumbnails: boolean;
    includedThumbnailSegmentIds?: ReadonlySet<string>;
  },
): ExportMetadataDocument {
  const localized: ExportMetadataDocument = {
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

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function fetchAssetBlob(
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ blob: Blob; bytes: number }> {
  const response = await fetch(url, { mode: "cors", signal });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status})`);
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(
      `Delivery package exceeds the ${MAX_CLIENT_ARCHIVE_LABEL} browser limit. Download scene videos individually.`,
    );
  }

  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > maxBytes) {
      throw new Error(
        `Delivery package exceeds the ${MAX_CLIENT_ARCHIVE_LABEL} browser limit. Download scene videos individually.`,
      );
    }
    return { blob, bytes: blob.size };
  }

  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error(
        `Delivery package exceeds the ${MAX_CLIENT_ARCHIVE_LABEL} browser limit. Download scene videos individually.`,
      );
    }
    chunks.push(value);
  }
  return {
    blob: new Blob(chunks, {
      type: response.headers.get("content-type") || "application/octet-stream",
    }),
    bytes,
  };
}

export interface DownloadExportPackageParams {
  projectTitle: string;
  scenes: ExportPackageSceneInput[];
  posterUrl?: string | null;
  metadataDocument?: ExportMetadataDocument | null;
  includeThumbnails?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: ExportPackageProgress) => void;
}

/**
 * Fetches rendered videos, poster art, and scene thumbnails, then downloads a
 * zip whose internal folders match the delivery layout:
 *
 *   {Title}/
 *     {Title} Poster Art/{Title} poster.jpg
 *     scene_01_{Scene}.jpg
 *     {Title} Video Scenes/{Scene}.mp4
 *     {kebab-title}-metadata.json
 */
export async function downloadExportPackage(
  params: DownloadExportPackageParams,
): Promise<{ warnings: string[] }> {
  const {
    projectTitle,
    scenes,
    posterUrl,
    metadataDocument,
    includeThumbnails = true,
    signal,
    onProgress,
  } = params;

  const layout = buildExportPackageLayout({
    projectTitle,
    scenes: scenes.map((s) => ({ segmentId: s.segmentId, title: s.title })),
  });
  const layoutById = new Map(layout.scenes.map((s) => [s.segmentId, s]));
  const warnings: string[] = [];

  type PendingFile = {
    path: string;
    url: string;
    compression: "STORE" | "DEFLATE";
    required: boolean;
    label: string;
  };

  const pending: PendingFile[] = [];

  for (const scene of scenes) {
    const entry = layoutById.get(scene.segmentId);
    if (!entry) continue;
    if (scene.videoUrl) {
      pending.push({
        path: entry.videoPath,
        url: scene.videoUrl,
        compression: "STORE",
        required: true,
        label: entry.videoFilename,
      });
    } else {
      warnings.push(`No rendered video for ${entry.videoFilename}`);
    }
    if (includeThumbnails && scene.thumbnailUrl) {
      pending.push({
        path: entry.thumbnailPath,
        url: scene.thumbnailUrl,
        compression: "DEFLATE",
        required: false,
        label: entry.thumbnailFilename,
      });
    }
  }

  if (includeThumbnails && posterUrl) {
    pending.push({
      path: layout.posterPath,
      url: posterUrl,
      compression: "DEFLATE",
      required: false,
      label: layout.posterFilename,
    });
  }

  if (pending.filter((f) => f.required).length === 0) {
    throw new Error("No rendered scene videos are ready to download.");
  }

  const zip = new JSZip();
  const archivedPaths = new Set<string>();
  let downloadedBytes = 0;
  let completed = 0;
  const total = pending.length + 1;

  const reportDownload = () => {
    onProgress?.({
      phase: "downloading",
      completed,
      total,
      label: `Downloading assets ${completed} of ${pending.length}`,
    });
  };
  reportDownload();

  // Fetch required videos first and one at a time. This keeps the memory bound
  // deterministic and lets optional artwork be skipped if it would exceed it.
  const orderedPending = [...pending].sort(
    (a, b) => Number(b.required) - Number(a.required),
  );
  for (const file of orderedPending) {
    signal?.throwIfAborted();
    try {
      const { blob, bytes } = await fetchAssetBlob(
        file.url,
        MAX_CLIENT_ARCHIVE_BYTES - downloadedBytes,
        signal,
      );
      downloadedBytes += bytes;
      zip.file(file.path, blob, { compression: file.compression });
      archivedPaths.add(file.path);
    } catch (err) {
      if (signal?.aborted) throw err;
      const message =
        err instanceof Error ? err.message : "Download failed";
      if (file.required) {
        throw new Error(`Could not download ${file.label}: ${message}`);
      }
      warnings.push(`Skipped ${file.label}: ${message}`);
    } finally {
      completed += 1;
      reportDownload();
    }
  }

  if (metadataDocument) {
    const localized = localizeExportMetadataDocument(metadataDocument, layout, {
      includePoster: archivedPaths.has(layout.posterPath),
      includeThumbnails,
      includedThumbnailSegmentIds: new Set(
        layout.scenes
          .filter((scene) => archivedPaths.has(scene.thumbnailPath))
          .map((scene) => scene.segmentId),
      ),
    });
    zip.file(
      `${layout.rootFolder}/${layout.metadataFilename}`,
      JSON.stringify(localized, null, 2),
      { compression: "DEFLATE" },
    );
  }

  onProgress?.({
    phase: "archiving",
    completed: pending.length,
    total,
    label: "Building download folder…",
  });

  const archive = await zip.generateAsync(
    { type: "blob", streamFiles: true, compression: "STORE" },
    (metadata) => {
      onProgress?.({
        phase: "archiving",
        completed: pending.length,
        total,
        label: `Building download folder… ${Math.round(metadata.percent)}%`,
      });
    },
  );

  signal?.throwIfAborted();
  triggerBlobDownload(archive, layout.zipFilename);

  onProgress?.({
    phase: "archiving",
    completed: total,
    total,
    label: "Download started",
  });

  return { warnings };
}
