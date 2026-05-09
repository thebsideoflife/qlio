const RECENT_ASSETS_KEY = "qlio-recent-assets";

export function getRecentAssets(): Record<string, number> {
  try {
    const stored = localStorage.getItem(RECENT_ASSETS_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

export function touchRecentAsset(assetId: string) {
  const recent = getRecentAssets();
  recent[assetId] = Date.now();
  localStorage.setItem(RECENT_ASSETS_KEY, JSON.stringify(recent));
}
