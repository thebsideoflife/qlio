export interface ExportPackageFingerprintInput {
  segmentIds?: string[];
  includeThumbnails?: boolean;
  includePoster?: boolean;
  projectTitle?: string;
  metadataDocument?: unknown;
}

export interface ExportPackageRenderRevision {
  segmentId: string;
  bucket?: string;
  key?: string;
  renderedAt?: string;
  contentHash?: string;
  sourceBucket?: string;
  sourceKey?: string;
}

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(16);
}

/**
 * The editor stamps `exportedAt` and re-signs thumbnail URLs on every load.
 * Neither changes the delivered files, so leave them out of the identity —
 * otherwise an existing package never matches and every visit rebuilds it.
 */
function stableMetadata(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => stableMetadata(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "exportedAt") continue;
      out[k] = stableMetadata(v, k);
    }
    return out;
  }
  if (typeof value === "string" && key && /url$/i.test(key)) {
    return value.split("?")[0];
  }
  return value;
}

/**
 * Identifies the exact delivery package, including the rendered MP4 revisions.
 * A language change or renderer redeploy can replace an MP4 at the same stable
 * S3 key, so the old selection-only fingerprint was not sufficient.
 */
export function computeExportPackageFingerprint(
  input: ExportPackageFingerprintInput,
  renders: ExportPackageRenderRevision[],
): string {
  const ids = [...(input.segmentIds || [])].sort();
  const requested = new Set(ids);
  const revisions = renders
    .filter((render) => ids.length === 0 || requested.has(render.segmentId))
    .map((render) => ({
      segmentId: render.segmentId,
      bucket: render.bucket,
      key: render.key,
      renderedAt: render.renderedAt,
      contentHash: render.contentHash,
      sourceBucket: render.sourceBucket,
      sourceKey: render.sourceKey,
    }))
    .sort((left, right) => left.segmentId.localeCompare(right.segmentId));

  const payload = JSON.stringify({
    version: 4,
    ids,
    thumbs: input.includeThumbnails !== false,
    poster: input.includePoster !== false,
    projectTitle: input.projectTitle || "",
    metadataHash: input.metadataDocument
      ? hashString(JSON.stringify(stableMetadata(input.metadataDocument)))
      : null,
    revisions,
  });
  return `v4-${hashString(payload)}`;
}
