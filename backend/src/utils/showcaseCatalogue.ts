/**
 * Read-time mapping from Qlio rows to the `qlio-showcase` Catalogue shape
 * (qlio-showcase/src/data/types.ts). Extra fields the app ignores are not
 * emitted — the feed, source rows, and "Part N" chrome all crash or go blank
 * if `filename` / `sourceAssetId` / `tags` / `index` are missing.
 */

import { mapWithConcurrency } from "./concurrency";

export type SourceKind =
  | "episode"
  | "film"
  | "documentary"
  | "sports"
  | "reality"
  | "talk";

export interface SourceAsset {
  id: string;
  title: string;
  filename: string;
  kind: SourceKind;
  durationSec: number;
  posterUrl?: string | null;
  seriesIds: string[];
}

export interface Episode {
  id: string;
  index: number;
  title: string;
  durationSec: number;
  sourceIn: number;
  sourceOut: number;
  videoUrl?: string | null;
  posterUrl?: string | null;
  note?: string;
}

export interface MicroSeries {
  id: string;
  title: string;
  tagline: string;
  sourceAssetId: string;
  tags: string[];
  episodes: Episode[];
  hue: number;
  featured?: boolean;
}

export interface Catalogue {
  assets: SourceAsset[];
  series: MicroSeries[];
}

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
    tags?: {
      iab?: { labels?: string[] };
    };
  }>;
  metadata?: {
    assetType?: string | null;
    format?: string | null;
  } | null;
}

export interface ShowcaseAssetRow {
  assetId: string;
  title?: string;
  originalName?: string;
  fileName?: string;
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
  selections: ShowcaseSelection[];
  projects: ShowcaseProjectRow[];
  assets: ShowcaseAssetRow[];
  preferredRenderBucket?: string;
  presignVideo: (location: RenderLocation) => Promise<string | null>;
  presignThumbnail: (key: string) => Promise<string | null>;
}

const PRESIGN_CONCURRENCY = 6;

const KIND_TAG: Record<SourceKind, string> = {
  episode: "Episode",
  film: "Feature",
  documentary: "Documentary",
  sports: "Sports",
  reality: "Reality",
  talk: "Talk",
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

function stripExtension(name: string): string {
  return name.replace(/\.(mp4|mov|m4v|mkv|webm)$/i, "");
}

/** Human title for the source catalogue; `filename` keeps the dashboard name. */
export function humanizeSourceTitle(filename: string): string {
  const base = stripExtension(filename).trim();
  if (!base) return "Untitled source";
  if (/LG_NASHVILLE/i.test(base)) return "Nashville";
  if (/bourdain/i.test(base) && /no reservations/i.test(base)) {
    return "No Reservations — Paris";
  }
  if (/_/.test(base) && base === base.toUpperCase()) {
    return base.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  }
  return base;
}

export function hueFromId(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 360;
}

export function mapAssetKind(
  assetType: string | null | undefined,
  filename?: string | null,
): SourceKind {
  const name = (filename ?? "").toLowerCase();
  if (/bourdain|no reservations|documentary|fbi files/.test(name)) {
    return "documentary";
  }
  if (/mariners|padres|pickleball|sport/.test(name)) return "sports";
  const normalized =
    typeof assetType === "string" ? assetType.trim().toLowerCase() : "";
  if (normalized === "movie") return "film";
  return "episode";
}

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
): string | undefined {
  return (
    firstText(
      segment?.description,
      metadata?.descriptions?.short,
      metadata?.descriptions?.two_sentences,
      segment?.keyDialogue,
      metadata?.descriptions?.paragraph,
    ) ?? undefined
  );
}

