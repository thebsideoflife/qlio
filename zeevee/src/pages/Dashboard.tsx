import { useEffect, useState, useMemo, useCallback } from "react";
import { AssetCard } from "@/components/dashboard/AssetCard";
import {
  getRecentAssets,
  touchRecentAsset,
} from "@/components/dashboard/recentAssets";
import { AssetCardSkeleton } from "@/components/dashboard/AssetCardSkeleton";
import { CreateProjectModal } from "@/components/dashboard/CreateProjectModal";
import { useDispatch, useSelector } from "react-redux";
import {
  pollAssetStatuses,
  removeAsset,
  updateAsset,
} from "@/store/assetsSlice";
import type { Asset } from "@/store/assetsSlice";
import { deleteAsset } from "@/services/api";
import type { RootState, AppDispatch } from "@/store/store";
import { Plus } from "lucide-react";

const TERMINAL_STATUSES = new Set(["completed", "READY", "failed"]);

export default function Dashboard() {
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [spotlightAssetId, setSpotlightAssetId] = useState<string | null>(null);
  const [recencyVersion, setRecencyVersion] = useState(0);

  const dispatch = useDispatch<AppDispatch>();
  const {
    items: assets,
    loading,
    error,
    initialLoadDone,
  } = useSelector((state: RootState) => state.assets);

  const hasNonTerminalAssets = useCallback(
    () => assets.some((a) => !TERMINAL_STATUSES.has(a.status)),
    [assets],
  );

  // Initial load using slim endpoint (no presigned URLs needed for dashboard)
  useEffect(() => {
    dispatch(pollAssetStatuses());
  }, [dispatch]);

  // Slim polling while any asset is still processing
  // Uses lightweight status endpoint - only fetches full asset when it becomes READY
  useEffect(() => {
    if (!initialLoadDone || !hasNonTerminalAssets()) return;
    const interval = setInterval(() => {
      dispatch(pollAssetStatuses());
    }, 15_000);
    return () => clearInterval(interval);
  }, [dispatch, initialLoadDone, hasNonTerminalAssets]);

  // Helper: touch recency + trigger re-sort
  const touchAndReorder = (assetId: string) => {
    touchRecentAsset(assetId);
    setRecencyVersion((v) => v + 1);
  };

  // Sort assets by recency (most recently accessed first, then by createdAt)
  const sortedAssets = useMemo(() => {
    const recent = getRecentAssets();
    return [...assets].sort((a, b) => {
      const aTime = recent[a.id] || 0;
      const bTime = recent[b.id] || 0;
      if (aTime !== bTime) return bTime - aTime;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, recencyVersion]);

  // Default spotlight to first sorted asset
  const spotlightAsset =
    sortedAssets.find((a) => a.id === spotlightAssetId) ||
    sortedAssets[0] ||
    null;

  const recentRankByAssetId = useMemo(() => {
    const recent = getRecentAssets();
    const ranked = Object.entries(recent)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([id]) => id);
    return new Map(ranked.map((id, index) => [id, index]));
  }, [recencyVersion]);

  const handleCreateProject = (assetId: string) => {
    setSelectedAssetId(assetId);
    setCreateProjectOpen(true);
  };

  const handleDeleteAsset = async (assetId: string) => {
    try {
      await deleteAsset(assetId);
      dispatch(removeAsset(assetId));
      if (spotlightAssetId === assetId) {
        setSpotlightAssetId(null);
      }
    } catch (error) {
      console.error("Failed to delete asset:", error);
    }
  };

  const handleUpdateAsset = (assetId: string, updates: Partial<Asset>) => {
    dispatch(updateAsset({ id: assetId, updates }));
  };

  return (
    <div className="h-full p-8 overflow-y-auto">
      {loading && assets.length === 0 ? (
        <div className="flex gap-8">
          <div className="w-[480px] shrink-0">
            <AssetCardSkeleton />
          </div>
        </div>
      ) : error ? (
        <div className="text-center py-20 text-red-500 font-medium">
          Error: {error}
        </div>
      ) : assets.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full gap-4">
          <p className="text-muted-foreground text-lg">No assets yet</p>
          <button
            onClick={() =>
              window.dispatchEvent(new CustomEvent("open-upload-wizard"))
            }
            className="flex items-center gap-2 px-6 py-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold transition-all shadow-lg hover:shadow-xl"
          >
            <Plus className="h-5 w-5" />
            Upload Your First Video
          </button>
        </div>
      ) : (
        <div className="flex gap-8 items-start h-full">
          {/* Spotlight Card - Left side, larger */}
          <div className="w-[480px] shrink-0">
            {spotlightAsset && (
              <AssetCard
                key={spotlightAsset.id}
                asset={spotlightAsset}
                onCreateProject={handleCreateProject}
                onDelete={handleDeleteAsset}
                onUpdateAsset={handleUpdateAsset}
                variant="spotlight"
                isSelected
              />
            )}
          </div>

          {/* Assets - Responsive Grid on the right */}
          {sortedAssets.length > 0 && (
            <div className="flex-1 min-w-0">
              <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-4">
                Assets
              </h3>
              <div className="grid grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
                {sortedAssets.map((asset) => (
                  <div key={asset.id} className="transition-all rounded-xl">
                    <AssetCard
                      asset={asset}
                      onCreateProject={handleCreateProject}
                      onDelete={handleDeleteAsset}
                      variant="collapsed"
                      isRecent={recentRankByAssetId.has(asset.id)}
                      isSelected={asset.id === spotlightAsset?.id}
                      onSelect={() => {
                        touchAndReorder(asset.id);
                        setSpotlightAssetId(asset.id);
                      }}
                    />
                  </div>
                ))}
                {/* Add Asset Button */}
                <button
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent("open-upload-wizard"));
                  }}
                  className="aspect-[4/3] rounded-xl border-2 border-dashed border-border hover:border-blue-500 bg-card/50 hover:bg-card transition-all flex flex-col items-center justify-center gap-2 text-muted-foreground hover:text-foreground"
                >
                  <Plus className="h-8 w-8" />
                  <span className="text-sm font-semibold">Add Asset</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {selectedAssetId && (
        <CreateProjectModal
          open={createProjectOpen}
          onOpenChange={setCreateProjectOpen}
          assetId={selectedAssetId}
        />
      )}
    </div>
  );
}
