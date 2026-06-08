import type {
  ExportMetadataFingerprintOptions,
  SegmentMetadataCache,
} from "./segmentMetadataFingerprint";
import { normalizeContentAdvisory } from "./segmentMetadataFingerprint";

export { normalizeContentAdvisory };

export const EXPORT_METADATA_VERSION = 1 as const;

export interface ExportSceneMetadata {
  sceneNumber: number;
  segmentId: string;
  editorTitle: string;
  startTimeSec: number;
  endTimeSec: number;
  durationSec: number;
  title?: string;
  descriptions?: {
    short?: string;
    two_sentences?: string;
    paragraph?: string;
  };
  tags?: {
    content_advisory?: string;
    mood?: string;
    theme?: string;
    tone?: string;
  };
  thumbnailUrl?: string | null;
}

export interface ExportMetadataDocument {
  exportVersion: typeof EXPORT_METADATA_VERSION;
  projectId: string;
  projectTitle: string;
  exportedAt: string;
  options: ExportMetadataFingerprintOptions;
  projectThumbnailUrl?: string | null;
  scenes: ExportSceneMetadata[];
}

interface BuildParams {
  projectId: string;
  projectTitle: string;
  projectThumbnailUrl?: string | null;
  segments: Array<{
    id: string;
    startTime: number;
    endTime: number;
    title: string;
  }>;
  selectedSegmentIds: Set<string>;
  metadataBySegmentId: Map<string, SegmentMetadataCache>;
  options: ExportMetadataFingerprintOptions;
}

function pickDescriptions(
  meta: SegmentMetadataCache | undefined,
  options: ExportMetadataFingerprintOptions,
): ExportSceneMetadata["descriptions"] | undefined {
  if (options.includeDescriptions === false || !meta?.descriptions) {
    return undefined;
  }
  const lengths = new Set(
    options.descriptionLengths ?? ["short", "two_sentences", "paragraph"],
  );
  const out: NonNullable<ExportSceneMetadata["descriptions"]> = {};
  if (lengths.has("short") && meta.descriptions.short) {
    out.short = meta.descriptions.short;
  }
  if (lengths.has("two_sentences") && meta.descriptions.two_sentences) {
    out.two_sentences = meta.descriptions.two_sentences;
  }
  if (lengths.has("paragraph") && meta.descriptions.paragraph) {
    out.paragraph = meta.descriptions.paragraph;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function pickTags(
  meta: SegmentMetadataCache | undefined,
  options: ExportMetadataFingerprintOptions,
): ExportSceneMetadata["tags"] | undefined {
  const flags = options.descriptiveTags;
  if (!flags || !meta?.tags) return undefined;

  const out: NonNullable<ExportSceneMetadata["tags"]> = {};
  const contentAdvisory = normalizeContentAdvisory(meta.tags.content_advisory);
  if (flags.contentAdvisory && contentAdvisory) {
    out.content_advisory = contentAdvisory;
  }
  if (flags.mood && meta.tags.mood) {
    out.mood = meta.tags.mood;
  }
  if (flags.theme && meta.tags.theme) {
    out.theme = meta.tags.theme;
  }
  if (flags.tone && meta.tags.tone) {
    out.tone = meta.tags.tone;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function buildExportMetadataDocument(
  params: BuildParams,
): ExportMetadataDocument {
  const {
    projectId,
    projectTitle,
    projectThumbnailUrl,
    segments,
    selectedSegmentIds,
    metadataBySegmentId,
    options,
  } = params;

  const selected = segments.filter((s) => selectedSegmentIds.has(s.id));

  const scenes: ExportSceneMetadata[] = selected.map((seg, index) => {
    const meta = metadataBySegmentId.get(seg.id);
    const scene: ExportSceneMetadata = {
      sceneNumber: index + 1,
      segmentId: seg.id,
      editorTitle: seg.title,
      startTimeSec: seg.startTime,
      endTimeSec: seg.endTime,
      durationSec: Math.max(0, seg.endTime - seg.startTime),
    };

    if (options.includeTitles !== false) {
      const clean = seg.title.replace(/^\d+\.\s*/, "").trim();
      scene.title = clean || seg.title;
    }

    const descriptions = pickDescriptions(meta, options);
    if (descriptions) scene.descriptions = descriptions;

    const tags = pickTags(meta, options);
    if (tags) scene.tags = tags;

    if (options.includeThumbnails !== false && meta?.thumbnailUrl) {
      scene.thumbnailUrl = meta.thumbnailUrl;
    }

    return scene;
  });

  return {
    exportVersion: EXPORT_METADATA_VERSION,
    projectId,
    projectTitle,
    exportedAt: new Date().toISOString(),
    options,
    projectThumbnailUrl:
      options.includeThumbnails !== false ? projectThumbnailUrl : undefined,
    scenes,
  };
}

export function safeExportFilenameBase(title: string): string {
  const slug = title
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
  return slug || "export";
}

export function downloadExportMetadataJson(
  document: ExportMetadataDocument,
  filenameBase?: string,
): void {
  const base = safeExportFilenameBase(
    filenameBase ?? document.projectTitle ?? "export",
  );
  const blob = new Blob([JSON.stringify(document, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = window.document.createElement("a");
  a.href = url;
  a.download = `${base}-metadata.json`;
  a.click();
  URL.revokeObjectURL(url);
}
