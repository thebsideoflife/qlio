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
  };
  thumbnailKey?: string;
  generatedAt: string;
}

/** Client-safe metadata row (no internal S3 keys). */
export type SegmentMetadataResponse = Omit<
  StoredSegmentMetadata,
  "thumbnailKey"
> & { thumbnailUrl?: string | null };
