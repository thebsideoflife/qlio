import { useState, useEffect } from "react";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  MoreHorizontal,
  ChevronDown,
  Activity,
  PlusCircle,
  Trash2,
  Film,
  Loader2,
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
import { listProjects, deleteProject, createProject } from "@/services/api";

interface AssetCardProps {
  asset: Asset;
  onCreateProject: (assetId: string) => void;
  onDelete: (assetId: string) => void;
}

interface Project {
  projectId: string;
  title: string;
  createdAt: string;
  status: string;
}

const stageLabels: Record<string, string> = {
  upload: "Upload",
  transcription: "Transcription",
  clip_selection: "Segment Selection",
  reframing: "Reframing",
  captions: "Captions",
  delivery: "Delivery",
};

export function AssetCard({ asset, onDelete }: AssetCardProps) {
  const navigate = useNavigate();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [showProjects, setShowProjects] = useState(false);

  const currentStageLabel = asset.processing?.stage
    ? stageLabels[asset.processing.stage]
    : "";

  const isReady = asset.status === "completed" || asset.status === "READY";

  useEffect(() => {
    if (isReady) {
      loadProjects();
    }
  }, [asset.id, isReady]);

  const loadProjects = async () => {
    try {
      const projectList = await listProjects(asset.id);
      setProjects(projectList);
    } catch (error) {
      console.error("Failed to load projects:", error);
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    try {
      await deleteProject(projectId);
      setProjects(projects.filter((p) => p.projectId !== projectId));
      setProjectToDelete(null);
    } catch (error) {
      console.error("Failed to delete project:", error);
    }
  };

  const handleCardClick = (e: React.MouseEvent) => {
    // Don't navigate on card click anymore
    // User will click specific project or "Create Microdrama"
    e.stopPropagation();
    if (projects.length > 0) {
      setShowProjects(!showProjects);
    }
  };

  return (
    <>
      <Card
        className="overflow-hidden flex flex-col justify-between group cursor-pointer hover:border-primary/50 transition-all"
        onClick={handleCardClick}
      >
        <div className="relative aspect-video w-full bg-muted overflow-hidden">
          <img
            src={
              asset.thumbnailUrl ||
              asset.thumbnail ||
              "https://images.unsplash.com/photo-1626814026160-2237a95fc5a0?w=800&auto=format&fit=crop&q=60"
            }
            alt={asset.title}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
          <div className="absolute top-2 left-2 z-10">
            {asset.status === "uploading" ||
            ((asset.status === "processing" || asset.status === "indexing") &&
              asset.processing) ? (
              <Popover>
                <PopoverTrigger asChild onClick={(e) => e.stopPropagation()}>
                  <Badge
                    variant="secondary"
                    className="bg-blue-500 hover:bg-blue-600 text-white cursor-pointer transition-all flex items-center gap-1.5"
                  >
                    {asset.status === "uploading" ? (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Uploading{" "}
                        {asset.uploadProgress ? `${asset.uploadProgress}%` : ""}
                      </>
                    ) : (
                      <>
                        <Activity className="h-3 w-3 animate-pulse" />
                        {currentStageLabel || asset.status}
                      </>
                    )}
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
        </div>

        <CardContent className="p-5">
          <h3
            className="font-semibold leading-tight truncate mb-2 text-base group-hover:text-primary transition-colors"
            title={asset.title}
          >
            {asset.title}
          </h3>

          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm text-muted-foreground">
            {/* Description or simple metadata */}
            <div className="col-span-2 text-xs text-muted-foreground line-clamp-3">
              {asset.originalName || asset.title}
            </div>
          </div>
        </CardContent>

        <CardFooter className="p-4 pt-0 flex flex-col gap-3">
          {/* Projects Section */}
          {isReady && projects.length > 0 && (
            <div className="w-full space-y-2">
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span className="font-medium">
                  {projects.length} Microdrama{projects.length !== 1 ? "s" : ""}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowProjects(!showProjects);
                  }}
                  className="h-auto p-0 text-xs"
                >
                  {showProjects ? "Hide" : "Show"}
                </Button>
              </div>
              {showProjects && (
                <div className="space-y-1.5">
                  {projects.map((project) => (
                    <div
                      key={project.projectId}
                      className="flex items-center gap-1"
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 justify-start text-left"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/editor/${project.projectId}`);
                        }}
                      >
                        <Film className="h-3 w-3 mr-2 shrink-0" />
                        <span className="truncate">
                          {project.title || "Untitled"}
                        </span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-red-500 shrink-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          setProjectToDelete(project);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center gap-2 w-full">
            {isReady ? (
              <Button
                variant="default"
                size="sm"
                className="flex-1"
                onClick={async (e) => {
                  e.stopPropagation();
                  // Directly create project with defaults instead of opening modal
                  try {
                    const defaultSelections = {
                      type: "tv",
                      platform: "tiktok",
                      audience: { gender: "all", age: ["18-24"] },
                      driver: "viewership",
                      language: "english",
                      intent: "Viral Teaser",
                      style: "Engaging",
                    };
                    const result = await createProject(
                      asset.id,
                      defaultSelections
                    );
                    if (result && result.projectId) {
                      window.location.href = `/editor/${result.projectId}`;
                    }
                  } catch (err) {
                    console.error("Failed to quick-create project", err);
                  }
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
          </div>
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

      <Dialog
        open={!!projectToDelete}
        onOpenChange={(open) => !open && setProjectToDelete(null)}
      >
        <DialogContent onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Delete Project?</DialogTitle>
            <DialogDescription>
              This will permanently delete the microdrama "
              {projectToDelete?.title || "Untitled"}". This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={(e) => {
                e.stopPropagation();
                setProjectToDelete(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={(e) => {
                e.stopPropagation();
                if (projectToDelete) {
                  handleDeleteProject(projectToDelete.projectId);
                }
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
