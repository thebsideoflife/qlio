import { useState, useEffect, useRef } from "react";
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
  getProject,
  updateProject,
  updateAsset,
} from "@/services/api";
import { EditableTitle } from "@/components/ui/editable-title";

interface AssetCardProps {
  asset: Asset;
  onCreateProject: (assetId: string) => void;
  onDelete: (assetId: string) => void;
  onUpdateAsset?: (assetId: string, updates: Partial<Asset>) => void;
  variant?: "spotlight" | "collapsed";
  onSelect?: () => void;
}

interface ProjectSegment {
  id: string;
  startTime: number;
  endTime: number;
  title: string;
}

interface Project {
  projectId: string;
  title: string;
  createdAt: string;
  status: string;
  thumbnail?: string;
  segments?: ProjectSegment[];
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
const FAVORITES_KEY = "zeevee-favorites";

function getFavorites(): Record<string, boolean> {
  try {
    const stored = localStorage.getItem(FAVORITES_KEY);
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
    // Check cache first
    const cached = thumbnailCache.get(cacheKey);
    if (cached) {
      setThumbnailUrl(cached);
      setLoading(false);
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
            className
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

  // Get display title - use originalName as fallback if title is empty/untitled
  const getDisplayTitle = (title: string) => {
    if (!title || title.toLowerCase() === "untitled") {
      return asset.originalName || title || "Untitled";
    }
    return title;
  };

  const [localAssetTitle, setLocalAssetTitle] = useState(
    getDisplayTitle(asset.title)
  );

  const currentStageLabel = asset.processing?.stage
    ? stageLabels[asset.processing.stage]
    : "";

  const isReady = asset.status === "completed" || asset.status === "READY";

  // Sync local title with prop
  useEffect(() => {
    setLocalAssetTitle(getDisplayTitle(asset.title));
  }, [asset.title, asset.originalName]);

  useEffect(() => {
    if (isReady && variant === "spotlight") {
      loadProjects();
    }
  }, [asset.id, isReady, variant]);

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

  const loadProjects = async () => {
    setLoadingProjects(true);
    try {
      const projectList = await listProjects(asset.id);
      // Fetch segment data for each project to get first segment start time
      const projectsWithSegments = await Promise.all(
        projectList.map(async (project: Project) => {
          try {
            const fullProject = await getProject(project.projectId);
            return {
              ...project,
              segments: fullProject.segments || [],
            };
          } catch {
            return project;
          }
        })
      );
      setProjects(projectsWithSegments);
    } catch (error) {
      console.error("Failed to load projects:", error);
    } finally {
      setLoadingProjects(false);
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
    newTitle: string
  ) => {
    // Optimistic update
    setProjects(
      projects.map((p) =>
        p.projectId === projectId ? { ...p, title: newTitle } : p
      )
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
              : p
          )
        );
      }
    }
  };

  // Get fallback thumbnail URL
  const getFallbackThumbnail = (): string => {
    return (
      asset.thumbnailUrl ||
      asset.thumbnail ||
      "https://images.unsplash.com/photo-1626814026160-2237a95fc5a0?w=200&auto=format&fit=crop&q=60"
    );
  };

  // Get first segment start time for a project
  const getFirstSegmentTime = (project: Project): number | null => {
    if (project.segments && project.segments.length > 0) {
      return project.segments[0].startTime;
    }
    return null;
  };

  // Collapsed variant - small thumbnail card for 2x2 grid
  if (variant === "collapsed") {
    return (
      <div
        className={cn(
          "rounded-lg overflow-hidden bg-slate-900/80 border border-slate-800/50 cursor-pointer transition-all duration-200 hover:border-purple-500/50",
          "group"
        )}
        onClick={onSelect}
      >
        <div className="relative aspect-[4/3] w-full overflow-hidden">
          <img
            src={
              asset.thumbnailUrl ||
              asset.thumbnail ||
              "https://images.unsplash.com/photo-1626814026160-2237a95fc5a0?w=400&auto=format&fit=crop&q=60"
            }
            alt={asset.title}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
          {/* Status badge */}
          {(asset.status === "uploading" ||
            ((asset.status === "processing" || asset.status === "indexing") &&
              asset.processing)) && (
            <div className="absolute top-1.5 left-1.5">
              <Badge className="bg-blue-500/90 text-white border-0 text-[10px] px-1.5 py-0">
                <Loader2 className="h-2.5 w-2.5 animate-spin mr-0.5" />
                {currentStageLabel || asset.status}
              </Badge>
            </div>
          )}
          {/* Title overlay at bottom */}
          <div className="absolute bottom-0 left-0 right-0 p-2.5">
            <h3 className="text-sm font-medium text-white truncate drop-shadow-md">
              {localAssetTitle}
            </h3>
            <p className="text-xs text-white/60 truncate">
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
      <div className="rounded-xl overflow-hidden bg-gradient-to-b from-slate-900 to-slate-950 border border-slate-800/50 shadow-xl">
        {/* Hero Section - 16:9 landscape */}
        <div className="relative aspect-video w-full overflow-hidden group">
          <img
            src={
              asset.thumbnailUrl ||
              asset.thumbnail ||
              "https://images.unsplash.com/photo-1626814026160-2237a95fc5a0?w=800&auto=format&fit=crop&q=60"
            }
            alt={asset.title}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
          {/* Gradient overlay */}
          <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-transparent to-transparent" />

          {/* Status badge */}
          <div className="absolute top-2 left-2 z-10">
            {asset.status === "uploading" ||
            ((asset.status === "processing" || asset.status === "indexing") &&
              asset.processing) ? (
              <Badge className="bg-blue-500/90 text-white border-0 backdrop-blur-md text-xs px-2 py-0.5">
                {asset.status === "uploading" ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    {asset.uploadProgress
                      ? `${asset.uploadProgress}%`
                      : "Uploading"}
                  </>
                ) : (
                  <>
                    <Activity className="h-3 w-3 animate-pulse mr-1" />
                    {currentStageLabel || asset.status}
                  </>
                )}
              </Badge>
            ) : null}
          </div>

          {/* More menu */}
          <div className="absolute top-2 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 bg-black/40 hover:bg-black/60 text-white backdrop-blur-md rounded-full"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="bg-slate-900 border-slate-700"
              >
                <DropdownMenuItem
                  className="text-red-400 focus:text-red-300 focus:bg-red-500/10"
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
          <div className="absolute bottom-0 left-0 right-0 p-3">
            <EditableTitle
              title={localAssetTitle}
              onSave={handleUpdateAssetTitle}
              className="text-lg font-bold text-white leading-tight drop-shadow-lg hover:text-white"
              inputClassName="bg-slate-800/80 border-slate-600 text-white h-8 text-lg font-bold"
              showEditIcon
            />
            <div className="flex items-center gap-2 mt-1">
              <Badge
                variant="secondary"
                className="bg-white/10 text-white/80 border-0 text-[10px] px-1.5 py-0"
              >
                {asset.format || "Video"}
              </Badge>
              {isReady && (
                <Badge
                  variant="secondary"
                  className="bg-emerald-500/20 text-emerald-300 border-0 text-[10px] px-1.5 py-0"
                >
                  Ready
                </Badge>
              )}
            </div>
          </div>
        </div>

        {/* Scenes Section */}
        <div className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
              Scenes
            </h3>
            {isReady && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs border-slate-700 hover:border-purple-500/50 hover:bg-purple-500/10 text-slate-300 hover:text-white px-3"
                onClick={handleCreateProject}
              >
                <PlusCircle className="h-3.5 w-3.5 mr-1.5" />
                Create Microdrama
              </Button>
            )}
          </div>

          {/* Projects/Scenes List */}
          {!isReady ? (
            <div className="text-center py-6 text-sm text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2 text-purple-400" />
              <span className="text-xs">Processing...</span>
            </div>
          ) : loadingProjects ? (
            <div className="space-y-2">
              {[1, 2].map((i) => (
                <div key={i} className="flex gap-3 animate-pulse">
                  <div className="w-20 h-12 bg-slate-800 rounded-md shrink-0" />
                  <div className="flex-1 space-y-2 py-1">
                    <div className="h-3.5 bg-slate-800 rounded w-3/4" />
                    <div className="h-2.5 bg-slate-800 rounded w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : projects.length === 0 ? (
            <div className="text-center py-6">
              <p className="text-xs text-slate-500 mb-3">No microdramas yet</p>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs border-slate-700 hover:border-purple-500/50 hover:bg-purple-500/10 text-slate-300 hover:text-white px-3"
                onClick={handleCreateProject}
              >
                <PlusCircle className="h-3.5 w-3.5 mr-1.5" />
                Create First
              </Button>
            </div>
          ) : (
            <div className="space-y-1.5">
              {projects.map((project, index) => (
                <div
                  key={project.projectId}
                  className="flex items-center gap-3 p-2 -mx-2 rounded-lg hover:bg-slate-800/50 cursor-pointer transition-all group/item"
                  onClick={() => navigate(`/editor/${project.projectId}`)}
                >
                  {/* Thumbnail */}
                  <div className="w-20 h-12 bg-slate-800 rounded-md overflow-hidden shrink-0 relative">
                    {asset.videoUrl && getFirstSegmentTime(project) !== null ? (
                      <VideoThumbnail
                        videoUrl={asset.videoUrl}
                        time={getFirstSegmentTime(project)!}
                        className="w-full h-full"
                        fallbackUrl={getFallbackThumbnail()}
                      />
                    ) : (
                      <img
                        src={getFallbackThumbnail()}
                        alt={project.title}
                        className="w-full h-full object-cover"
                      />
                    )}
                    <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover/item:opacity-100 transition-opacity">
                      <Play className="h-4 w-4 text-white fill-white" />
                    </div>
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-slate-500 text-sm">
                        {index + 1}.
                      </span>
                      <EditableTitle
                        title={project.title || "Untitled"}
                        onSave={(newTitle) =>
                          handleUpdateProjectTitle(project.projectId, newTitle)
                        }
                        className="text-sm font-medium text-slate-200 hover:text-white"
                        inputClassName="bg-slate-800 border-slate-600 text-slate-200 h-7 text-sm"
                        showEditIcon
                      />
                      {favorites[project.projectId] && (
                        <Heart className="h-3 w-3 fill-pink-500 text-pink-500 shrink-0" />
                      )}
                    </div>
                    <p className="text-xs text-slate-500">
                      {project.segments && project.segments.length > 0
                        ? `${project.segments.length} segment${
                            project.segments.length !== 1 ? "s" : ""
                          }`
                        : new Date(project.createdAt).toLocaleDateString()}
                    </p>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center shrink-0 opacity-0 group-hover/item:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 hover:bg-slate-700"
                      onClick={(e) => toggleFavorite(project.projectId, e)}
                    >
                      <Heart
                        className={cn(
                          "h-3.5 w-3.5",
                          favorites[project.projectId]
                            ? "fill-pink-500 text-pink-500"
                            : "text-slate-400"
                        )}
                      />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 hover:bg-slate-700"
                      onClick={(e) => handleShare(project.projectId, e)}
                    >
                      <Share2 className="h-3.5 w-3.5 text-slate-400" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 hover:bg-red-500/10 hover:text-red-400"
                      onClick={(e) => {
                        e.stopPropagation();
                        setProjectToDelete(project);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Delete Asset Dialog */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent
          className="bg-slate-900 border-slate-700"
          onClick={(e) => e.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle>Delete Asset?</DialogTitle>
            <DialogDescription className="text-slate-400">
              This will permanently delete "{asset.title}" and all associated
              data. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="border-slate-700 hover:bg-slate-800"
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
          className="bg-slate-900 border-slate-700"
          onClick={(e) => e.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle>Delete Project?</DialogTitle>
            <DialogDescription className="text-slate-400">
              This will permanently delete "
              {projectToDelete?.title || "Untitled"}". This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="border-slate-700 hover:bg-slate-800"
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
