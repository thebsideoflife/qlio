/**
 * Read-time mapping from Qlio rows to the `qlio-showcase` Catalogue shape
 * (qlio-showcase/src/data/types.ts: Catalogue, MicroSeries, Episode,
 * SourceAsset). Pure on purpose: the handler passes presigners in so the
 * mapping stays testable without AWS.
 *
 * Nothing here is persisted — the demo is a hardcoded project list plus a
 * mapping computed on every request.
 */

import { mapWithConcurrency } from "./concurrency";

export type SourceAssetKind = "series" | "film" | "clip";

export interface SourceAsset {
  /** Qlio assetId. */
  id: string;
  /** `project.metadata.assetType` mapped for the mobile app. */
  kind: SourceAssetKind;
  /** Raw Qlio assetType ("tv" | "movie" | "other"), null when unset. */
  assetType: string | null;
  title: string;
  originalName: string | null;
  durationSec: number | null;
}

export interface Episode {
  /** Qlio segmentId. */
  id: string;
  /** Owning MicroSeries.id (Qlio projectId). */
  seriesId: string;
  assetId: string | null;
  title: string;
  /** Segment description, else short generated metadata. */
  note: string | null;
  sourceIn: number;
  sourceOut: number;
  durationSec: number;
  /** Presigned segmentRenders object. */
  videoUrl: string;
  /** Presigned segment thumbnail, else the project cover. */
  posterUrl: string | null;
}

export interface MicroSeries {
  /** Qlio projectId. */
  id: string;
  title: string;
  tagline: string | null;
  /** hash(projectId) % 360 — stable accent colour for the app. */
  hue: number;
  featured: boolean;
  assetId: string | null;
  posterUrl: string | null;
  episodes: Episode[];
}

export interface Catalogue {
  assets: SourceAsset[];
  series: MicroSeries[];
}

/** projects table row, projected to what the showcase needs. */
export interface ShowcaseProjectRow {
  projectId: string;
  assetId?: string;
  title?: string;
  thumbnailKey?: string;
  segments?: Array<{
    id: string;
    startTime: number;
    endTime: number;
    title?: string;
    description?: string;
    keyDialogue?: string;
  }>;
  segmentRenders?: Array<{
    segmentId: string;
    title?: string;
    bucket?: string;
    key?: string;
    sourceBucket?: string;
    sourceKey?: string;
  }>;
  segmentMetadata?: Array<{
    segmentId: string;
    title?: string;
    descriptions?: {
      short?: string;
      two_sentences?: string;
      paragraph?: string;
    };
    thumbnailKey?: string;
  }>;
  metadata?: {
    assetType?: string | null;
    userPrompt?: string | null;
  } | null;
}

/** assets table row, projected to what the showcase needs. */
export interface ShowcaseAssetRow {
  assetId: string;
  title?: string;
  originalName?: string;
  duration?: number;
}

export interface RenderLocation {
  bucket: string;
  key: string;
}

export interface ShowcaseSelection {
  projectId: string;
  featured?: boolean;
}

export interface BuildCatalogueInput {
  /** Hardcoded demo list; its order is the response order. */
  selections: ShowcaseSelection[];
  projects: ShowcaseProjectRow[];
  assets: ShowcaseAssetRow[];
  /** Renders bucket (zeevee-renders-dev) preferred over Remotion-Lambda keys. */
  preferredRenderBucket?: string;
  presignVideo: (location: RenderLocation) => Promise<string | null>;
  presignThumbnail: (key: string) => Promise<string | null>;
}

/** Presigning is local CPU work, but keep the fan-out bounded anyway. */
const PRESIGN_CONCURRENCY = 6;

