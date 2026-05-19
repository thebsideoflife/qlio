import { useState, useEffect, useRef, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  MoreHorizontal,
  Activity,
  PlusCircle,
  Trash2,
  Loader2,
  Heart,
  Share2,
  Play,
} from "lucide-react";
import type { Asset } from "@/store/assetsSlice";
import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
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
import {
  listProjects,
  deleteProject,
  createProject,
  updateProject,
  updateAsset,
} from "@/services/api";
import { EditableTitle } from "@/components/ui/editable-title";
import { touchRecentAsset } from "./recentAssets";

interface AssetCardProps {
  asset: Asset;
  onCreateProject: (assetId: string) => void;
  onDelete: (assetId: string) => void;
  onUpdateAsset?: (assetId: string, updates: Partial<Asset>) => void;
  variant?: "spotlight" | "collapsed";
  onSelect?: () => void;
}

interface Project {
  projectId: string;
  title: string;
  createdAt: string;
  segmentCount: number;
  firstSegmentStartTime: number | null;
}

const stageLabels: Record<string, string> = {
  upload: "Upload",
  transcription: "Transcription",
  clip_selection: "Segment Selection",
  reframing: "Reframing",
  captions: "Captions",
  delivery: "Delivery",
};

// Favorites localStorage helpers
const FAVORITES_KEY = "qlio-favorites";
const FAVORITES_KEY_LEGACY = "zeevee-favorites";

function getFavorites(): Record<string, boolean> {
  try {
    let stored = localStorage.getItem(FAVORITES_KEY);
    // One-time migration from old key after rename zeevee → qlio
    if (!stored) {
      const legacy = localStorage.getItem(FAVORITES_KEY_LEGACY);
      if (legacy) {
        localStorage.setItem(FAVORITES_KEY, legacy);
        stored = legacy;
      }
    }
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

function setFavorite(projectId: string, isFavorite: boolean) {
  const favorites = getFavorites();
  if (isFavorite) {
    favorites[projectId] = true;
  } else {
    delete favorites[projectId];
  }
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
}

// Cache for video thumbnails to avoid re-extracting
const thumbnailCache = new Map<string, string>();

// Component to extract and display a video frame at a specific time
function VideoThumbnail({
  videoUrl,
  time,
  className,
  fallbackUrl,
}: {
  videoUrl: string;
  time: number;
  className?: string;
  fallbackUrl: string;
}) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const cacheKey = `${videoUrl}:${time}`;

  useEffect(() => {
    // Check cache first — defer setState to avoid synchronous updates in effect
    const cached = thumbnailCache.get(cacheKey);
    if (cached) {
      queueMicrotask(() => {
        setThumbnailUrl(cached);
        setLoading(false);
      });
      return;
    }

    const video = videoRef.current;
    if (!video) return;

    let mounted = true;

    const handleSeeked = () => {
      if (!mounted) return;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
          thumbnailCache.set(cacheKey, dataUrl);
          setThumbnailUrl(dataUrl);
        }
      } catch (e) {
        console.error("Failed to capture video frame:", e);
        setError(true);
      }
      setLoading(false);
    };

    const handleError = () => {
      if (!mounted) return;
      setError(true);
      setLoading(false);
    };

    const handleLoadedMetadata = () => {
      if (!mounted) return;
      video.currentTime = time;
    };

    video.addEventListener("seeked", handleSeeked);
    video.addEventListener("error", handleError);
    video.addEventListener("loadedmetadata", handleLoadedMetadata);

    // If already loaded, seek immediately
    if (video.readyState >= 1) {
      video.currentTime = time;
    }

    return () => {
      mounted = false;
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("error", handleError);
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
    };
  }, [videoUrl, time, cacheKey]);

  if (error || (!loading && !thumbnailUrl)) {
    return (
      <img src={fallbackUrl} alt="" className={cn("object-cover", className)} />
    );
  }

  return (
    <>
      {/* Hidden video element for frame extraction */}
      <video
        ref={videoRef}
        src={videoUrl}
        crossOrigin="anonymous"
        preload="metadata"
        muted
        playsInline
        className="hidden"
      />
      {loading ? (
        <div
          className={cn(
            "bg-slate-800 animate-pulse flex items-center justify-center",
            className,
          )}
        >
          <Loader2 className="h-3 w-3 animate-spin text-slate-600" />
        </div>
      ) : (
        <img
          src={thumbnailUrl || fallbackUrl}
          alt=""
          className={cn("object-cover", className)}
        />
      )}
    </>
  );
}

