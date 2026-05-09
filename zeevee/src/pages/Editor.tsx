import React, { useCallback } from "react";
import { Timeline } from "@/components/editor/Timeline";
import {
  MicrodramaGenerator,
  type GenerateRequest,
} from "@/components/editor/MicrodramaGenerator";
import { CaptionOverlay } from "@/components/editor/CaptionOverlay";
import { CaptionEditor } from "@/components/editor/CaptionEditor";
import { FramingSlider } from "@/components/editor/FramingSlider";
import { Skeleton } from "@/components/ui/skeleton";
import { useSelector, useDispatch } from "react-redux";
import type { RootState } from "@/store/store";
import {
  selectSegment,
  setCurrentTime,
  setDuration,
  setSegments,
  setProjectId,
  resetEditor,
  updateFramingKeyframe,
  updateCaptionWord,
} from "@/store/editorSlice";
import { useParams } from "react-router-dom";
import { useRef, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useProjectData } from "@/hooks/useProjectData";
import { useSeamlessPlayback } from "@/hooks/useSeamlessPlayback";
import {
  generateSegments,
  pollGenerationStatus,
  getProject,
  getProjectJobStatus,
  type GenerationJob,
} from "@/services/api";
import {
  FileText,
  Wand2,
  Captions,
  Crop,
  Maximize2,
  Clock,
  Pencil,
} from "lucide-react";
import { getEffectiveKeyframes } from "@/remotion/types";
import type { AspectRatio } from "@/remotion/types";

