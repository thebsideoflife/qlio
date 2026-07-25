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
  generatedAt: string;
}

/** Client-safe metadata row (no internal S3 keys). */
export type SegmentMetadataResponse = Omit<
  StoredSegmentMetadata,
  "thumbnailKey"
> & { thumbnailUrl?: string | null };
