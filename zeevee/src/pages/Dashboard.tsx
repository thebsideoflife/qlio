import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search, RefreshCcw } from "lucide-react";
import { AssetCard } from "@/components/dashboard/AssetCard";
import { UploadWizard } from "@/components/upload/UploadWizard";
import { CreateProjectModal } from "@/components/dashboard/CreateProjectModal";
import { useDispatch, useSelector } from "react-redux";
import { fetchAssets, removeAsset } from "@/store/assetsSlice";
import { deleteAsset } from "@/services/api";
import type { RootState, AppDispatch } from "@/store/store";

export default function Dashboard() {
  const [uploadOpen, setUploadOpen] = useState(false);
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

  const processingCount = assets.filter(
    (a) =>
      a.status === "processing" ||
      a.status === "uploading" ||
      a.status === "indexing"
  ).length;

  const completedCount = assets.filter(
    (a) => a.status === "completed" || a.status === "READY"
  ).length;

  return (
    <div className="space-y-6 p-6 max-w-[1600px] mx-auto">
      {/* Header & Controls Compact Row */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-baseline gap-4">
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <div className="flex items-center gap-4 text-sm text-muted-foreground border-l pl-4">
            <div>
              <span className="font-medium text-foreground">
                {assets.length}
              </span>{" "}
              Total
            </div>
            <div>
              <span className="font-medium text-foreground">
                {processingCount}
              </span>{" "}
              Processing
            </div>
            <div>
              <span className="font-medium text-foreground">
                {completedCount}
              </span>{" "}
              Completed
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search assets..."
              className="pl-9 h-9 bg-background"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => dispatch(fetchAssets())}
          >
            <RefreshCcw className="h-4 w-4" />
          </Button>
          <Button size="sm" onClick={() => setUploadOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Upload
          </Button>
        </div>
      </div>

      <div className="border-b" />

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

      {/* Modals */}
      <UploadWizard open={uploadOpen} onOpenChange={setUploadOpen} />

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