function seriesTags(
  kind: SourceKind,
  episodeCount: number,
  metadataRows: NonNullable<ShowcaseProjectRow["segmentMetadata"]>,
): string[] {
  const tags: string[] = [`${episodeCount} part${episodeCount === 1 ? "" : "s"}`];
  tags.push(KIND_TAG[kind]);
  const iab = new Set<string>();
  for (const row of metadataRows) {
    for (const label of row.tags?.iab?.labels ?? []) {
      const trimmed = label.trim();
      if (trimmed && trimmed.toLowerCase() !== "clip") iab.add(trimmed);
    }
  }
  for (const label of iab) {
    if (tags.length >= 3) break;
    if (!tags.includes(label)) tags.push(label);
  }
  return tags;
}

export async function buildCatalogue(
  input: BuildCatalogueInput,
): Promise<Catalogue> {
  const projectById = new Map(
    input.projects.map((project) => [project.projectId, project]),
  );
  const assetRowById = new Map(
    input.assets.map((asset) => [asset.assetId, asset]),
  );
  const series: MicroSeries[] = [];
  const seriesIdsByAsset = new Map<string, string[]>();
  const posterByAsset = new Map<string, string | null>();
  const assetMeta = new Map<
    string,
    { filename: string; title: string; kind: SourceKind; durationSec: number }
  >();

  for (const selection of input.selections) {
    const project = projectById.get(selection.projectId);
    if (!project) {
      console.warn(
        `[showcase] configured project ${selection.projectId} not found`,
      );
      continue;
    }

    const assetId = firstText(project.assetId);
    if (!assetId) {
      console.warn(
        `[showcase] project ${project.projectId} has no assetId; skipped`,
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
      async (segment): Promise<Omit<Episode, "index"> | null> => {
        const render = rendersBySegment.get(segment.id);
        if (!render) return null;

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
          title:
            firstText(segment.title, metadata?.title, render.title) ??
            "Untitled part",
          note: resolveNote(segment, metadata),
          sourceIn: segment.startTime,
          sourceOut: segment.endTime,
          durationSec: round3(segment.endTime - segment.startTime),
          videoUrl,
          posterUrl,
        };
      },
    );

    const episodes: Episode[] = built
      .filter((episode): episode is Omit<Episode, "index"> => !!episode)
      .map((episode, index) => ({ ...episode, index: index + 1 }));

    if (episodes.length === 0) {
      console.warn(
        `[showcase] project ${project.projectId} has no playable rendered segments`,
      );
      continue;
    }

    const assetRow = assetRowById.get(assetId);
    const filename =
      firstText(assetRow?.originalName, assetRow?.fileName, assetRow?.title) ??
      "source.mp4";
    const kind = mapAssetKind(project.metadata?.assetType, filename);
    const durationSec =
      typeof assetRow?.duration === "number" && Number.isFinite(assetRow.duration)
        ? round3(assetRow.duration)
        : 0;

    if (!assetMeta.has(assetId)) {
      assetMeta.set(assetId, {
        filename,
        title: humanizeSourceTitle(filename),
        kind,
        durationSec,
      });
    }

    const ids = seriesIdsByAsset.get(assetId) ?? [];
    ids.push(project.projectId);
    seriesIdsByAsset.set(assetId, ids);

    const coverKey = firstText(project.thumbnailKey);
    const coverUrl = coverKey ? await input.presignThumbnail(coverKey) : null;
    if (!posterByAsset.has(assetId) && coverUrl) posterByAsset.set(assetId, coverUrl);

    series.push({
      id: project.projectId,
      title: firstText(project.title) ?? "Untitled series",
      tagline: episodes.find((episode) => episode.note)?.note ?? "",
      sourceAssetId: assetId,
      tags: seriesTags(kind, episodes.length, project.segmentMetadata ?? []),
      episodes,
      hue: hueFromId(project.projectId),
      featured: selection.featured === true,
    });
  }

  const assets: SourceAsset[] = [...assetMeta.entries()].map(([id, meta]) => ({
    id,
    title: meta.title,
    filename: meta.filename,
    kind: meta.kind,
    durationSec: meta.durationSec,
    posterUrl: posterByAsset.get(id) ?? null,
    seriesIds: seriesIdsByAsset.get(id) ?? [],
  }));

  return { assets, series };
}
