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
    <div className="h-full p-8 overflow-y-auto">
      {loading && assets.length === 0 ? (
        <div className="flex gap-8">
          <div className="w-[480px] shrink-0">
            <AssetCardSkeleton />
          </div>
        </div>
      ) : error ? (
        <div className="text-center py-20 text-red-500 font-medium">Error: {error}</div>
      ) : assets.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full gap-4">
          <p className="text-muted-foreground text-lg">No assets yet</p>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("open-upload-wizard"))}
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
              />
            )}
          </div>

          {/* Other Assets - Responsive Grid on the right */}
          {otherAssets.length > 0 && (
            <div className="flex-1 min-w-0">
              <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-4">
                Other Assets
              </h3>
              <div className="grid grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
                {otherAssets.map((asset) => {
                  const originalIndex = assets.findIndex(
                    (a) => a.id === asset.id
                  );
                  return (
                    <div
                      key={asset.id}
                      className={cn(
                        "transition-all rounded-xl",
                        originalIndex === spotlightIndex &&
                          "ring-2 ring-blue-500"
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