export function AssetCard({
  asset,
  onDelete,
  onUpdateAsset,
  variant = "spotlight",
  onSelect,
}: AssetCardProps) {
  const navigate = useNavigate();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [favorites, setFavorites] =
    useState<Record<string, boolean>>(getFavorites);
  const [showAllProjects, setShowAllProjects] = useState(false);

  // Get display title - use originalName as fallback if title is empty/untitled
  const getDisplayTitle = useCallback(
    (title: string) => {
      if (!title || title.toLowerCase() === "untitled") {
        return asset.originalName || title || "Untitled";
      }
      return title;
    },
    [asset.originalName],
  );

  const [localAssetTitle, setLocalAssetTitle] = useState(
    getDisplayTitle(asset.title),
  );

  const currentStageLabel = asset.processing?.stage
    ? stageLabels[asset.processing.stage]
    : "";

  const isReady = asset.status === "completed" || asset.status === "READY";

  // Sync local title with prop
  useEffect(() => {
    setLocalAssetTitle(getDisplayTitle(asset.title));
  }, [asset.title, getDisplayTitle]);

  const loadProjects = useCallback(async () => {
    setLoadingProjects(true);
    try {
      const projectList = await listProjects(asset.id);
      setProjects(projectList);
    } catch (error) {
      console.error("Failed to load projects:", error);
    } finally {
      setLoadingProjects(false);
    }
  }, [asset.id]);

  useEffect(() => {
    if (isReady && variant === "spotlight") {
      loadProjects();
    }
  }, [isReady, variant, loadProjects]);

  const handleUpdateAssetTitle = async (newTitle: string) => {
    const oldTitle = localAssetTitle;
    setLocalAssetTitle(newTitle); // Optimistic update

    try {
      await updateAsset(asset.id, { title: newTitle });
      // Update parent state if callback provided
      if (onUpdateAsset) {
        onUpdateAsset(asset.id, { title: newTitle });
      }
    } catch (e) {
      console.error("Failed to update asset title:", e);
      setLocalAssetTitle(oldTitle); // Revert on failure
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

  const toggleFavorite = (projectId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const newValue = !favorites[projectId];
    setFavorite(projectId, newValue);
    setFavorites({ ...favorites, [projectId]: newValue });
  };

  const handleShare = (projectId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const url = `${window.location.origin}/editor/${projectId}`;
    navigator.clipboard.writeText(url);
  };

  const handleCreateProject = async (e: React.MouseEvent) => {
    e.stopPropagation();
    touchRecentAsset(asset.id);
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
      const result = await createProject(asset.id, defaultSelections);
      if (result && result.projectId) {
        window.location.href = `/editor/${result.projectId}`;
      }
    } catch (err) {
      console.error("Failed to quick-create project", err);
    }
  };

  const handleUpdateProjectTitle = async (
    projectId: string,
    newTitle: string,
  ) => {
    // Optimistic update
    setProjects(
      projects.map((p) =>
        p.projectId === projectId ? { ...p, title: newTitle } : p,
      ),
    );
    try {
      await updateProject(projectId, { title: newTitle });
    } catch (e) {
      console.error("Failed to update title:", e);
      // Revert on failure
      const originalProject = projects.find((p) => p.projectId === projectId);
      if (originalProject) {
        setProjects(
          projects.map((p) =>
            p.projectId === projectId
              ? { ...p, title: originalProject.title }
              : p,
          ),
        );
      }
    }
  };

  // Fallback thumbnail for when video isn't available
  const FALLBACK_THUMBNAIL =
    "https://images.unsplash.com/photo-1626814026160-2237a95fc5a0?w=200&auto=format&fit=crop&q=60";

  // Get first segment start time for a project
  const getFirstSegmentTime = (project: Project): number | null => {
    return project.firstSegmentStartTime;
  };

  // Collapsed variant - small thumbnail card for 2x2 grid
  if (variant === "collapsed") {
    return (
      <div
        className={cn(
          "rounded-xl overflow-hidden bg-card border-2 border-border cursor-pointer transition-all duration-200 hover:border-blue-500/50 hover:shadow-lg",
          "group",
        )}
        onClick={onSelect}
      >
        <div className="relative aspect-[4/3] w-full overflow-hidden">
          {asset.videoUrl ? (
            <VideoThumbnail
              videoUrl={asset.videoUrl}
              time={5}
              className="h-full w-full transition-transform duration-500 group-hover:scale-105"
              fallbackUrl={FALLBACK_THUMBNAIL}
            />
          ) : (
            <img
              src={FALLBACK_THUMBNAIL}
              alt={asset.title}
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />
          {/* Status badge */}
          {(asset.status === "uploading" ||
            ((asset.status === "processing" || asset.status === "indexing") &&
              asset.processing)) && (
            <div className="absolute top-2 left-2">
              <Badge className="bg-blue-600 text-white border-0 text-[10px] px-2 py-0.5 font-semibold">
                <Loader2 className="h-2.5 w-2.5 animate-spin mr-1" />
                {currentStageLabel || asset.status}
              </Badge>
            </div>
          )}
          {/* Title overlay at bottom */}
          <div className="absolute bottom-0 left-0 right-0 p-3">
            <h3 className="text-sm font-semibold text-white truncate drop-shadow-lg">
              {localAssetTitle}
            </h3>
            <p className="text-xs text-white/70 truncate font-medium">
              {asset.format || "Video"}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Spotlight variant - full featured card
  return (
    <>
      <div className="rounded-xl overflow-hidden bg-card border-2 border-border shadow-2xl">
        {/* Hero Section - 16:9 landscape */}
        <div className="relative aspect-video w-full overflow-hidden group">
          {asset.videoUrl ? (
            <VideoThumbnail
              videoUrl={asset.videoUrl}
              time={5}
              className="h-full w-full transition-transform duration-500 group-hover:scale-105"
              fallbackUrl={FALLBACK_THUMBNAIL}
            />
          ) : (
            <img
              src={FALLBACK_THUMBNAIL}
              alt={asset.title}
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
          )}
          {/* Gradient overlay */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-transparent" />

          {/* Status badge */}
          <div className="absolute top-3 left-3 z-10">
            {asset.status === "uploading" ||
            ((asset.status === "processing" || asset.status === "indexing") &&
              asset.processing) ? (
              <Badge className="bg-blue-600 text-white border-0 backdrop-blur-md text-xs px-2.5 py-1 font-semibold">
                {asset.status === "uploading" ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                    {asset.uploadProgress
                      ? `${asset.uploadProgress}%`
                      : "Uploading"}
                  </>
                ) : (
                  <>
                    <Activity className="h-3 w-3 animate-pulse mr-1.5" />
                    {currentStageLabel || asset.status}
                  </>
                )}
              </Badge>
            ) : null}
          </div>

          {/* More menu */}
          <div className="absolute top-3 right-3 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 bg-black/50 hover:bg-black/70 text-white backdrop-blur-md rounded-lg"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="bg-card border-border"
              >
                <DropdownMenuItem
                  className="text-red-500 focus:text-red-400 focus:bg-red-500/10"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowDeleteConfirm(true);
                  }}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete Asset
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Title overlay */}
          <div className="absolute bottom-0 left-0 right-0 p-4">
            <EditableTitle
              title={localAssetTitle}
              onSave={handleUpdateAssetTitle}
              className="text-xl font-bold text-white leading-tight drop-shadow-lg hover:text-white"
              inputClassName="bg-black/60 border-white/30 text-white h-9 text-xl font-bold"
              showEditIcon
            />
            <div className="flex items-center gap-2 mt-2">
              <Badge
                variant="secondary"
                className="bg-white/20 text-white border-0 text-xs px-2 py-0.5 font-semibold"
              >
                {asset.format || "Video"}
              </Badge>
              {isReady && (
                <Badge
                  variant="secondary"
                  className="bg-emerald-500/30 text-emerald-300 border-0 text-xs px-2 py-0.5 font-semibold"
                >
                  Ready
                </Badge>
              )}
            </div>
          </div>
        </div>

        {/* Scenes Section */}
        <div className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
              Scenes
            </h3>
            {isReady && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs font-semibold"
                onClick={handleCreateProject}
              >
                <PlusCircle className="h-3.5 w-3.5 mr-1.5" />
                Create Microseries
              </Button>
            )}
          </div>

          {/* Projects/Scenes List */}
          {!isReady ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2 text-blue-500" />
              <span className="text-xs font-medium">Processing...</span>
            </div>
          ) : loadingProjects ? (
            <div className="space-y-3">
              {[1, 2].map((i) => (
                <div key={i} className="flex gap-3 animate-pulse">
                  <div className="w-20 h-12 bg-muted rounded-lg shrink-0" />
                  <div className="flex-1 space-y-2 py-1">
                    <div className="h-4 bg-muted rounded w-3/4" />
                    <div className="h-3 bg-muted rounded w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : projects.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-sm text-muted-foreground mb-4">
                No microseries yet
              </p>
              <Button size="sm" onClick={handleCreateProject}>
                <PlusCircle className="h-4 w-4 mr-2" />
                Create First
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {(() => {
                const sorted = [...projects].sort(
                  (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
                );
                const visible = showAllProjects ? sorted : sorted.slice(0, 3);
                const hiddenCount = sorted.length - 3;

                return (
                  <>
                    {visible.map((project, index) => (
                      <div
                        key={project.projectId}
                        className="flex items-center gap-3 p-2.5 -mx-2 rounded-lg hover:bg-muted cursor-pointer transition-all group/item"
                        onClick={() => {
                          touchRecentAsset(asset.id);
                          navigate(`/editor/${project.projectId}`);
                        }}
                      >
                        {/* Thumbnail */}
                        <div className="w-20 h-12 bg-muted rounded-lg overflow-hidden shrink-0 relative">
                          {asset.videoUrl && getFirstSegmentTime(project) !== null ? (
                            <VideoThumbnail
                              videoUrl={asset.videoUrl}
                              time={getFirstSegmentTime(project)!}
                              className="w-full h-full"
                              fallbackUrl={FALLBACK_THUMBNAIL}
                            />
                          ) : (
                            <img
                              src={FALLBACK_THUMBNAIL}
                              alt={project.title}
                              className="w-full h-full object-cover"
                            />
                          )}
                          <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover/item:opacity-100 transition-opacity">
                            <Play className="h-4 w-4 text-white fill-white" />
                          </div>
                        </div>

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-muted-foreground text-sm font-medium">
                              {index + 1}.
                            </span>
                            <EditableTitle
                              title={project.title || "Untitled"}
                              onSave={(newTitle) =>
                                handleUpdateProjectTitle(project.projectId, newTitle)
                              }
                              className="text-sm font-semibold text-foreground hover:text-blue-400"
                              inputClassName="bg-muted border-border text-foreground h-7 text-sm"
                              showEditIcon
                            />
                            {favorites[project.projectId] && (
                              <Heart className="h-3 w-3 fill-pink-500 text-pink-500 shrink-0" />
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground font-medium">
                            {project.segmentCount > 0
                              ? `${project.segmentCount} segment${
                                  project.segmentCount !== 1 ? "s" : ""
                                }`
                              : new Date(project.createdAt).toLocaleDateString()}
                          </p>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center shrink-0 opacity-0 group-hover/item:opacity-100 transition-opacity">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 hover:bg-accent"
                            onClick={(e) => toggleFavorite(project.projectId, e)}
                          >
                            <Heart
                              className={cn(
                                "h-4 w-4",
                                favorites[project.projectId]
                                  ? "fill-pink-500 text-pink-500"
                                  : "text-muted-foreground",
                              )}
                            />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 hover:bg-accent"
                            onClick={(e) => handleShare(project.projectId, e)}
                          >
                            <Share2 className="h-4 w-4 text-muted-foreground" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 hover:bg-red-500/10 hover:text-red-500"
                            onClick={(e) => {
                              e.stopPropagation();
                              setProjectToDelete(project);
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                    {hiddenCount > 0 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowAllProjects(!showAllProjects);
                        }}
                        className="w-full text-center py-2 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {showAllProjects ? "Show less" : `Show ${hiddenCount} more`}
                      </button>
                    )}
                  </>
                );
              })()}
            </div>
          )}
        </div>
      </div>

      {/* Delete Asset Dialog */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent
          className="bg-card border-border"
          onClick={(e) => e.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle className="text-lg font-bold">
              Delete Asset?
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              This will permanently delete "{asset.title}" and all associated
              data. This action cannot be undone.
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

      {/* Delete Project Dialog */}
      <Dialog
        open={!!projectToDelete}
        onOpenChange={(open) => !open && setProjectToDelete(null)}
      >
        <DialogContent
          className="bg-card border-border"
          onClick={(e) => e.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle className="text-lg font-bold">
              Delete Project?
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              This will permanently delete "
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
