export interface IabTaxonomyTags {
  /** OpenRTB cattax — 7 = IAB Content Taxonomy 3.0 */
  cattax: 7;
  /** IAB category / vector IDs */
  cat: string[];
  /** Human-readable labels aligned with cat (optional sugar) */
  labels?: string[];
}

export interface StoredSegmentMetadata {
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
  thumbnailKey?: string;
  /** Search, targeting & AEO fields (see services/aeo-metadata.ts). */
  aeo?: StoredAeoMetadata;
  generatedAt: string;
}

export type AeoPlatform =
  | "youtube"
  | "youtube_shorts"
  | "tiktok"
  | "instagram_reels";

export interface AeoChapter {
  /** Seconds from the start of the scene clip. */
  startSec: number;
  title: string;
}

export interface AeoPlatformPackage {
  title?: string;
  /** Description (YouTube) or caption (TikTok, Reels). */
  description?: string;
  hashtags?: string[];
  /** YouTube keyword tags. */
  tags?: string[];
  /** YouTube only; omitted when the clip is too short for valid chapters. */
  chapters?: AeoChapter[];
}

/**
 * Generated per segment. Arrays and strings follow the same convention as
 * `content_advisory`: an empty value means "checked, nothing found", so a
 * toggle does not re-request it; `undefined` means "never generated".
 */
export interface StoredAeoMetadata {
  /** computeShowInfoHash() of the show info this was generated from. */
  showInfoHash: string;
  entities?: {
    characters?: string[];
    cast?: string[];
    locations?: string[];
  };
  search?: {
    title?: string;
    entityDescription?: string;
    fanAliases?: string[];
    questions?: string[];
  };
  /** Verbatim lines from the scene's dialogue (checked in code). */
  keyQuotes?: string[];
  /** US TV Parental Guidelines rating, or "" when the model gave none. */
  contentRating?: string;
  platforms?: Partial<Record<AeoPlatform, AeoPlatformPackage>>;
}

/** Client-safe metadata row (no internal S3 keys). */
export type SegmentMetadataResponse = Omit<
  StoredSegmentMetadata,
  "thumbnailKey"
> & { thumbnailUrl?: string | null };