export default function Editor() {
  const { projectId } = useParams();
  const dispatch = useDispatch();

  // Redux State
  const selectedSegmentId = useSelector(
    (state: RootState) => state.editor.selectedSegmentId,
  );
  const segments = useSelector((state: RootState) => state.editor.segments);
  const currentTime = useSelector(
    (state: RootState) => state.editor.currentTime,
  );
  const duration = useSelector((state: RootState) => state.editor.duration);
  const globalFraming = useSelector(
    (state: RootState) => state.editor.globalFraming,
  );

  const selectedKeyframeId = useSelector(
    (state: RootState) => state.editor.selectedKeyframeId,
  );

  // Local State
  const videoRef = useRef<HTMLVideoElement>(null);
  const [activeTab, setActiveTab] = useState<"transcript" | "ai" | "captions">(
    "ai",
  );
  // Track the last projectId we initialized state for — used to reset state on project change
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStatus, setGenerationStatus] =
    useState<GenerationJob | null>(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [autoFrameEnabled, setAutoFrameEnabled] = useState(true);

  // Refs — declared before render-time reset block so they can be accessed there
  const projectIdRef = useRef(projectId);
  useEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);
  // Stores "projectId:jobId" — naturally unique per project, no reset needed on navigation
  const resumedGenerationJobRef = useRef<string | null>(null);

  // Reset async state when navigating to a different project (during render, avoids cascading effects)
  if (projectId !== activeProjectId) {
    setActiveProjectId(projectId ?? null);
    setIsGenerating(false);
    setGenerationStatus(null);
    setPreviewMode(false);
  }

  // Custom Hooks
  const {
    videoUrl,
    transcription,
    generationMetadata,
    generationJob,
    framingJob,
    loading,
  } = useProjectData(projectId);
  // Seamless playback only in preview mode
  useSeamlessPlayback(videoRef, previewMode ? segments : []);

  // Get current segment's framing for preview - memoized to avoid find() on every render
  const selectedSegment = React.useMemo(
    () => segments.find((s) => s.id === selectedSegmentId),
    [segments, selectedSegmentId],
  );
  // Framing preview state
  // When no segment selected, use local preview state that doesn't persist
  const [previewZoom, setPreviewZoom] = useState(1.0);
  const [previewFocus, setPreviewFocus] = useState({ x: 0.5, y: 0.5 });

  // Get the currently selected keyframe's values
  const selectedKeyframe = React.useMemo(() => {
    if (!selectedSegment?.framing) return null;
    const kfs = getEffectiveKeyframes(selectedSegment.framing);
    if (selectedKeyframeId) {
      return kfs.find((kf) => kf.id === selectedKeyframeId) || kfs[0];
    }
    return kfs[0];
  }, [selectedSegment, selectedKeyframeId]);

  // Derive display values from selected keyframe or preview state
  const displayZoom = selectedKeyframe ? selectedKeyframe.zoom : previewZoom;
  const displayFocusX = selectedKeyframe
    ? selectedKeyframe.focusX
    : previewFocus.x;
  const displayFocusY = selectedKeyframe
    ? selectedKeyframe.focusY
    : previewFocus.y;

  // Unified helper: update keyframe if segment selected, otherwise update local preview
  const updateFramingValue = useCallback(
    (changes: Partial<{ focusX: number; focusY: number; zoom: number }>) => {
      if (selectedSegmentId && selectedKeyframe) {
        dispatch(
          updateFramingKeyframe({
            segmentId: selectedSegmentId,
            keyframeId: selectedKeyframe.id,
            changes,
          }),
        );
      } else {
        if (changes.focusX !== undefined || changes.focusY !== undefined) {
          setPreviewFocus((prev) => ({
            x: changes.focusX ?? prev.x,
            y: changes.focusY ?? prev.y,
          }));
        }
        if (changes.zoom !== undefined) {
          setPreviewZoom(changes.zoom);
        }
      }
    },
    [selectedSegmentId, selectedKeyframe, dispatch],
  );

  const framingContainerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{
    x: number;
    y: number;
    focusX: number;
    focusY: number;
  } | null>(null);

  // Track if we actually dragged (moved more than a few pixels)
  const hasDraggedRef = useRef(false);

  // Handle drag to reposition video within frame
  // Uses window-level listeners to capture mouse events even when cursor leaves the container
  const handleFramingMouseDown = (e: React.MouseEvent) => {
    if (displayZoom <= 0) return;
    e.preventDefault();
    setIsDragging(true);
    hasDraggedRef.current = false;
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      focusX: displayFocusX,
      focusY: displayFocusY,
    };
  };

  // Use effect to attach window-level listeners when dragging
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current || !framingContainerRef.current) return;

      const container = framingContainerRef.current;
      const rect = container.getBoundingClientRect();

      const deltaX = (e.clientX - dragStartRef.current.x) / rect.width;
      const deltaY = (e.clientY - dragStartRef.current.y) / rect.height;

      if (Math.abs(deltaX) > 0.01 || Math.abs(deltaY) > 0.01) {
        hasDraggedRef.current = true;
      }

      const newFocusX = Math.max(
        0,
        Math.min(1, dragStartRef.current.focusX - deltaX),
      );
      const newFocusY = Math.max(
        0,
        Math.min(1, dragStartRef.current.focusY - deltaY),
      );

      updateFramingValue({ focusX: newFocusX, focusY: newFocusY });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, updateFramingValue]);

  // Handle click on video container (play/pause) - only if we didn't drag
  const handleFramingClick = (e: React.MouseEvent) => {
    if (!hasDraggedRef.current) {
      handleVideoClick(e);
    }
    hasDraggedRef.current = false;
  };

  // Calculate aspect ratio for preview container
  const getAspectRatioValue = (ratio: AspectRatio): number => {
    switch (ratio) {
      case "9:16":
        return 9 / 16;
      case "1:1":
        return 1;
      case "16:9":
      default:
        return 16 / 9;
    }
  };

  const aspectRatioValue = getAspectRatioValue(globalFraming.aspectRatio);

  // Set projectId in Redux for sync middleware
  // Also reset local state when switching projects (prevents stale state from previous project)
  useEffect(() => {
    if (projectId) {
      dispatch(setProjectId(projectId));
    }

    return () => {
      dispatch(resetEditor());
    };
  }, [projectId, dispatch]);

  // Resume polling if there's an in-progress generation job (e.g., after page refresh)
  useEffect(() => {
    if (!projectId || !generationJob || loading) return;

    const inProgressStatuses = ["pending", "detecting_scenes", "generating"];
    if (!inProgressStatuses.includes(generationJob.status)) return;

    // Already generating (user clicked button in this session)
    if (isGenerating) return;

    // Already handled this job in this session — prevents re-firing when isGenerating resets
    const resumeKey = `${projectId}:${generationJob.jobId}`;
    if (resumedGenerationJobRef.current === resumeKey) return;
    resumedGenerationJobRef.current = resumeKey;

    console.log(
      `[Editor] Resuming polling for in-progress job: ${generationJob.jobId} (${generationJob.status})`,
    );

    // Capture projectId at start to check against later
    const startingProjectId = projectId;

    // Defer state updates out of the synchronous effect body to avoid cascading renders
    Promise.resolve().then(() => {
      setIsGenerating(true);
      setGenerationStatus(generationJob);
    });

    let framingPollTookOver = false;

    // Resume polling - use shorter initial delay since job is already running
    pollGenerationStatus(projectId, {
      initialDelayMs: 5000, // 5s initial delay (job already started)
      pollIntervalMs: 10000, // 10s intervals
      onProgress: (job) => {
        // Only update if still on same project
        if (projectIdRef.current !== startingProjectId) return;
        console.log(`[Editor] Generation status: ${job.status}`);
        setGenerationStatus(job);
      },
    })
      .then(async (result) => {
        // Guard: only dispatch if still on the same project
        if (projectIdRef.current !== startingProjectId) {
          console.log(
            `[Editor] Ignoring stale generation result for project ${startingProjectId}`,
          );
          return;
        }
        if (result.segments.length > 0) {
          dispatch(setSegments(result.segments));
          console.log(
            `[Editor] Generation complete (resumed): ${result.segments.length} segments`,
          );
        }

        // Check if framing job is running (use slim endpoint)
        if (projectIdRef.current !== startingProjectId) return;
        try {
          const jobStatus = await getProjectJobStatus(startingProjectId);
          const fJob = jobStatus.framingJob;
          if (
            fJob &&
            (fJob.status === "pending" || fJob.status === "analyzing") &&
            projectIdRef.current === startingProjectId
          ) {
            framingPollTookOver = true;
            setGenerationStatus({
              status: "framing",
              jobId: fJob.jobId || "",
              startedAt: fJob.startedAt || "",
            });
            const POLL = 10000;
            const MAX = 600000;
            const start = Date.now();
            // Poll framing status with slim endpoint
            (async () => {
              while (Date.now() - start < MAX) {
                if (projectIdRef.current !== startingProjectId) break;
                await new Promise((r) => setTimeout(r, POLL));
                if (projectIdRef.current !== startingProjectId) break;
                let status;
                try {
                  status = await getProjectJobStatus(startingProjectId);
                } catch {
                  break;
                }
                if (status.framingJob?.status === "completed") {
                  // Fetch full project only on completion
                  try {
                    const p = await getProject(startingProjectId);
                    if (p.segments?.length) dispatch(setSegments(p.segments));
                  } catch {
                    // Non-fatal
                  }
                  break;
                }
                if (status.framingJob?.status === "failed") break;
              }
              if (projectIdRef.current === startingProjectId) {
                setIsGenerating(false);
                setGenerationStatus(null);
              }
            })();
          }
        } catch {
          /* non-fatal */
        }
      })
      .catch((error: unknown) => {
        console.error("Generation failed (resumed):", error);
        // Don't show alert for resumed jobs that fail - might be stale
      })
      .finally(() => {
        // Only reset state if framing poll didn't take over
        if (
          !framingPollTookOver &&
          projectIdRef.current === startingProjectId
        ) {
          setIsGenerating(false);
          setGenerationStatus(null);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isGenerating intentionally omitted to prevent re-triggering when it changes
  }, [projectId, generationJob, loading, dispatch]);

  // Resume framing poll if there's an in-progress framing job (e.g., after page refresh)
  // Uses slim job status endpoint for polling, fetches full project only on completion
  useEffect(() => {
    if (!projectId || !framingJob || loading) return;
    if (framingJob.status !== "pending" && framingJob.status !== "analyzing")
      return;
    if (isGenerating) return; // generation flow will handle it

    const startingProjectId = projectId;
    let cancelled = false;

    (async () => {
      const POLL = 10000;
      const MAX = 600000;
      const start = Date.now();
      while (!cancelled && Date.now() - start < MAX) {
        await new Promise((r) => setTimeout(r, POLL));
        if (cancelled || projectIdRef.current !== startingProjectId) break;

        // Use slim endpoint for polling
        let jobStatus;
        try {
          jobStatus = await getProjectJobStatus(startingProjectId);
        } catch {
          break;
        }

        const job = jobStatus.framingJob;
        if (!job) break;

        if (job.status === "completed") {
          // Only fetch full project when done - need the updated segments
          try {
            const project = await getProject(startingProjectId);
            if (project.segments?.length) dispatch(setSegments(project.segments));
          } catch {
            // Non-fatal
          }
          break;
        }
        if (job.status === "failed") break;
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isGenerating intentionally omitted to prevent re-triggering when it changes
  }, [projectId, framingJob, loading, dispatch]);

  // Don't auto-seek when selecting segments - timeline handles seeking now
  // useEffect(() => {
  //   if (selectedSegmentId && videoRef.current) {
  //     const seg = segments.find((s) => s.id === selectedSegmentId);
  //     if (seg) {
  //       videoRef.current.currentTime = seg.startTime;
  //       videoRef.current.play();
  //     }
  //   }
  // }, [selectedSegmentId, segments]);

  const handleBackgroundClick = () => {
    if (selectedSegmentId) {
      dispatch(selectSegment(null));
    }
  };

  // Toggle video play/pause
  const handleVideoClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      const playPromise = video.play();
      if (playPromise !== undefined) {
        playPromise.catch((error) => {
          if (error.name !== "AbortError") {
            console.error("Playback error:", error);
          }
        });
      }
    } else {
      video.pause();
    }
  };

  // RAF for accurate time sync (captions, timeline, transcript)
  useEffect(() => {
    if (!videoUrl) return; // Don't start RAF until video is available

    let rafId: number;

    const tick = () => {
      const video = videoRef.current;
      if (video && !isNaN(video.currentTime)) {
        dispatch(setCurrentTime(video.currentTime));
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [dispatch, videoUrl]);

  const handleWordClick = (startTime: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = startTime;
      const playPromise = videoRef.current.play();
      if (playPromise !== undefined) {
        playPromise.catch((error) => {
          // Ignore AbortError - it's expected when user rapidly interacts
          if (error.name !== "AbortError") {
            console.error("Playback error:", error);
          }
        });
      }
    }
  };

  const handleGenerateSegments = async (request: GenerateRequest) => {
    if (!projectId) return;

    // Capture projectId at start to check against later
    const startingProjectId = projectId;

    setIsGenerating(true);
    setGenerationStatus(null);

    const videoDuration = videoRef.current
      ? videoRef.current.duration
      : duration;

    try {
      // Start async generation job — backend handles auto-framing if requested
      const { jobId } = await generateSegments(projectId, {
        userPrompt: request.userPrompt || undefined,
        videoDuration: videoDuration || undefined,
        autoFrame: autoFrameEnabled,
        targetAspectRatio: globalFraming.aspectRatio,
      });
      console.log(`[Editor] Started generation job: ${jobId}`);

      if (projectIdRef.current !== startingProjectId) return;

      setGenerationStatus({
        status: "pending",
        jobId,
        startedAt: new Date().toISOString(),
      });

      // Poll until generation completes
      const result = await pollGenerationStatus(projectId, {
        onProgress: (job) => {
          if (projectIdRef.current !== startingProjectId) return;
          setGenerationStatus(job);
        },
      });

      if (projectIdRef.current !== startingProjectId) return;

      if (result.segments.length > 0) {
        dispatch(setSegments(result.segments));
        // Auto-select first segment and switch to transcript tab
        dispatch(selectSegment(result.segments[0].id));
        setActiveTab("transcript");
        console.log(
          `[Editor] Generation complete: ${result.segments.length} segments`,
        );

        // If auto-frame was requested, poll for framing completion (slim)
        if (autoFrameEnabled) {
          setGenerationStatus({
            status: "framing",
            jobId,
            startedAt: new Date().toISOString(),
          });
          const FRAMING_POLL = 10000;
          const FRAMING_MAX = 600000;
          const framingStart = Date.now();
          while (Date.now() - framingStart < FRAMING_MAX) {
            if (projectIdRef.current !== startingProjectId) break;
            await new Promise((r) => setTimeout(r, FRAMING_POLL));
            if (projectIdRef.current !== startingProjectId) break;
            // Use slim endpoint for polling
            let jobStatus;
            try {
              jobStatus = await getProjectJobStatus(startingProjectId);
            } catch {
              break;
            }
            const job = jobStatus.framingJob;
            if (!job) break;
            if (job.status === "completed") {
              // Fetch full project only on completion
              try {
                const project = await getProject(startingProjectId);
                if (project.segments?.length)
                  dispatch(setSegments(project.segments));
              } catch {
                // Non-fatal
              }
              break;
            }
            if (job.status === "failed") break;
          }
        }
      }

      setIsGenerating(false);
      setGenerationStatus(null);
    } catch (error: unknown) {
      // Only show error if still on same project
      if (projectIdRef.current === startingProjectId) {
        console.error("Failed to generate segments:", error);
        const message =
          error instanceof Error
            ? error.message
            : "Failed to generate segments. Please try again.";
        alert(message);
        setIsGenerating(false);
        setGenerationStatus(null);
      }
    }
  };

  if (loading) {
    return (
      <div className="flex h-[calc(100vh-4rem)]">
        {/* Left: Video & Timeline skeleton */}
        <div className="flex-1 flex flex-col min-w-0 bg-background border-r">
          <div className="flex-1 bg-black flex items-center justify-center">
            <Skeleton className="w-[80%] aspect-video bg-muted/20" />
          </div>
          <div className="h-32 border-t bg-card p-2">
            <Skeleton className="w-full h-full" />
          </div>
        </div>
        {/* Right: Sidebar skeleton */}
        <div className="w-80 flex flex-col bg-card border-l p-4 space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-4rem)]">
      {/* Left: Video & Timeline */}
      <div className="flex-1 flex flex-col min-w-0 bg-background">
        {/* Video Player with Caption Overlay */}
        <div
          className="flex-1 bg-zinc-950 relative flex items-center justify-center min-h-0 p-4 gap-4"
          onClick={handleBackgroundClick}
        >
          {videoUrl ? (
            /* Framing Preview - aspect ratio container with draggable video */
            <div
              ref={framingContainerRef}
              className={cn(
                "relative overflow-hidden bg-black rounded-2xl select-none shadow-2xl shadow-black/50",
                isDragging
                  ? "cursor-grabbing ring-4 ring-blue-500 ring-offset-4 ring-offset-zinc-950"
                  : displayZoom > 0
                    ? "cursor-grab ring-2 ring-zinc-600 hover:ring-zinc-500"
                    : "cursor-pointer ring-2 ring-zinc-700",
              )}
              style={{
                aspectRatio: aspectRatioValue,
                maxHeight: aspectRatioValue < 1 ? "100%" : "90%",
                maxWidth: aspectRatioValue >= 1 ? "100%" : "90%",
              }}
              onMouseDown={
                displayZoom > 0
                  ? handleFramingMouseDown
                  : undefined
              }
              onClick={
                displayZoom > 0
                  ? handleFramingClick
                  : handleVideoClick
              }
            >
              <video
                ref={videoRef}
                src={videoUrl}
                className="pointer-events-none"
                style={(() => {
                  if (displayZoom <= 0) {
                    return {
                      width: "100%",
                      height: "100%",
                      objectFit: "contain" as const,
                      objectPosition: "center center",
                    };
                  }
                  // Continuous zoom: scale a contained video toward (and beyond) cover size
                  const sourceAspect = 16 / 9;
                  const scaleCover = Math.max(
                    aspectRatioValue / sourceAspect,
                    sourceAspect / aspectRatioValue,
                  );
                  const scale = 1 + displayZoom * (scaleCover - 1);
                  const videoAspectInContainer =
                    sourceAspect / aspectRatioValue;
                  const offsetX =
                    videoAspectInContainer > 1
                      ? ((-(displayFocusX - 0.5) * (scale - 1)) / scale) * 100
                      : 0;
                  const offsetY =
                    videoAspectInContainer <= 1
                      ? ((-(displayFocusY - 0.5) * (scale - 1)) / scale) * 100
                      : 0;
                  return {
                    width: "100%",
                    height: "100%",
                    objectFit: "contain" as const,
                    transformOrigin: "center center",
                    transform: `translate(${offsetX}%, ${offsetY}%) scale(${scale})`,
                  };
                })()}
                onLoadedMetadata={(e) =>
                  dispatch(setDuration(e.currentTarget.duration))
                }
              />

              {/* Overlay Controls - Top Right (when cropping is active) */}
              {displayZoom > 0 && (
                <div className="absolute top-3 right-3 flex items-center gap-2">
                  {/* Zoom slider */}
                  <div
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-900/80 backdrop-blur-sm border border-zinc-700"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Maximize2 className="h-3.5 w-3.5 text-zinc-400" />
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={displayZoom}
                      onChange={(e) => {
                        updateFramingValue({
                          zoom: parseFloat(e.target.value),
                        });
                      }}
                      className="w-20 h-1 accent-blue-500 cursor-pointer"
                      title={`Zoom: ${Math.round(displayZoom * 100)}%`}
                    />
                    <Crop className="h-3.5 w-3.5 text-zinc-400" />
                  </div>
                </div>
              )}

              {/* Drag hint overlay — always visible when cropping is active */}
              {displayZoom > 0 && !isDragging && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 hover:opacity-100 transition-opacity pointer-events-none">
                  <span className="text-white text-sm font-medium px-3 py-1.5 bg-black/70 rounded-full backdrop-blur-sm">
                    Drag to reposition
                  </span>
                </div>
              )}

              {/* Position sliders - visible whenever zoom > 0 */}
              {displayZoom > 0 && (
                <>
                  {/* Vertical slider for landscape */}
                  {globalFraming.aspectRatio === "16:9" && (
                    <FramingSlider
                      orientation="vertical"
                      value={displayFocusY}
                      aspectRatio={1 / aspectRatioValue}
                      onChange={(y) => updateFramingValue({ focusY: y })}
                    />
                  )}

                  {/* Horizontal slider for portrait and square */}
                  {(globalFraming.aspectRatio === "9:16" ||
                    globalFraming.aspectRatio === "1:1") && (
                    <FramingSlider
                      orientation="horizontal"
                      value={displayFocusX}
                      aspectRatio={
                        globalFraming.aspectRatio === "1:1"
                          ? 1.0 / (16 / 9)
                          : aspectRatioValue
                      }
                      onChange={(x) => updateFramingValue({ focusX: x })}
                    />
                  )}
                </>
              )}

              <CaptionOverlay currentTime={currentTime} />
            </div>
          ) : (
            <div className="text-white">Loading Video...</div>
          )}
        </div>

        {/* Timeline */}
        <div className="border-t border-border bg-card">
          <div className="h-40">
            <Timeline
              videoRef={videoRef}
              previewMode={previewMode}
              onPreviewModeChange={setPreviewMode}
            />
          </div>
        </div>
      </div>

      {/* Right: Collapsible Sidebar */}
      <div className="relative flex">
        {/* Edge toggle handle */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className={cn(
            "absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/2 z-20",
            "w-6 h-14 flex items-center justify-center",
            "bg-card border-2 border-border rounded-full shadow-lg",
            "opacity-0 hover:opacity-100 transition-opacity hover:border-blue-500",
            "group-hover:opacity-60",
            !sidebarOpen && "opacity-100",
          )}
          title={sidebarOpen ? "Collapse panel" : "Expand panel"}
        >
          <div
            className={cn(
              "w-1.5 h-7 rounded-full bg-muted-foreground/50 transition-transform",
              !sidebarOpen && "rotate-180",
            )}
          />
        </button>

        <div
          className={cn(
            "flex flex-col bg-card border-l-2 border-border overflow-hidden transition-all duration-200",
            sidebarOpen ? "w-[420px]" : "w-0",
          )}
        >
          {sidebarOpen && (
            <>
              {/* Tabs Header - High Contrast */}
              <div className="flex border-b-2 border-border bg-muted/30">
                {[
                  {
                    id: "ai" as const,
                    icon: Wand2,
                    label: "IQ",
                    tooltip: "IQ Studio - Generate clips with AI",
                  },
                  {
                    id: "captions" as const,
                    icon: Captions,
                    label: "Caps",
                    tooltip: "Caption settings",
                  },
                  {
                    id: "transcript" as const,
                    icon: FileText,
                    label: "Script",
                    tooltip: "Full transcript",
                  },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    className={cn(
                      "flex-1 py-3 text-xs font-bold flex flex-col items-center gap-1 transition-all border-b-2",
                      activeTab === tab.id
                        ? "border-blue-500 text-blue-500 bg-blue-500/10"
                        : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50",
                    )}
                    onClick={() => setActiveTab(tab.id)}
                    title={tab.tooltip}
                  >
                    <tab.icon className="h-4 w-4" />
                    <span>{tab.label}</span>
                  </button>
                ))}
              </div>

              <div className="flex-1 overflow-y-auto relative">
                {activeTab === "ai" && (
                  <MicrodramaGenerator
                    onGenerate={handleGenerateSegments}
                    isGenerating={isGenerating}
                    generationStatus={generationStatus}
                    initialUserPrompt={generationMetadata?.userPrompt}
                    autoFrameEnabled={autoFrameEnabled}
                    onAutoFrameChange={setAutoFrameEnabled}
                  />
                )}
                {activeTab === "captions" && <CaptionEditor />}
                {activeTab === "transcript" && (
                  <TranscriptPanel
                    transcription={transcription}
                    segments={segments}
                    currentTime={currentTime}
                    duration={duration}
                    previewMode={previewMode}
                    onWordClick={handleWordClick}
                    loading={loading}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Helper to format time as MM:SS
function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

// Group words into chunks of ~10 seconds each
function groupWordsIntoChunks(
  words: Array<{ start: number; end: number; value: string }>,
  chunkDuration = 10,
): Array<{
  startTime: number;
  endTime: number;
  words: Array<{ start: number; end: number; value: string }>;
}> {
  if (words.length === 0) return [];

  const chunks: Array<{
    startTime: number;
    endTime: number;
    words: Array<{ start: number; end: number; value: string }>;
  }> = [];

  let currentChunk: {
    startTime: number;
    endTime: number;
    words: Array<{ start: number; end: number; value: string }>;
  } | null = null;

  for (const word of words) {
    if (!currentChunk) {
      currentChunk = {
        startTime: word.start,
        endTime: word.end,
        words: [word],
      };
    } else if (word.start - currentChunk.startTime < chunkDuration) {
      currentChunk.words.push(word);
      currentChunk.endTime = word.end;
    } else {
      chunks.push(currentChunk);
      currentChunk = {
        startTime: word.start,
        endTime: word.end,
        words: [word],
      };
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

interface TranscriptPanelProps {
  transcription: Array<{ start: number; end: number; value: string }>;
  segments: Array<{ id: string; startTime: number; endTime: number }>;
  currentTime: number;
  duration: number;
  previewMode: boolean;
  onWordClick: (startTime: number) => void;
  loading: boolean;
}

function TranscriptPanel({
  transcription,
  segments,
  currentTime,
  duration,
  previewMode,
  onWordClick,
  loading,
}: TranscriptPanelProps) {
  const dispatch = useDispatch();
  const captions = useSelector((state: RootState) => state.editor.captions);
  
  // Edit mode state
  const [editMode, setEditMode] = React.useState(false);
  const [editingWord, setEditingWord] = React.useState<{
    start: number;
    end: number;
  } | null>(null);
  const [editValue, setEditValue] = React.useState("");
  const editInputRef = React.useRef<HTMLInputElement>(null);

  // Focus input when editing starts
  React.useEffect(() => {
    if (editingWord && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingWord]);

  // Find caption and word index by time
  const findCaptionWord = React.useCallback(
    (start: number, end: number) => {
      for (const caption of captions) {
        const wordIndex = caption.words.findIndex(
          (w) => Math.abs(w.start - start) < 0.01 && Math.abs(w.end - end) < 0.01
        );
        if (wordIndex !== -1) {
          return { captionId: caption.id, wordIndex };
        }
      }
      return null;
    },
    [captions]
  );

  const handleWordEdit = React.useCallback(
    (word: { start: number; end: number; value: string }) => {
      if (editMode) {
        setEditingWord({ start: word.start, end: word.end });
        setEditValue(word.value);
      } else {
        onWordClick(word.start);
      }
    },
    [editMode, onWordClick]
  );

  const handleEditSave = React.useCallback(() => {
    if (editingWord && editValue.trim()) {
      const match = findCaptionWord(editingWord.start, editingWord.end);
      if (match) {
        dispatch(
          updateCaptionWord({
            captionId: match.captionId,
            wordIndex: match.wordIndex,
            newValue: editValue.trim(),
          })
        );
      }
    }
    setEditingWord(null);
    setEditValue("");
  }, [dispatch, editingWord, editValue, findCaptionWord]);

  const handleEditKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        handleEditSave();
      } else if (e.key === "Escape") {
        setEditingWord(null);
        setEditValue("");
      }
    },
    [handleEditSave]
  );

  // Memoize filtered transcription - only recompute when transcription, segments, or previewMode changes
  // NOT on every currentTime change (which happens 60fps)
  const filteredTranscription = React.useMemo(() => {
    if (!previewMode) return transcription;
    return transcription.filter((word) =>
      segments.some(
        (seg) => word.start >= seg.startTime && word.end <= seg.endTime,
      ),
    );
  }, [transcription, segments, previewMode]);

  // Memoize chunks - expensive operation that shouldn't run on every frame
  const chunks = React.useMemo(
    () => groupWordsIntoChunks(filteredTranscription),
    [filteredTranscription],
  );

  // Memoize total duration calculation
  const shownDuration = React.useMemo(
    () =>
      previewMode
        ? segments.reduce((sum, seg) => sum + (seg.endTime - seg.startTime), 0)
        : duration,
    [previewMode, segments, duration],
  );

  return (
    <div className="p-5 space-y-4 text-sm h-full overflow-y-auto">
      {/* Header */}
      <div className="flex justify-between items-center text-xs text-muted-foreground pb-3 border-b-2 border-border">
        <span className="font-bold uppercase tracking-wider">
          {previewMode ? "Preview Transcript" : "Full Transcript"}
        </span>
        <div className="flex items-center gap-3">
          {transcription.length > 0 && (
            <button
              onClick={() => setEditMode(!editMode)}
              className={cn(
                "flex items-center gap-1.5 px-2 py-1 rounded-md font-semibold transition-colors",
                editMode
                  ? "bg-blue-600 text-white"
                  : "hover:bg-muted"
              )}
            >
              <Pencil className="h-3 w-3" />
              {editMode ? "Done" : "Edit"}
            </button>
          )}
          <span className="flex items-center gap-1.5 font-semibold">
            <Clock className="h-3.5 w-3.5" />
            {formatTime(shownDuration)}
          </span>
        </div>
      </div>

      {previewMode && segments.length === 0 && (
        <div className="text-muted-foreground text-center py-10 text-sm font-medium">
          No segments selected. Add segments to see preview transcript.
        </div>
      )}

      {chunks.length > 0 ? (
        <div className="space-y-4">
          {chunks.map((chunk, chunkIdx) => {
            const isChunkActive =
              currentTime >= chunk.startTime && currentTime <= chunk.endTime;

            return (
              <div
                key={chunkIdx}
                className={cn(
                  "rounded-xl p-4 transition-all",
                  isChunkActive
                    ? "bg-blue-500/10 border-2 border-blue-500/30"
                    : "bg-muted/40 border-2 border-transparent hover:border-border",
                )}
              >
                {/* Timestamp badge */}
                <div className="flex items-center gap-2 mb-3">
                  <span
                    className={cn(
                      "text-[11px] font-mono font-bold px-2 py-1 rounded-md",
                      isChunkActive
                        ? "bg-blue-500/20 text-blue-400"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {formatTime(chunk.startTime)}
                  </span>
                  <div className="flex-1 h-px bg-border" />
                  <span
                    className={cn(
                      "text-[11px] font-mono font-bold px-2 py-1 rounded-md",
                      isChunkActive
                        ? "bg-blue-500/20 text-blue-400"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {formatTime(chunk.endTime)}
                  </span>
                </div>

                {/* Words */}
                <p className="leading-relaxed font-medium">
                  {chunk.words.map((word, idx) => {
                    const isActive =
                      currentTime >= word.start && currentTime <= word.end;
                    const isEditing =
                      editingWord &&
                      Math.abs(editingWord.start - word.start) < 0.01 &&
                      Math.abs(editingWord.end - word.end) < 0.01;

                    if (isEditing) {
                      return (
                        <span key={idx}>
                          <input
                            ref={editInputRef}
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={handleEditSave}
                            onKeyDown={handleEditKeyDown}
                            className="bg-blue-600 text-white border-none outline-none rounded px-1 font-medium"
                            style={{
                              width: `${Math.max(editValue.length, 1) + 1}ch`,
                              minWidth: "2ch",
                            }}
                          />{" "}
                        </span>
                      );
                    }

                    return (
                      <span
                        key={idx}
                        onClick={() => handleWordEdit(word)}
                        className={cn(
                          "cursor-pointer hover:bg-blue-500/20 rounded px-0.5 transition-all",
                          isActive && "bg-blue-600 text-white",
                          editMode && "hover:bg-yellow-500/30",
                        )}
                      >
                        {word.value}{" "}
                      </span>
                    );
                  })}
                </p>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-muted-foreground text-center py-12 font-medium">
          {loading ? "Loading transcript..." : "No transcript available."}
        </div>
      )}
    </div>
  );
}
