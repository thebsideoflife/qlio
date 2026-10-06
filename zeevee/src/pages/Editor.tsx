import React, { useCallback } from "react";
import {
  captionWordText,
  isDeletedCaptionWord,
} from "@/remotion/captionGrouping";
import { Timeline } from "@/components/editor/Timeline";
import { IQAgentPanel } from "@/components/editor/iq-agent/IQAgentPanel";
import { CaptionOverlay } from "@/components/editor/CaptionOverlay";
import { CaptionEditor } from "@/components/editor/CaptionEditor";
import { FramingSlider } from "@/components/editor/FramingSlider";
import { ZoomSlider } from "@/components/editor/ZoomSlider";
import {
  DEFAULT_SOURCE_ASPECT,
  MAX_DIGITAL_ZOOM,
  cssContainTransform,
} from "@/lib/zoomMath";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
  type TranscriptWord,
  setGlobalAspectRatio,
  setSquareTopEnabled,
  setAgentRunActive,
  setSourceFps,
  updateProjectTitle,
} from "@/store/editorSlice";
import { useParams } from "react-router-dom";
import { useRef, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useProjectData } from "@/hooks/useProjectData";
import { useSeamlessPlayback } from "@/hooks/useSeamlessPlayback";
import { useIQAgent } from "@/hooks/useIQAgent";
import { getProject, getProjectJobStatus } from "@/services/api";
import {
  FileText,
  Wand2,
  Captions,
  Clock,
  Pencil,
  PanelTop,
  Crosshair,
} from "lucide-react";
import { getEffectiveKeyframes } from "@/remotion/types";
import {
  frameIndex,
  frameToTime,
  resolveFramingAtTime,
} from "@/remotion/framingInterpolation";
import { resolveFramingAtSourceTime } from "@/remotion/segmentFrameBounds";
import { probeSourceFps } from "@/lib/sourceFps";
import type { AspectRatio } from "@/remotion/types";
import {
  groupWordsForTranscript,
  languageLabel,
} from "@/lib/transcript";

