import { useState } from "react";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  MoreHorizontal,
  ChevronDown,
  Activity,
  PlusCircle,
  Trash2,
} from "lucide-react";
import type { Asset } from "@/store/assetsSlice";
import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface AssetCardProps {
  asset: Asset;
  onCreateProject: (assetId: string) => void;
  onDelete: (assetId: string) => void;
}

const stageLabels: Record<string, string> = {
  upload: "Upload",
  transcription: "Transcription",
  clip_selection: "Segment Selection",
  reframing: "Reframing",
  captions: "Captions",
  delivery: "Delivery",
};

export function AssetCard({
  asset,
  onCreateProject,
  onDelete,
}: AssetCardProps) {
  const navigate = useNavigate();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const handleCardClick = () => {
    // If we want to view the asset details or project, we might need a different view
    // For now, let's just go to editor if ready, or maybe do nothing if not?
    // User wants "Create Microdrama" separate.
    if (asset.status === "completed" || asset.status === "READY") {
      navigate(`/editor/${asset.id}`);
    }
  };

  const currentStageLabel = asset.processing?.stage
    ? stageLabels[asset.processing.stage]
    : "";

  const isReady = asset.status === "completed" || asset.status === "READY";

  return (
    <>
      <Card
        className="overflow-hidden flex flex-col justify-between group cursor-pointer hover:border-primary/50 transition-all"
        onClick={handleCardClick}
      >
        <div className="relative aspect-video w-full bg-muted overflow-hidden">
          <img
            src={
              asset.thumbnail ||
              "https://images.unsplash.com/photo-1626814026160-2237a95fc5a0?w=800&auto=format&fit=crop&q=60"
            }
            alt={asset.title}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
          <div className="absolute top-2 left-2 z-10">
            {(asset.status === "processing" ||
              asset.status === "uploading" ||
              asset.status === "indexing") &&
            asset.processing ? (
              <Popover>
                <PopoverTrigger asChild onClick={(e) => e.stopPropagation()}>
                  <Badge
                    variant="secondary"
                    className="bg-blue-500 hover:bg-blue-600 text-white cursor-pointer transition-all flex items-center gap-1.5"
                  >
                    <Activity className="h-3 w-3 animate-pulse" />
                    {currentStageLabel || asset.status}
                    <ChevronDown className="h-3 w-3" />
                  </Badge>
                </PopoverTrigger>
                <PopoverContent
                  className="w-80 p-4"
                  align="start"
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* ... existing popover content ... */}
                  <div className="text-sm">Processing...</div>
                </PopoverContent>
              </Popover>
            ) : (
              <Badge
                variant="default"
                className={cn(
                  "hover:bg-green-600",
                  isReady ? "bg-green-500" : "bg-yellow-500"
                )}
              >
                {asset.status}
              </Badge>
            )}
          </div>
          <div className="absolute bottom-2 right-2 bg-black/60 text-white text-xs px-1.5 py-0.5 rounded">
            {/* Duration placeholder */}
            --:--
          </div>
        </div>

        <CardContent className="p-5">
          <h3
            className="font-semibold leading-tight truncate mb-2 text-base group-hover:text-primary transition-colors"
            title={asset.title}
          >
            {asset.title}
          </h3>

          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm text-muted-foreground">
            <div>Format:</div>
            <div className="text-right text-foreground">
              {asset.format || "N/A"}
            </div>

            <div>Size:</div>
            <div className="text-right text-foreground">
              {asset.size || "N/A"}
            </div>

            <div>Segments:</div>
            <div className="text-right text-foreground">
              {asset.segmentCount}
            </div>
          </div>
        </CardContent>

        <CardFooter className="p-4 pt-0 flex justify-between items-center gap-2">
          {/* Action Buttons */}
          {isReady ? (
            <Button
              variant="default"
              size="sm"
              className="w-full"
              onClick={(e) => {
                e.stopPropagation();
                onCreateProject(asset.id);
              }}
            >
              <PlusCircle className="h-4 w-4 mr-2" />
              Create Microdrama
            </Button>
          ) : (
            <div className="text-xs text-muted-foreground w-full text-center italic">
              Processing...
            </div>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                className="text-red-600 focus:text-red-600"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowDeleteConfirm(true);
                }}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardFooter>
      </Card>

      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Delete Asset?</DialogTitle>
            <DialogDescription>
              This will permanently delete the asset "{asset.title}" and all
              associated data from the system, including 12Labs. This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={(e) => {
                e.stopPropagation();
                setShowDeleteConfirm(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={(e) => {
                e.stopPropagation();
                setShowDeleteConfirm(false);
                onDelete(asset.id);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
