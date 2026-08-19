export interface PersistedRenderArtifact {
  bucket: string;
  key: string;
  renderedAt: string;
  contentHash?: string;
  sourceBucket?: string;
  sourceKey?: string;
}

export interface SourceRenderArtifact {
  bucket: string;
  key: string;
}

/**
 * A matching input hash is not enough: a new Remotion bundle can produce
 * different pixels for the same inputs. Reuse only when this exact Remotion
 * output was already copied.
 */
export function isSameRenderArtifact(
  existing: PersistedRenderArtifact | undefined,
  source: SourceRenderArtifact,
  contentHash: string | undefined,
): boolean {
  return Boolean(
    existing?.bucket &&
      existing.key &&
      existing.contentHash &&
      existing.contentHash === contentHash &&
      existing.sourceBucket === source.bucket &&
      existing.sourceKey === source.key,
  );
}