function platformToAspectRatio(platform: string): AspectRatio {
  if (platform === "tv") return "16:9";
  return "9:16";
}

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
  const transcriptionStatus = useSelector(
    (state: RootState) => state.editor.transcriptionStatus,
  );
  const sourceFps = useSelector((state: RootState) => state.editor.sourceFps);

  // Local State
  const videoRef = useRef<HTMLVideoElement>(null);
  const [activeTab, setActiveTab] = useState<"transcript" | "ai" | "captions">(
    "ai",
  );
  // Track the last projectId we initialized state for — used to reset state on project change
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [sourceAspect, setSourceAspect] = useState(DEFAULT_SOURCE_ASPECT);
  // Sidebar width/open state persisted in localStorage (UI chrome, not Redux),
  // matching existing conventions (api_password, zeevee:recentAssets).
  const SIDEBAR_STORAGE_KEY = "zeevee:editorSidebar";
  const SIDEBAR_DEFAULT_WIDTH = 420;
  const SIDEBAR_MIN_WIDTH = 320;
  const SIDEBAR_MAX_WIDTH = 720;
  // Dragging below this width snaps the panel shut
  const SIDEBAR_COLLAPSE_WIDTH = 200;

  const clampSidebarWidth = (width: number) =>
    Math.max(
      SIDEBAR_MIN_WIDTH,
      Math.min(SIDEBAR_MAX_WIDTH, width, window.innerWidth * 0.6),
    );

  const readSidebarState = (): { width: number; open: boolean } => {
    try {
      const raw = localStorage.getItem(SIDEBAR_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed?.width === "number" && typeof parsed?.open === "boolean") {
          return { width: clampSidebarWidth(parsed.width), open: parsed.open };
        }
      }
    } catch {
      // fall through to defaults on malformed storage
    }
    return { width: SIDEBAR_DEFAULT_WIDTH, open: true };
  };

  const [sidebarState, setSidebarState] = useState(readSidebarState);
  const sidebarOpen = sidebarState.open;
  const sidebarWidth = sidebarState.width;
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const setSidebarOpen = (open: boolean) =>
    setSidebarState((s) => ({ ...s, open }));

  // Persist on open/width settle (not every mousemove — write on drag end below)
  const persistSidebarState = (state: { width: number; open: boolean }) => {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // storage full/unavailable — non-fatal
    }
  };

  // Drag-to-resize via the sidebar's left edge, using the same window-level
  // mousemove/mouseup pattern as the framing drag below.
  const handleSidebarResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setSidebarResizing(true);
  };

  useEffect(() => {
    if (!sidebarResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Sidebar is flush right: width = distance from cursor to viewport right edge
      const width = window.innerWidth - e.clientX;
      if (width < SIDEBAR_COLLAPSE_WIDTH) {
        setSidebarState((s) => ({ ...s, open: false }));
      } else {
        setSidebarState({ width: clampSidebarWidth(width), open: true });
      }
    };

    const handleMouseUp = () => {
      setSidebarResizing(false);
      setSidebarState((s) => {
        persistSidebarState(s);
        return s;
      });
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
     
  }, [sidebarResizing]);

  // Persist open-state toggles (drag-end persistence handled above)
  useEffect(() => {
    persistSidebarState(sidebarState);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- persist is a stable helper
  }, [sidebarState.open]);
  const [autoFrameEnabled, setAutoFrameEnabled] = useState(true);

  // Refs — declared before render-time reset block so they can be accessed there
  const projectIdRef = useRef(projectId);
  useEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);

  // Reset async state when navigating to a different project (during render, avoids cascading effects)
  if (projectId !== activeProjectId) {
    setActiveProjectId(projectId ?? null);
    setPreviewMode(false);
    setSourceAspect(DEFAULT_SOURCE_ASPECT);
  }

  // Custom Hooks
  const { videoUrl, framingJob, loading } = useProjectData(projectId);
  const generationMetadata = useSelector(
    (state: RootState) => state.editor.generationMetadata,
  );

  // The agent owns the cut while it runs: it writes segments server-side and
  // the event stream pushes them here, so autosave has to stand down.
  const applyAgentSegments = useCallback(
    (next: Parameters<typeof setSegments>[0]) => {
      dispatch(setSegments(next));
    },
    [dispatch],
  );
  const applyAgentProjectTitle = useCallback(
    (title: string) => dispatch(updateProjectTitle(title)),
    [dispatch],
  );
  const agent = useIQAgent(projectId, applyAgentSegments, applyAgentProjectTitle);

  useEffect(() => {
    dispatch(setAgentRunActive(agent.isRunning));
  }, [agent.isRunning, dispatch]);

  // Once the agent produces a cut, drop into preview so the producer sees it.
  const previewedRunRef = useRef<string | null>(null);
  useEffect(() => {
    const runId = agent.run?.runId ?? agent.lastRun?.runId;
    if (!runId || segments.length === 0) return;
    if (previewedRunRef.current === runId) return;
    previewedRunRef.current = runId;
    setPreviewMode(true);
  }, [agent.run?.runId, agent.lastRun?.runId, segments.length]);

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

  const selectedKeyframe = React.useMemo(() => {
    if (!selectedSegment?.framing) return null;
    const kfs = getEffectiveKeyframes(selectedSegment.framing);
    if (selectedKeyframeId) {
      return kfs.find((kf) => kf.id === selectedKeyframeId) || kfs[0];
    }
    return kfs[0];
  }, [selectedSegment, selectedKeyframeId]);

  // Video follows playhead so a cut cannot flash keyframe 0 (default/fit).
  const playheadSeg =
    segments.find((s) => currentTime >= s.startTime && currentTime < s.endTime) ??
    selectedSegment;
  const playheadFraming = playheadSeg?.framing
    ? sourceFps != null && sourceFps > 0
      ? resolveFramingAtSourceTime(
          getEffectiveKeyframes(playheadSeg.framing),
          currentTime,
          playheadSeg.startTime,
          sourceFps,
        )
      : resolveFramingAtTime(
          getEffectiveKeyframes(playheadSeg.framing),
          Math.max(0, currentTime - playheadSeg.startTime),
          null,
        )
    : { zoom: previewZoom, focusX: previewFocus.x, focusY: previewFocus.y };
  const displayZoom = globalFraming.enabled ? playheadFraming.zoom : 0;
  const displayFocusX = playheadFraming.focusX;
  const displayFocusY = playheadFraming.focusY;
  // Sliders edit the selected keyframe. Until one is selected, follow the
  // playhead so a segment change cannot flash keyframe 0.
  const sliderFraming =
    selectedKeyframeId && selectedKeyframe
      ? {
          zoom: selectedKeyframe.zoom,
          focusX: selectedKeyframe.focusX,
          focusY: selectedKeyframe.focusY,
        }
      : playheadFraming;

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
  // Square-top portrait mode wipes out all other framing while on. Defaulted to
  // false for projects created before this feature (missing field on load).
  const squareTop = globalFraming.enabled && !!globalFraming.squareTop;
  const previewAspect = squareTop ? 9 / 16 : aspectRatioValue;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) return;
    setSourceAspect(video.videoWidth / video.videoHeight);
  }, [videoUrl]);

  useEffect(() => {
    if (!videoUrl) {
      dispatch(setSourceFps(null));
      return;
    }
    let cancelled = false;
    dispatch(setSourceFps(null));
    probeSourceFps(videoUrl)
      .then((fps) => {
        if (!cancelled) dispatch(setSourceFps(fps));
      })
      .catch(() => {
        if (!cancelled) dispatch(setSourceFps(null));
      });
    return () => {
      cancelled = true;
    };
  }, [videoUrl, dispatch]);

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

  // Resume framing poll if there's an in-progress framing job (e.g., after page refresh).
  // One resume per project — active reframes started in-session are polled by Timeline.
  const framingResumeProjectRef = useRef<string | null>(null);
  useEffect(() => {
    if (!projectId || !framingJob || loading) return;
    if (framingResumeProjectRef.current === projectId) return;
    if (framingJob.status !== "pending" && framingJob.status !== "analyzing")
      return;
    // The agent panel mirrors framing progress for runs it started.
    if (agent.framingActive) return;

    framingResumeProjectRef.current = projectId;
    const startingProjectId = projectId;
    let cancelled = false;

    (async () => {
      const POLL = 10000;
      const MAX = 30 * 60 * 1000;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- agent.framingActive is a guard, not a trigger
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

  // Sync playhead to the displayed video frame (rVFC). rVFC can stop firing
  // (e.g. playback started by keyboard before any click), so a RAF loop always
  // runs as a backstop. Both publish the same frame-snapped time.
  useEffect(() => {
    if (!videoUrl) return;

    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    let rafId = 0;
    let rvfcId = 0;
    let lastRvfcAt = 0;

    const publishTime = (seconds: number) => {
      if (cancelled || !Number.isFinite(seconds)) return;
      if (sourceFps != null && sourceFps > 0) {
        dispatch(setCurrentTime(frameToTime(frameIndex(seconds, sourceFps), sourceFps)));
        return;
      }
      dispatch(setCurrentTime(seconds));
    };

    const hasRvfc =
      typeof video.requestVideoFrameCallback === "function" &&
      typeof video.cancelVideoFrameCallback === "function";

    const onFrame: VideoFrameRequestCallback = (now, metadata) => {
      if (cancelled) return;
      // Re-arm first so a throw in publish can't end the loop.
      rvfcId = video.requestVideoFrameCallback(onFrame);
      lastRvfcAt = now;
      publishTime(metadata.mediaTime);
    };
    const armRvfc = () => {
      if (!hasRvfc || cancelled) return;
      video.cancelVideoFrameCallback(rvfcId);
      rvfcId = video.requestVideoFrameCallback(onFrame);
    };

    const tick = (now: number) => {
      if (cancelled) return;
      rafId = requestAnimationFrame(tick);
      // Defer to rVFC while it is delivering frames; otherwise read currentTime.
      const rvfcLive = hasRvfc && now - lastRvfcAt < 250;
      if (!rvfcLive && !isNaN(video.currentTime)) publishTime(video.currentTime);
    };

    armRvfc();
    rafId = requestAnimationFrame(tick);
    video.addEventListener("play", armRvfc);
    video.addEventListener("seeked", armRvfc);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      if (hasRvfc) video.cancelVideoFrameCallback(rvfcId);
      video.removeEventListener("play", armRvfc);
      video.removeEventListener("seeked", armRvfc);
    };
  }, [dispatch, videoUrl, sourceFps]);

  const handleWordClick = (startTime: number) => {
    const video = videoRef.current;
    if (!video) return;
    // Seek-only: assigning currentTime never changes the element's
    // playing/paused state, so word clicks must not touch play()/pause().
    // Paused videos stay paused on the word's frame; playing videos keep
    // playing from the new position.
    video.currentTime = startTime;
  };

  if (loading) {
    return (
      <div className="flex h-[calc(100vh-4rem)] min-h-0 overflow-hidden">
        {/* Left: Video & Timeline skeleton */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden bg-background border-r">
          <div className="flex-1 min-h-0 overflow-hidden bg-muted flex items-center justify-center">
            <Skeleton className="w-[80%] aspect-video" />
          </div>
          <div className="shrink-0 h-36 border-t bg-card p-2">
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

  const framingPreview = videoUrl ? (
    <div
              ref={framingContainerRef}
              className={cn(
                "relative shrink-0 overflow-hidden bg-black select-none",
                "rounded-2xl shadow-2xl shadow-black/50",
                squareTop
                  ? "cursor-default ring-2 ring-border"
                  : isDragging
                    ? "cursor-grabbing ring-4 ring-blue-500 ring-offset-4 ring-offset-background"
                    : displayZoom > 0
                      ? "cursor-grab ring-2 ring-border hover:ring-muted-foreground/50"
                      : "cursor-pointer ring-2 ring-border",
              )}
              style={{
                // Fit inside the stage on both axes so 16:9 (and 1:1) letterbox
                // instead of filling height and overflowing width.
                aspectRatio: previewAspect,
                width: `min(100cqw, calc(100cqh * ${previewAspect}))`,
                height: `min(100cqh, calc(100cqw / ${previewAspect}))`,
              }}
              onMouseDown={
                squareTop || displayZoom <= 0
                  ? undefined
                  : handleFramingMouseDown
              }
              onClick={
                squareTop || displayZoom <= 0
                  ? handleVideoClick
                  : handleFramingClick
              }
            >
              <video
                ref={videoRef}
                src={videoUrl}
                className="pointer-events-none"
                style={(() => {
                  // Square-top: render the video as a 1:1 square crop aligned to
                  // the top of the portrait frame (black below). The square fills
                  // the full width; its height (9/16 of the frame) equals the width.
                  if (squareTop) {
                    return {
                      position: "absolute" as const,
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: "56.25%", // 1080/1920 → square at full width, top-anchored
                      objectFit: "cover" as const,
                      objectPosition: "center center",
                    };
                  }
                  const { scale, translateX, translateY } = cssContainTransform(
                    displayZoom,
                    aspectRatioValue,
                    sourceAspect,
                    displayFocusX,
                    displayFocusY,
                  );
                  return {
                    width: "100%",
                    height: "100%",
                    objectFit: "contain" as const,
                    transformOrigin: "center center",
                    transform: `translate(${translateX}%, ${translateY}%) scale(${scale})`,
                  };
                })()}
                onLoadedMetadata={(e) => {
                  const video = e.currentTarget;
                  dispatch(setDuration(video.duration));
                  if (video.videoWidth > 0 && video.videoHeight > 0) {
                    setSourceAspect(video.videoWidth / video.videoHeight);
                  }
                }}
              />

              {!squareTop && displayZoom > 0 && !isDragging && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 hover:opacity-100 transition-opacity pointer-events-none">
                  <span className="text-white text-sm font-medium px-3 py-1.5 bg-black/70 rounded-full backdrop-blur-sm">
                    Drag to reposition
                  </span>
                </div>
              )}

              {!squareTop && displayZoom > 0 && (
                <>
                  {globalFraming.aspectRatio === "16:9" && (
                    <>
                      <FramingSlider
                        orientation="vertical"
                        value={sliderFraming.focusY}
                        aspectRatio={1 / MAX_DIGITAL_ZOOM}
                        onChange={(y) => updateFramingValue({ focusY: y })}
                      />
                      <FramingSlider
                        orientation="horizontal"
                        value={sliderFraming.focusX}
                        aspectRatio={1 / MAX_DIGITAL_ZOOM}
                        onChange={(x) => updateFramingValue({ focusX: x })}
                      />
                    </>
                  )}
                  {(globalFraming.aspectRatio === "9:16" ||
                    globalFraming.aspectRatio === "1:1") && (
                    <FramingSlider
                      orientation="horizontal"
                      value={sliderFraming.focusX}
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

              <CaptionOverlay
                currentTime={currentTime}
                segmentStart={previewMode ? playheadSeg?.startTime : undefined}
              />
    </div>
  ) : null;

  return (
    <div className="flex h-[calc(100vh-4rem)] min-h-0 overflow-hidden">
      {/* Left: Video & Timeline */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden bg-background">
        {/* Video Player with Caption Overlay */}
        <div
          className="flex-1 min-h-0 bg-muted"
          onClick={handleBackgroundClick}
        >
          <div className="flex h-full min-h-0 items-stretch justify-center gap-2 p-4">
            {/* Matches the zoom column so the frame stays optically centered. */}
            <div className="w-[4.5rem] shrink-0" aria-hidden />

            <div
              className="flex min-h-0 min-w-0 flex-1 items-center justify-center"
              style={{ containerType: "size" }}
            >
              {framingPreview ? (
                framingPreview
              ) : (
                <div className="text-muted-foreground font-medium">
                  Loading Video...
                </div>
              )}
            </div>

            <div
              className="flex h-full w-[4.5rem] shrink-0 flex-col items-stretch justify-center gap-1.5"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="Square Top"
                    aria-pressed={squareTop}
                    onClick={() => dispatch(setSquareTopEnabled(!squareTop))}
                    className={cn(
                      "flex h-8 shrink-0 items-center justify-center rounded-full",
                      "border border-zinc-600/70 bg-zinc-900/80 shadow-md backdrop-blur-md",
                      "text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200",
                      squareTop &&
                        "border-blue-400/50 bg-blue-500/15 text-blue-400 hover:text-blue-300",
                    )}
                  >
                    <PanelTop className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">
                  {squareTop
                    ? "Square Top on — click to restore framing"
                    : "Square Top portrait mode"}
                </TooltipContent>
              </Tooltip>
              <div className="h-72 min-h-0 max-h-[calc(100%-2.5rem)] rounded-2xl border border-zinc-600/70 bg-zinc-900/80 px-1 py-2.5 shadow-md backdrop-blur-md">
                <ZoomSlider
                  value={sliderFraming.zoom}
                  canvasAspect={aspectRatioValue}
                  sourceAspect={sourceAspect}
                  disabled={squareTop}
                  onChange={(zoom) => updateFramingValue({ zoom })}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Timeline */}
        <div className="shrink-0 border-t border-border bg-card">
          <Timeline
            videoRef={videoRef}
            previewMode={previewMode}
            onPreviewModeChange={setPreviewMode}
            fps={sourceFps}
          />
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

        {/* Drag-to-resize handle on the sidebar's left edge */}
        {sidebarOpen && (
          <div
            onMouseDown={handleSidebarResizeStart}
            className={cn(
              "absolute left-0 top-0 bottom-0 w-2 -translate-x-1/2 z-10 cursor-col-resize",
              "hover:bg-blue-500/30",
              sidebarResizing && "bg-blue-500/40",
            )}
            title="Drag to resize panel"
          />
        )}

        <div
          className={cn(
            "flex flex-col bg-card border-l-2 border-border overflow-hidden",
            // Suppress width transition while dragging so the panel tracks the cursor
            !sidebarResizing && "transition-all duration-200",
          )}
          style={{ width: sidebarOpen ? sidebarWidth : 0 }}
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
                    tooltip: "IQ Studio - Generate segments with AI",
                  },
                  {
                    id: "captions" as const,
                    icon: Captions,
                    label: "Captions",
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
                    <span className="flex items-center gap-1.5">
                      {tab.label}
                      {tab.id === "transcript" &&
                        transcriptionStatus === "pending" && (
                          <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
                        )}
                    </span>
                  </button>
                ))}
              </div>

              <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                {activeTab === "ai" && projectId && (
                  <IQAgentPanel
                    key={projectId}
                    projectId={projectId}
                    agent={agent}
                    savedInputs={generationMetadata}
                    autoFrameEnabled={autoFrameEnabled}
                    onAutoFrameChange={setAutoFrameEnabled}
                    targetAspectRatio={globalFraming.aspectRatio}
                    onPlatformChange={(platform) => {
                      const next = platformToAspectRatio(platform);
                      if (next === globalFraming.aspectRatio) return;
                      dispatch(setGlobalAspectRatio(next));
                    }}
                  />
                )}
                {activeTab === "captions" && (
                  <div className="flex-1 min-h-0 overflow-y-auto">
                    <CaptionEditor />
                  </div>
                )}
                {activeTab === "transcript" && (
                  <div className="flex-1 min-h-0 overflow-y-auto">
                    <TranscriptPanel
                      segments={segments}
                      currentTime={currentTime}
                      duration={duration}
                      previewMode={previewMode}
                      onWordClick={handleWordClick}
                      loading={loading}
                    />
                  </div>
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

function TranscriptSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Transcribing audio">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="rounded-xl p-4 bg-muted/40 border-2 border-transparent"
        >
          <div className="flex items-center gap-2 mb-3">
            <Skeleton className="h-6 w-12 rounded-md" />
            <div className="flex-1 h-px bg-border" />
            <Skeleton className="h-6 w-12 rounded-md" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-[88%]" />
            <Skeleton className={`h-4 ${i % 2 === 0 ? "w-2/3" : "w-3/4"}`} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Start / end of the word being edited, in seconds, with "set to playhead". */
function WordTimingBar({
  word,
  currentTime,
  onChange,
}: {
  word: TranscriptWord;
  currentTime: number;
  onChange: (timing: { start?: number; end?: number }) => void;
}) {
  const field = (label: string, name: "start" | "end") => (
    <label className="flex items-center gap-1">
      <span className="font-semibold">{label}</span>
      <input
        // Remount when the saved value changes so the field shows it.
        key={`${word.key}-${word[name]}`}
        type="number"
        step={0.01}
        min={0}
        defaultValue={word[name].toFixed(2)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        onBlur={(e) => {
          const seconds = Number(e.target.value);
          if (Math.abs(seconds - word[name]) >= 0.005) onChange({ [name]: seconds });
        }}
        className="w-20 rounded border border-border bg-background px-1.5 py-0.5 font-mono"
      />
      <button
        type="button"
        title={`Set ${name} to the playhead`}
        // Keep focus (and the selected word) where it is.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onChange({ [name]: Number(currentTime.toFixed(2)) })}
        className="rounded p-1 hover:bg-muted"
      >
        <Crosshair className="h-3 w-3" />
      </button>
    </label>
  );

  return (
    <div className="mt-2 flex flex-wrap items-center gap-3 rounded-md bg-muted/60 px-2 py-1.5 text-[11px]">
      <span className="max-w-[8rem] truncate font-semibold">
        “{captionWordText(word.value) || "[deleted]"}”
      </span>
      {field("Start", "start")}
      {field("End", "end")}
    </div>
  );
}

interface TranscriptPanelProps {
  segments: Array<{ id: string; startTime: number; endTime: number }>;
  currentTime: number;
  duration: number;
  previewMode: boolean;
  onWordClick: (startTime: number) => void;
  loading: boolean;
}

function TranscriptPanel({
  segments,
  currentTime,
  duration,
  previewMode,
  onWordClick,
  loading,
}: TranscriptPanelProps) {
  const dispatch = useDispatch();
  // Use transcriptWords from Redux (includes edits) instead of prop
  const transcription = useSelector((state: RootState) => state.editor.transcriptWords);
  const originalLanguage = useSelector(
    (state: RootState) => state.editor.originalLanguage,
  );
  const transcriptionStatus = useSelector(
    (state: RootState) => state.editor.transcriptionStatus,
  );
  const transcribing = transcriptionStatus === "pending";

  // Edit mode state
  const [editMode, setEditMode] = React.useState(false);
  // The word whose timing the edit bar shows (its word-edit key).
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const selectedWord = React.useMemo(
    () => (editMode && selectedKey ? transcription.find((w) => w.key === selectedKey) ?? null : null),
    [editMode, selectedKey, transcription],
  );

  // Handle word click - either seek or edit
  const handleWordClick = React.useCallback(
    (word: { start: number; end: number; value: string }) => {
      if (editMode) {
        // Edit mode - do nothing on click, contentEditable handles it
      } else {
        onWordClick(word.start);
      }
    },
    [editMode, onWordClick]
  );

  // Save edited word on blur.
  const handleWordBlur = React.useCallback(
    (word: TranscriptWord, newValue: string) => {
      dispatch(
        updateCaptionWord({
          key: word.key,
          value: captionWordText(newValue),
        }),
      );
    },
    [dispatch],
  );

  const setSelectedTiming = React.useCallback(
    (timing: { start?: number; end?: number }) => {
      if (!selectedWord) return;
      dispatch(updateCaptionWord({ key: selectedWord.key, ...timing }));
    },
    [dispatch, selectedWord],
  );

  // Handle keydown in contentEditable
  const handleWordKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLSpanElement>, word: { start: number; end: number; value: string }) => {
      // Stop propagation for all keys to prevent timeline shortcuts from interfering
      e.stopPropagation();
      
      if (e.key === "Enter") {
        e.preventDefault();
        (e.target as HTMLElement).blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        // Restore original value
        (e.target as HTMLElement).textContent = captionWordText(word.value);
        (e.target as HTMLElement).blur();
      }
      // Arrow keys, backspace, delete, etc. will work normally since we stopped propagation
    },
    []
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

  // Display grouping never changes the short caption lines used by video/export.
  const wordCards = React.useMemo(
    () => groupWordsForTranscript(filteredTranscription),
    [filteredTranscription],
  );
  const hasTranscript = wordCards.length > 0;

  // Memoize total duration calculation
  const shownDuration = React.useMemo(
    () =>
      previewMode
        ? segments.reduce((sum, seg) => sum + (seg.endTime - seg.startTime), 0)
        : duration,
    [previewMode, segments, duration],
  );

  return (
    <div className="text-sm h-full flex flex-col">
      {/* Sticky Header */}
      <div className="sticky top-0 z-10 bg-background px-5 pt-5 pb-3 border-b-2 border-border">
        <div className="flex justify-between items-center text-xs text-muted-foreground">
          <span className="font-bold uppercase tracking-wider">
            {transcribing
              ? "Transcribing…"
              : previewMode
                ? "Preview Transcript"
                : "Full Transcript"}
            {originalLanguage ? ` · ${languageLabel(originalLanguage)}` : ""}
          </span>
          <div className="flex items-center gap-3">
            {transcription.length > 0 && (
              <button
                onClick={() => {
                  setEditMode(!editMode);
                  setSelectedKey(null);
                }}
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
        {editMode && (
          <div className="text-[11px] text-muted-foreground">
            Click a word to edit it. <kbd className="font-mono">Enter</kbd> saves.
            Clearing a word deletes it. Type extra words into a word to add missing ones.
          </div>
        )}
        {selectedWord && (
          <WordTimingBar
            word={selectedWord}
            currentTime={currentTime}
            onChange={setSelectedTiming}
          />
        )}
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {previewMode && segments.length === 0 && (
        <div className="text-muted-foreground text-center py-10 text-sm font-medium">
          No segments selected. Add segments to see preview transcript.
        </div>
      )}

      {hasTranscript ? (
        <div className="space-y-4">
          {wordCards.map((chunk, chunkIdx) => {
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
                        ? "bg-blue-500/15 text-blue-700 dark:text-blue-400"
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
                        ? "bg-blue-500/15 text-blue-700 dark:text-blue-400"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {formatTime(chunk.endTime)}
                  </span>
                </div>

                {/* Words */}
                <p className="leading-relaxed font-medium">
                  {chunk.words.map((word, wordIdx) => {
                    const isActive =
                      currentTime >= word.start && currentTime <= word.end;
                    const isEmpty = isDeletedCaptionWord(word.value);

                    // Skip rendering empty words entirely (they were deleted)
                    if (isEmpty && !editMode) {
                      return null;
                    }

                    return (
                      <span
                        key={`${word.key}-${wordIdx}`}
                        onClick={() => !editMode && handleWordClick(word)}
                        onFocus={() => {
                          if (!editMode) return;
                          setSelectedKey(word.key);
                          onWordClick(word.start);
                        }}
                        onBlur={(e) => {
                          if (!editMode) return;
                          const target = e.target as HTMLElement;
                          const newVal = target.textContent || "";
                          // Always save, even if empty (deletion) or same value
                          handleWordBlur(word, newVal);
                        }}
                        onKeyDown={editMode ? (e) => handleWordKeyDown(e, word) : undefined}
                        contentEditable={editMode}
                        suppressContentEditableWarning
                        className={cn(
                          "rounded px-0.5 outline-none",
                          !editMode && "cursor-pointer hover:bg-blue-500/20",
                          !editMode && isActive && "bg-blue-600 text-white",
                          editMode && "cursor-text border-b border-dashed border-blue-400 focus:border-solid focus:border-blue-500 focus:bg-blue-500/10",
                          isEmpty && "text-muted-foreground opacity-50",
                        )}
                      >
                        {isEmpty ? "[deleted]" : captionWordText(word.value)}
                      </span>
                    );
                  }).reduce<React.ReactNode[]>((acc, node) => {
                    // Add space between words
                    if (node) {
                      if (acc.length > 0) acc.push(" ");
                      acc.push(node);
                    }
                    return acc;
                  }, [])}
                </p>
              </div>
            );
          })}
        </div>
      ) : loading || transcribing ? (
        <TranscriptSkeleton />
      ) : (
        <div className="text-muted-foreground text-center py-12 font-medium">
          No transcript available.
        </div>
      )}
      </div>
    </div>
  );
}
