/**
 * Export metadata generation via Pegasus 1.5 sync analyze with video clipping.
 * Docs: https://docs.twelvelabs.io/api-reference/analyze-videos/analyze
 */

import type { TwelveLabs, TwelvelabsApi } from "twelvelabs-js";
import {
  pegasusIndexedVideoDurationSec,
  type AssetInfo,
  type ChunkInfo,
} from "./twelvelabs";

const MIN_CLIP_SEC = 4.001;
const PEGASUS_TIMEOUT_MS = 600_000; // 10 min per clip (Lambda max is 15 min)

export type DescriptionLength = "short" | "two_sentences" | "paragraph";

export interface ExportMetadataOptions {
  includeTitles?: boolean;
  includeDescriptions?: boolean;
  descriptionLengths?: DescriptionLength[];
  descriptiveTags?: {
    contentAdvisory?: boolean;
    mood?: boolean;
    theme?: boolean;
    tone?: boolean;
  };
  includeThumbnails?: boolean;
}

function djb2Hex(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}

export interface ResolvedClip {
  video: TwelvelabsApi.VideoContext;
  startTime: number;
  endTime: number;
}

export interface ParsedSegmentMetadata {
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
}

/** Fingerprint of segment time bounds only (cache survives export-option toggles). */
export function computeSegmentMetadataFingerprint(
  startTime: number,
  endTime: number,
): string {
  return djb2Hex(JSON.stringify({ startTime, endTime }));
}

type CachedSegmentFields = {
  contentHash?: string;
  descriptions?: ParsedSegmentMetadata["descriptions"];
  tags?: ParsedSegmentMetadata["tags"];
  thumbnailKey?: string;
};

function requestedDescriptionLengths(
  options: ExportMetadataOptions,
): DescriptionLength[] {
  if (options.includeDescriptions === false) return [];
  return options.descriptionLengths ?? [
    "short",
    "two_sentences",
    "paragraph",
  ];
}

/** Options narrowed to metadata fields still missing from cache. */
export function computeMissingMetadataOptions(
  cached: CachedSegmentFields | undefined,
  options: ExportMetadataOptions & { includeThumbnails?: boolean },
  startTime?: number,
  endTime?: number,
): (ExportMetadataOptions & { includeThumbnails: boolean }) | null {
  if (startTime !== undefined && endTime !== undefined) {
    const boundsHash = computeSegmentMetadataFingerprint(startTime, endTime);
    if (!cached || cached.contentHash !== boundsHash) {
      return {
        ...options,
        includeThumbnails: options.includeThumbnails !== false,
      };
    }
  }

  const missing: ExportMetadataOptions & { includeThumbnails: boolean } = {
    includeThumbnails: false,
  };
  let hasMissing = false;

  const missingLengths = requestedDescriptionLengths(options).filter(
    (len) => !cached?.descriptions?.[len]?.trim(),
  );
  if (missingLengths.length > 0) {
    missing.includeDescriptions = true;
    missing.descriptionLengths = missingLengths;
    hasMissing = true;
  }

  const tagOpts = options.descriptiveTags;
  if (tagOpts) {
    const missingTags: NonNullable<ExportMetadataOptions["descriptiveTags"]> =
      {};
    let tagMissing = false;
    if (
      tagOpts.contentAdvisory &&
      cached?.tags?.content_advisory === undefined
    ) {
      missingTags.contentAdvisory = true;
      tagMissing = true;
    }
    if (tagOpts.mood && !cached?.tags?.mood?.trim()) {
      missingTags.mood = true;
      tagMissing = true;
    }
    if (tagOpts.theme && !cached?.tags?.theme?.trim()) {
      missingTags.theme = true;
      tagMissing = true;
    }
    if (tagOpts.tone && !cached?.tags?.tone?.trim()) {
      missingTags.tone = true;
      tagMissing = true;
    }
    if (tagMissing) {
      missing.descriptiveTags = missingTags;
      hasMissing = true;
    }
  }

  if (options.includeThumbnails !== false && !cached?.thumbnailKey) {
    missing.includeThumbnails = true;
    hasMissing = true;
  }

  return hasMissing ? missing : null;
}

export function isSegmentMetadataIncomplete(
  cached: CachedSegmentFields | undefined,
  startTime: number,
  endTime: number,
  options: ExportMetadataOptions & { includeThumbnails?: boolean },
): boolean {
  return computeMissingMetadataOptions(cached, options, startTime, endTime) !== null;
}

export function mergeSegmentMetadataEntry<
  T extends CachedSegmentFields & { segmentId: string; generatedAt?: string },
>(existing: T | undefined, update: T): T {
  return {
    ...existing,
    ...update,
    descriptions: {
      ...existing?.descriptions,
      ...update.descriptions,
    },
    tags: {
      ...existing?.tags,
      ...update.tags,
    },
    thumbnailKey: update.thumbnailKey ?? existing?.thumbnailKey,
    generatedAt: update.generatedAt ?? existing?.generatedAt,
  } as T;
}

