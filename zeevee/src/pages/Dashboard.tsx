import { useEffect, useState } from "react";
import { AssetCard } from "@/components/dashboard/AssetCard";
import { CreateProjectModal } from "@/components/dashboard/CreateProjectModal";
import { useDispatch, useSelector } from "react-redux";
import { fetchAssets, removeAsset } from "@/store/assetsSlice";
import { deleteAsset } from "@/services/api";
import type { RootState, AppDispatch } from "@/store/store";

export default function Dashboard() {
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);

  const dispatch = useDispatch<AppDispatch>();
  const {
    items: assets,
    loading,
    error,
  } = useSelector((state: RootState) => state.assets);

  useEffect(() => {
    dispatch(fetchAssets());
  }, [dispatch]);

  const handleCreateProject = (assetId: string) => {
    setSelectedAssetId(assetId);
    setCreateProjectOpen(true);
  };

  const handleDeleteAsset = async (assetId: string) => {
    try {
      await deleteAsset(assetId);
      dispatch(removeAsset(assetId));
    } catch (error) {
      console.error("Failed to delete asset:", error);
      // Optionally show a toast error here
    }
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Assets Grid */}
      {loading && assets.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          Loading assets...
        </div>
      ) : error ? (
        <div className="text-center py-20 text-red-500">Error: {error}</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {assets.map((asset) => (
            <AssetCard
              key={asset.id}
              asset={asset}
              onCreateProject={handleCreateProject}
              onDelete={handleDeleteAsset}
            />
          ))}
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
