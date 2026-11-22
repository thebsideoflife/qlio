/** Mirrors backend export metadata fingerprint (bounds + options). */

import {
  filterIabTagsForFields,
  iabHasFormFactor,
  iabHasGenre,
  iabHasTopic,
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
  aeo?: AeoOptions;
}

export type AeoPlatform =
  | "youtube"
  | "youtube_shorts"
  | "tiktok"
  | "instagram_reels";

export const AEO_PLATFORMS: readonly AeoPlatform[] = [
  "youtube",
  "youtube_shorts",
  "tiktok",
  "instagram_reels",
];

/** Mirrors backend `AeoOptions` (services/export-metadata.ts). */
export interface AeoOptions {
  characters?: boolean;
  cast?: boolean;
  locations?: boolean;
  searchTitle?: boolean;
  entityDescription?: boolean;
  fanAliases?: boolean;
  questions?: boolean;
  keyQuotes?: boolean;
  contentRating?: boolean;
  platforms?: AeoPlatform[];
  /** computeShowInfoHash() of the asset's show info. */
  showInfoHash?: string;
}

export interface AeoChapter {
  startSec: number;
  title: string;
}

export interface AeoPlatformPackage {
  title?: string;
  description?: string;
  hashtags?: string[];
  tags?: string[];
  chapters?: AeoChapter[];
}

/** Mirrors backend `StoredAeoMetadata` (types/segment-metadata.ts). */
export interface AeoMetadata {
  showInfoHash: string;
  entities?: { characters?: string[]; cast?: string[]; locations?: string[] };
  search?: {
    title?: string;
    entityDescription?: string;
    fanAliases?: string[];
    questions?: string[];
  };
  keyQuotes?: string[];
  contentRating?: string;
  platforms?: Partial<Record<AeoPlatform, AeoPlatformPackage>>;
}

/**
 * True when a requested AEO field is missing. MUST match backend
 * `computeMissingAeoOptions`: empty strings/arrays count as generated.
 */
export function isAeoStale(
  cached: AeoMetadata | undefined,
  options: AeoOptions | undefined,
): boolean {
  if (!options) return false;
  const platforms = (options.platforms ?? []).filter((p) =>
    AEO_PLATFORMS.includes(p),
  );
  const flags: Array<[boolean | undefined, () => boolean]> = [
    [options.characters, () => cached?.entities?.characters === undefined],
    [options.cast, () => cached?.entities?.cast === undefined],
    [options.locations, () => cached?.entities?.locations === undefined],
    [options.searchTitle, () => cached?.search?.title === undefined],
    [options.entityDescription, () => cached?.search?.entityDescription === undefined],
    [options.fanAliases, () => cached?.search?.fanAliases === undefined],
    [options.questions, () => cached?.search?.questions === undefined],
    [options.keyQuotes, () => cached?.keyQuotes === undefined],
    [options.contentRating, () => cached?.contentRating === undefined],
  ];
  const anyWanted = platforms.length > 0 || flags.some(([want]) => want);
  if (!anyWanted) return false;
  if (!cached || cached.showInfoHash !== (options.showInfoHash ?? "")) return true;
  if (flags.some(([want, missing]) => want && missing())) return true;
  return platforms.some((p) => !cached.platforms?.[p]);
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
  aeo?: AeoMetadata;
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
    // Opt-in, matching the backend: unset means "don't need topics".
    const wantTopics = options.iabFields?.topics === true;
    const cat = cached.tags?.iab?.cat;
    if (!cat?.length) return true;
    if (wantForm && !iabHasFormFactor(cat)) return true;
    if (wantGenres && !iabHasGenre(cat)) return true;
    if (wantTopics && !iabHasTopic(cat)) return true;
  }

  if (isAeoStale(cached.aeo, options?.aeo)) return true;

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