/** Drop metadata rows for segments that no longer exist on the project. */
export function pruneSegmentMetadata<T extends { segmentId: string }>(
  metadata: T[],
  validSegmentIds: Set<string>,
): T[] {
  return metadata.filter((m) => validSegmentIds.has(m.segmentId));
}

function clampClipWindow(
  start: number,
  end: number,
  maxDuration: number,
): { startTime: number; endTime: number } {
  let clipStart = Math.max(0, start);
  let clipEnd = Math.min(maxDuration, end);

  if (clipEnd - clipStart < MIN_CLIP_SEC) {
    clipEnd = Math.min(maxDuration, clipStart + MIN_CLIP_SEC);
    if (clipEnd - clipStart < MIN_CLIP_SEC) {
      clipStart = Math.max(0, clipEnd - MIN_CLIP_SEC);
    }
  }

  return { startTime: clipStart, endTime: clipEnd };
}

function chunkOverlapSec(
  chunk: ChunkInfo,
  segStart: number,
  segEnd: number,
): number {
  const chunkStart = chunk.actualStartOffset ?? chunk.startOffset;
  const overlapStart = Math.max(segStart, chunkStart);
  const overlapEnd = Math.min(segEnd, chunk.endOffset);
  return Math.max(0, overlapEnd - overlapStart);
}

/**
 * Map original-video segment bounds to a single TwelveLabs asset clip.
 * v1: if the segment spans multiple physical chunks, use the chunk with the largest overlap.
 */
export function resolveClipForSegment(
  asset: AssetInfo,
  startTime: number,
  endTime: number,
): ResolvedClip {
  if (endTime <= startTime) {
    throw new Error(
      `Invalid segment window: ${startTime}s–${endTime}s`,
    );
  }

  if (!asset.isChunked) {
    if (!asset.twelveLabsVideoId) {
      throw new Error("No TwelveLabs asset_id for non-chunked video");
    }
    const maxDuration = asset.duration ?? endTime;
    const { startTime: clipStart, endTime: clipEnd } = clampClipWindow(
      startTime,
      endTime,
      maxDuration,
    );
    return {
      video: { type: "asset_id", assetId: asset.twelveLabsVideoId },
      startTime: clipStart,
      endTime: clipEnd,
    };
  }

  const chunks = (asset.chunks ?? []).filter((c) => c.videoId);
  if (chunks.length === 0) {
    throw new Error("Chunked asset has no indexed chunk videoIds");
  }

  const overlapping = chunks
    .map((chunk) => ({
      chunk,
      overlap: chunkOverlapSec(chunk, startTime, endTime),
    }))
    .filter((x) => x.overlap > 0);

  if (overlapping.length === 0) {
    throw new Error(
      `No chunk overlaps segment ${startTime}s–${endTime}s`,
    );
  }

  if (overlapping.length > 1) {
    console.warn(
      `[ExportMetadata] Segment spans ${overlapping.length} chunks; using dominant chunk`,
    );
  }

  overlapping.sort((a, b) => b.overlap - a.overlap);
  const chunk = overlapping[0].chunk;
  const chunkStart = chunk.actualStartOffset ?? chunk.startOffset;
  const maxDuration = pegasusIndexedVideoDurationSec(chunk);

  const localStart = startTime - chunkStart;
  const localEnd = endTime - chunkStart;
  const { startTime: clipStart, endTime: clipEnd } = clampClipWindow(
    localStart,
    localEnd,
    maxDuration,
  );

  return {
    video: { type: "asset_id", assetId: chunk.videoId! },
    startTime: clipStart,
    endTime: clipEnd,
  };
}

export function buildExportMetadataPrompt(
  options: ExportMetadataOptions,
): string {
  const fields: string[] = [];

  if (options.includeDescriptions !== false) {
    const lengths = options.descriptionLengths ?? [
      "short",
      "two_sentences",
      "paragraph",
    ];
    if (lengths.includes("short")) {
      fields.push(
        '"description_short": "One line, max 15 words, action-focused."',
      );
    }
    if (lengths.includes("two_sentences")) {
      fields.push(
        '"description_two_sentences": "Exactly two sentences summarizing this clip."',
      );
    }
    if (lengths.includes("paragraph")) {
      fields.push(
        '"description_paragraph": "3-5 sentences with plot context and emotional beat."',
      );
    }
  }

  const tags = options.descriptiveTags;
  if (tags?.contentAdvisory) {
    fields.push(
      '"content_advisory": "Brief content rating note if warranted (e.g. mild language, violence). Omit this field if nothing applies."',
    );
  }
  if (tags?.mood) {
    fields.push('"mood": "One or two words for emotional tone."');
  }
  if (tags?.theme) {
    fields.push('"theme": "Primary narrative theme in a few words."');
  }
  if (tags?.tone) {
    fields.push('"tone": "Overall tone (e.g. tense, hopeful, comedic)."');
  }

  if (fields.length === 0) {
    fields.push(
      '"mood": "One or two words for emotional tone."',
    );
  }

  return `Analyze this video clip and return JSON only (no markdown) with these fields:
{
  ${fields.join(",\n  ")}
}
Base all fields only on what happens in this clip.`;
}