const KIND_BY_ASSET_TYPE: Record<string, SourceAssetKind> = {
  tv: "series",
  movie: "film",
};

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function firstText(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/** Deterministic series accent: FNV-1a over the projectId, folded to 0..359. */
export function hueFromId(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 360;
}

/** `assetType` ("tv" | "movie" | "other") → mobile `kind`. */
export function mapAssetKind(
  assetType: string | null | undefined,
): SourceAssetKind {
  const normalized =
    typeof assetType === "string" ? assetType.trim().toLowerCase() : "";
  return KIND_BY_ASSET_TYPE[normalized] ?? "clip";
}

/**
 * Object to presign for one rendered segment. Prefers the CORS renders bucket
 * copy (`bucket`/`key`, e.g. zeevee-renders-dev) over the Remotion-Lambda
 * working key (`sourceBucket`/`sourceKey`).
 */
export function resolveRenderLocation(
  render: {
    bucket?: string;
    key?: string;
    sourceBucket?: string;
    sourceKey?: string;
  },
  preferredBucket?: string,
): RenderLocation | null {
  const copy =
    render.bucket && render.key
      ? { bucket: render.bucket, key: render.key }
      : null;
  const source =
    render.sourceBucket && render.sourceKey
      ? { bucket: render.sourceBucket, key: render.sourceKey }
      : null;

  if (preferredBucket) {
    if (copy && copy.bucket === preferredBucket) return copy;
    if (source && source.bucket === preferredBucket) return source;
  }
  return copy ?? source;
}

/** `tagline` / `Episode.note`: segment description, else short metadata. */
export function resolveNote(
  segment:
    | { description?: string; keyDialogue?: string }
    | undefined
    | null,
  metadata:
    | {
        descriptions?: {
          short?: string;
          two_sentences?: string;
          paragraph?: string;
        };
      }
    | undefined
    | null,
): string | null {
  return firstText(
    segment?.description,
    metadata?.descriptions?.short,
    metadata?.descriptions?.two_sentences,
    segment?.keyDialogue,
    metadata?.descriptions?.paragraph,
  );
}

function buildSourceAsset(
  assetId: string,
  assetRow: ShowcaseAssetRow | undefined,
  project: ShowcaseProjectRow,
): SourceAsset {
  const assetType = project.metadata?.assetType ?? null;
  return {
    id: assetId,
    kind: mapAssetKind(assetType),
    assetType: firstText(assetType),
    title:
      firstText(assetRow?.title, assetRow?.originalName, project.title) ??
      "Untitled source",
    originalName: firstText(assetRow?.originalName),
    durationSec:
      typeof assetRow?.duration === "number" && Number.isFinite(assetRow.duration)
        ? round3(assetRow.duration)
        : null,
  };
}

/**
 * Build the mobile Catalogue for the hardcoded demo projects.
 *
 * Episodes are exactly the project segments that have a `segmentRenders` row
 * pointing at a presignable object; series with no playable episode are
 * dropped so the app never renders an empty card.
 */
export async function buildCatalogue(
  input: BuildCatalogueInput,
): Promise<Catalogue> {
  const projectById = new Map(
    input.projects.map((project) => [project.projectId, project]),
  );
  const assetRowById = new Map(
    input.assets.map((asset) => [asset.assetId, asset]),
  );
  const assets = new Map<string, SourceAsset>();
  const series: MicroSeries[] = [];

  for (const selection of input.selections) {
    const project = projectById.get(selection.projectId);
    if (!project) {
      console.warn(
        `[showcase] configured project ${selection.projectId} not found`,
      );
      continue;
    }

    const rendersBySegment = new Map(
      (project.segmentRenders ?? [])
        .filter((render) => typeof render?.segmentId === "string")
        .map((render) => [render.segmentId, render]),
    );
    const metadataBySegment = new Map(
      (project.segmentMetadata ?? [])
        .filter((entry) => typeof entry?.segmentId === "string")
        .map((entry) => [entry.segmentId, entry]),
    );

    const segments = [...(project.segments ?? [])]
      .filter(
        (segment) =>
          typeof segment?.id === "string" &&
          typeof segment.startTime === "number" &&
          typeof segment.endTime === "number",
      )
      .sort((a, b) => a.startTime - b.startTime);

    const built = await mapWithConcurrency(
      segments,
      PRESIGN_CONCURRENCY,
      async (segment, index): Promise<Episode | null> => {
        const render = rendersBySegment.get(segment.id);
        if (!render) return null; // not rendered → not an episode

        const location = resolveRenderLocation(
          render,
          input.preferredRenderBucket,
        );
        if (!location) {
          console.warn(
            `[showcase] segment ${segment.id} has a render row without an object`,
          );
          return null;
        }

        const videoUrl = await input.presignVideo(location);
        if (!videoUrl) {
          console.warn(`[showcase] could not presign render ${location.key}`);
          return null;
        }

        const metadata = metadataBySegment.get(segment.id);
        const posterKey = firstText(
          metadata?.thumbnailKey,
          project.thumbnailKey,
        );
        const posterUrl = posterKey
          ? await input.presignThumbnail(posterKey)
          : null;

        return {
          id: segment.id,
          seriesId: project.projectId,
          assetId: firstText(project.assetId),
          title:
            firstText(segment.title, metadata?.title, render.title) ??
            `Part ${index + 1}`,
          note: resolveNote(segment, metadata),
          sourceIn: segment.startTime,
          sourceOut: segment.endTime,
          durationSec: round3(segment.endTime - segment.startTime),
          videoUrl,
          posterUrl,
        };
      },
    );

    const episodes = built.filter((episode): episode is Episode => !!episode);
    if (episodes.length === 0) {
      console.warn(
        `[showcase] project ${project.projectId} has no playable rendered segments`,
      );
      continue;
    }

    const assetId = firstText(project.assetId);
    if (assetId && !assets.has(assetId)) {
      assets.set(
        assetId,
        buildSourceAsset(assetId, assetRowById.get(assetId), project),
      );
    }

    const posterKey = firstText(project.thumbnailKey);
    series.push({
      id: project.projectId,
      title: firstText(project.title) ?? "Untitled series",
      tagline: episodes.find((episode) => episode.note)?.note ?? null,
      hue: hueFromId(project.projectId),
      featured: selection.featured === true,
      assetId,
      posterUrl: posterKey ? await input.presignThumbnail(posterKey) : null,
      episodes,
    });
  }

  return { assets: [...assets.values()], series };
}
