import {
  ensureAssetProjectThumbnails,
  pollProjectThumbnailsReady,
} from "@/services/api";

/** Dedupe concurrent ensure calls per asset (e.g. multiple cards mounting). */
const inFlight = new Map<string, Promise<void>>();

export async function ensureAssetThumbnailsOnce(assetId: string): Promise<void> {
  const existing = inFlight.get(assetId);
  if (existing) return existing;

  const promise = (async () => {
    const result = await ensureAssetProjectThumbnails(assetId);
    if (result.status === "generating") {
      await pollProjectThumbnailsReady(assetId);
    }
  })().finally(() => {
    inFlight.delete(assetId);
  });

  inFlight.set(assetId, promise);
  return promise;
}