function normalizeContentAdvisory(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (
    lower === "none" ||
    lower === "n/a" ||
    lower === "no content advisory" ||
    lower === "not applicable"
  ) {
    return undefined;
  }
  return trimmed;
}

function extractJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Pegasus response did not contain JSON object");
  }
  return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
}

export function parseExportMetadataResponse(
  raw: string,
  options: ExportMetadataOptions,
): ParsedSegmentMetadata {
  const data = extractJsonObject(raw);
  const result: ParsedSegmentMetadata = {};

  const lengths = options.descriptionLengths ?? [
    "short",
    "two_sentences",
    "paragraph",
  ];
  if (options.includeDescriptions !== false) {
    const descriptions: ParsedSegmentMetadata["descriptions"] = {};
    if (
      lengths.includes("short") &&
      typeof data.description_short === "string"
    ) {
      descriptions.short = data.description_short.trim();
    }
    if (
      lengths.includes("two_sentences") &&
      typeof data.description_two_sentences === "string"
    ) {
      descriptions.two_sentences = data.description_two_sentences.trim();
    }
    if (
      lengths.includes("paragraph") &&
      typeof data.description_paragraph === "string"
    ) {
      descriptions.paragraph = data.description_paragraph.trim();
    }
    if (Object.keys(descriptions).length > 0) {
      result.descriptions = descriptions;
    }
  }

  const tags = options.descriptiveTags;
  if (tags) {
    const parsedTags: NonNullable<ParsedSegmentMetadata["tags"]> = {};
    if (tags.contentAdvisory) {
      const advisory =
        typeof data.content_advisory === "string"
          ? normalizeContentAdvisory(data.content_advisory)
          : undefined;
      // Empty string marks "checked, nothing to flag" so toggles don't re-fetch.
      parsedTags.content_advisory = advisory ?? "";
    }
    if (tags.mood && typeof data.mood === "string") {
      parsedTags.mood = data.mood.trim();
    }
    if (tags.theme && typeof data.theme === "string") {
      parsedTags.theme = data.theme.trim();
    }
    if (tags.tone && typeof data.tone === "string") {
      parsedTags.tone = data.tone.trim();
    }
    if (Object.keys(parsedTags).length > 0) {
      result.tags = parsedTags;
    }
  }

  return result;
}

export async function generateSegmentMetadata(
  client: TwelveLabs,
  clip: ResolvedClip,
  options: ExportMetadataOptions,
): Promise<ParsedSegmentMetadata> {
  const prompt = buildExportMetadataPrompt(options);

  const res = await Promise.race([
    client.analyze({
      modelName: "pegasus1.5",
      video: clip.video,
      prompt,
      maxTokens: 2048,
      startTime: clip.startTime,
      endTime: clip.endTime,
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Pegasus analyze timed out")),
        PEGASUS_TIMEOUT_MS,
      ),
    ),
  ]);

  console.log(
    `[ExportMetadata] Pegasus usage (${clip.startTime.toFixed(1)}–${clip.endTime.toFixed(1)}s):`,
    JSON.stringify(res.usage),
  );

  if (!res.data) {
    throw new Error("Pegasus returned empty response");
  }

  return parseExportMetadataResponse(res.data, options);
}

/** True when a segment overlaps more than one indexed chunk (metadata uses dominant chunk only). */
export function segmentSpansMultipleChunks(
  asset: AssetInfo,
  startTime: number,
  endTime: number,
): boolean {
  if (!asset.isChunked) return false;
  const chunks = (asset.chunks ?? []).filter((c) => c.videoId);
  let overlapCount = 0;
  for (const chunk of chunks) {
    const chunkStart = chunk.actualStartOffset ?? chunk.startOffset;
    const overlapStart = Math.max(startTime, chunkStart);
    const overlapEnd = Math.min(endTime, chunk.endOffset);
    if (overlapEnd - overlapStart > 0) overlapCount++;
    if (overlapCount > 1) return true;
  }
  return false;
}

/** Timestamp for thumbnail: first second of segment. */
export function segmentThumbnailTimestamp(startTime: number): number {
  return startTime + 1;
}

/** Project/dashboard thumbnail: first second of second segment, else first segment. */
export function projectThumbnailTimestamp(
  segments: Array<{ startTime: number }>,
): number | null {
  if (segments.length === 0) return null;
  const sorted = [...segments].sort((a, b) => a.startTime - b.startTime);
  const target = sorted.length >= 2 ? sorted[1] : sorted[0];
  return target.startTime + 1;
}
