import { useEffect, useState } from "react";
import { AssetCard } from "@/components/dashboard/AssetCard";
import { AssetCardSkeleton } from "@/components/dashboard/AssetCardSkeleton";
import { CreateProjectModal } from "@/components/dashboard/CreateProjectModal";
import { useDispatch, useSelector } from "react-redux";
import { fetchAssets, removeAsset, updateAsset } from "@/store/assetsSlice";
import type { Asset } from "@/store/assetsSlice";
import { deleteAsset } from "@/services/api";
import type { RootState, AppDispatch } from "@/store/store";
import { cn } from "@/lib/utils";
import { Plus } from "lucide-react";

export default function Dashboard() {
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [spotlightIndex, setSpotlightIndex] = useState(0);

  const dispatch = useDispatch<AppDispatch>();
  const {
    items: assets,
    loading,
    error,
  } = useSelector((state: RootState) => state.assets);

  useEffect(() => {
    dispatch(fetchAssets());
  }, [dispatch]);

  // Set initial spotlight to first asset
  useEffect(() => {
    if (assets.length > 0 && spotlightIndex >= assets.length) {
      setSpotlightIndex(0);
    }
  }, [assets.length, spotlightIndex]);

  const handleCreateProject = (assetId: string) => {
    setSelectedAssetId(assetId);
    setCreateProjectOpen(true);
  };

  const handleDeleteAsset = async (assetId: string) => {
    try {
      await deleteAsset(assetId);
      dispatch(removeAsset(assetId));
      // Adjust spotlight index if needed
      if (spotlightIndex >= assets.length - 1 && spotlightIndex > 0) {
        setSpotlightIndex(spotlightIndex - 1);
      }
    } catch (error) {
      console.error("Failed to delete asset:", error);
    }
  };

  const handleUpdateAsset = (assetId: string, updates: Partial<Asset>) => {
    dispatch(updateAsset({ id: assetId, updates }));
  };

  const spotlightAsset = assets[spotlightIndex];
  const otherAssets = assets.filter((_, i) => i !== spotlightIndex);

  return (
    <div className="h-full p-6 overflow-y-auto">
      {loading && assets.length === 0 ? (
        <div className="flex gap-8">
          <div className="w-[420px] shrink-0">
            <AssetCardSkeleton />
          </div>
        </div>
      ) : error ? (
        <div className="text-center py-20 text-red-500">Error: {error}</div>
      ) : assets.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          No assets yet. Upload a video to get started.
        </div>
      ) : (
        <div className="flex gap-8 items-start">
          {/* Spotlight Card - Left side */}
          <div className="w-[420px] shrink-0">
            {spotlightAsset && (
              <AssetCard
                key={spotlightAsset.id}
                asset={spotlightAsset}
                onCreateProject={handleCreateProject}
                onDelete={handleDeleteAsset}
                onUpdateAsset={handleUpdateAsset}
                variant="spotlight"
              />
            )}
          </div>

          {/* Other Assets - Responsive Grid on the right */}
          {otherAssets.length > 0 && (
            <div className="flex-1 min-w-0">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
                Other Assets
              </h3>
              <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
                {otherAssets.map((asset) => {
                  const originalIndex = assets.findIndex(
                    (a) => a.id === asset.id
                  );
                  return (
                    <div
                      key={asset.id}
                      className={cn(
                        "transition-all rounded-lg",
                        originalIndex === spotlightIndex &&
                          "ring-2 ring-purple-500"
                      )}
                    >
                      <AssetCard
                        asset={asset}
                        onCreateProject={handleCreateProject}
                        onDelete={handleDeleteAsset}
                        variant="collapsed"
                        onSelect={() => setSpotlightIndex(originalIndex)}
                      />
                    </div>
                  );
                })}
                {/* Add Asset Button */}
                <button
                  onClick={() => {
                    // Dispatch custom event to trigger upload modal in MainLayout
                    window.dispatchEvent(new CustomEvent("open-upload-wizard"));
                  }}
                  className="aspect-[4/3] rounded-lg border-2 border-dashed border-slate-700 hover:border-purple-500/50 bg-slate-900/30 hover:bg-slate-800/50 transition-all flex flex-col items-center justify-center gap-2 text-slate-500 hover:text-slate-300"
                >
                  <Plus className="h-8 w-8" />
                  <span className="text-sm font-medium">Add Asset</span>
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
