/** Mirrors backend export metadata fingerprint (bounds + options). */

import {
  filterIabTagsForFields,
  iabHasFormFactor,
  iabHasGenre,
  type IabFieldOptions,
} from "./iabContentTaxonomy";

export type DescriptionLength = "short" | "two_sentences" | "paragraph";

export interface ExportMetadataFingerprintOptions {
  includeTitles?: boolean;
  includeDescriptions?: boolean;
  descriptionLengths?: DescriptionLength[];
  descriptiveTags?: {
    contentAdvisory?: boolean;
    mood?: boolean;
    theme?: boolean;
    tone?: boolean;
  };
  includeIab?: boolean;
  iabFields?: IabFieldOptions;
  includeThumbnails?: boolean;
}

export interface IabTaxonomyTags {
  /** OpenRTB cattax — 7 = IAB Content Taxonomy 3.0 */
  cattax: 7;
  cat: string[];
  labels?: string[];
}

/** Returns undefined for empty / "none"-style placeholders from the model. */
export function normalizeContentAdvisory(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
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

function djb2Hex(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}

/**
 * Fingerprint of segment time bounds only (cache survives export-option toggles).
 *
 * IMPORTANT: This formula MUST match `backend/src/services/export-metadata.ts`.
 * If you change it here, update the backend too — mismatched hashes cause infinite
 * request loops as each side thinks cached data is stale.
 */
export function computeSegmentMetadataFingerprint(
  startTime: number,
  endTime: number,
): string {
  return djb2Hex(JSON.stringify({ startTime, endTime }));
}

export interface SegmentMetadataCache {
  segmentId: string;
  contentHash: string;
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
    iab?: IabTaxonomyTags;
  };
  thumbnailUrl?: string | null;
  thumbnailKey?: string;
  generatedAt?: string;
}

function requestedDescriptionLengths(
  options?: ExportMetadataFingerprintOptions,
): DescriptionLength[] {
  if (options?.includeDescriptions === false) return [];
  return options?.descriptionLengths ?? [
    "short",
    "two_sentences",
    "paragraph",
  ];
}

/** True when any currently-requested metadata field is missing from cache. */
export function isSegmentMetadataStale(
  cached: SegmentMetadataCache | undefined,
  startTime: number,
  endTime: number,
  options?: ExportMetadataFingerprintOptions,
): boolean {
  const boundsHash = computeSegmentMetadataFingerprint(startTime, endTime);
  if (!cached || cached.contentHash !== boundsHash) return true;

  for (const len of requestedDescriptionLengths(options)) {
    if (!cached.descriptions?.[len]?.trim()) return true;
  }

  const tagOpts = options?.descriptiveTags;
  if (tagOpts) {
    if (
      tagOpts.contentAdvisory &&
      cached.tags?.content_advisory === undefined
    ) {
      return true;
    }
    if (tagOpts.mood && !cached.tags?.mood?.trim()) return true;
    if (tagOpts.theme && !cached.tags?.theme?.trim()) return true;
    if (tagOpts.tone && !cached.tags?.tone?.trim()) return true;
  }

  if (options?.includeIab) {
    const wantForm = options.iabFields?.formFactor !== false;
    const wantGenres = options.iabFields?.genres !== false;
    const cat = cached.tags?.iab?.cat;
    if (!cat?.length) return true;
    if (wantForm && !iabHasFormFactor(cat)) return true;
    if (wantGenres && !iabHasGenre(cat)) return true;
  }

  if (
    options?.includeThumbnails !== false &&
    !cached.thumbnailKey &&
    !cached.thumbnailUrl
  ) {
    return true;
  }

  return false;
}

export { filterIabTagsForFields };
