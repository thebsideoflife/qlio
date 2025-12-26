import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { useSelector, useDispatch } from "react-redux";
import type { RootState } from "@/store/store";
import {
  selectSegment,
  updateSegmentTime,
  finalizeSegmentEdit,
  splitSegment,
  addSegment,
  deleteSegment,
  setCurrentTime,
} from "@/store/editorSlice";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Scissors,
  Plus,
  Trash2,
  ZoomIn,
  ZoomOut,
  Eye,
  EyeOff,
  Play,
  Pause,
} from "lucide-react";

interface TimelineProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  previewMode: boolean;
  onPreviewModeChange: (preview: boolean) => void;
}

type DragMode = "playhead" | "left" | "right" | null;

interface DragState {
  mode: DragMode;
  segmentId: string | null;
  startX: number;
  initialStart: number;
  initialEnd: number;
  scrollLeft: number;
}

// Zoom: 1 = fit to container, higher = zoomed in
const MIN_ZOOM = 1;
const MAX_ZOOM = 20;
const DEFAULT_ZOOM = 1;

export function Timeline({
  videoRef,
  previewMode,
  onPreviewModeChange,
}: TimelineProps) {
  const dispatch = useDispatch();
  const segments = useSelector((state: RootState) => state.editor.segments);
  const selectedId = useSelector(
    (state: RootState) => state.editor.selectedSegmentId
  );
  const currentTime = useSelector(
    (state: RootState) => state.editor.currentTime
  );
  const duration = useSelector((state: RootState) => state.editor.duration);

  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [containerWidth, setContainerWidth] = useState(800);
  const [isPlaying, setIsPlaying] = useState(false);

  // Track pinch/gesture state with refs to avoid stale closures
  const pinchStateRef = useRef<{
    initialDistance: number | null;
    initialZoom: number;
    centerX: number;
    scrollLeft: number;
  }>({
    initialDistance: null,
    initialZoom: zoom,
    centerX: 0,
    scrollLeft: 0,
  });

  const gestureStateRef = useRef<{
    isGesturing: boolean;
    initialZoom: number;
    centerX: number;
    scrollLeft: number;
  }>({
    isGesturing: false,
    initialZoom: zoom,
    centerX: 0,
    scrollLeft: 0,
  });

  // Use real duration, or fallback to 10 mins if 0
  const totalDuration = duration > 0 ? duration : 600;

  // Preview mode calculations
  const sortedSegments = useMemo(
    () => [...segments].sort((a, b) => a.startTime - b.startTime),
    [segments]
  );

  const { previewDuration, segmentPreviewOffsets } = useMemo(() => {
    const offsets = new Map<string, number>();
    let offset = 0;

    for (const seg of sortedSegments) {
      offsets.set(seg.id, offset);
      offset += seg.endTime - seg.startTime;
    }

    return { previewDuration: offset, segmentPreviewOffsets: offsets };
  }, [sortedSegments]);

  // Convert real time to preview time (for playhead position in preview mode)
  const realTimeToPreviewTime = useCallback(
    (realTime: number): number => {
      let previewTime = 0;

      for (const seg of sortedSegments) {
        if (realTime >= seg.startTime && realTime < seg.endTime) {
          return previewTime + (realTime - seg.startTime);
        }
        if (realTime >= seg.endTime) {
          previewTime += seg.endTime - seg.startTime;
        }
      }

      return previewTime;
    },
    [sortedSegments]
  );

  // Convert preview time to real time (for seeking in preview mode)
  const previewTimeToRealTime = useCallback(
    (previewTime: number): number => {
      let accumulated = 0;

      for (const seg of sortedSegments) {
        const segDuration = seg.endTime - seg.startTime;
        if (previewTime < accumulated + segDuration) {
          const offsetIntoSegment = previewTime - accumulated;
          return seg.startTime + offsetIntoSegment;
        }
        accumulated += segDuration;
      }

      // Past end - return last segment end
      return sortedSegments[sortedSegments.length - 1]?.endTime || 0;
    },
    [sortedSegments]
  );

  // Effective duration based on mode
  const effectiveDuration = previewMode ? previewDuration : totalDuration;
  // Effective current time for display
  const effectiveCurrentTime = previewMode
    ? realTimeToPreviewTime(currentTime)
    : currentTime;

  // Measure container width
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const updateWidth = () => {
      setContainerWidth(container.clientWidth);
    };

    updateWidth();
    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(container);

    return () => resizeObserver.disconnect();
  }, []);

  // At zoom=1, track fits exactly in container. Higher zoom = wider track.
  const trackWidth = containerWidth * zoom;

  // Pixels per second based on zoom and container (use effective duration for preview mode)
  const pixelsPerSecond =
    effectiveDuration > 0 ? trackWidth / effectiveDuration : trackWidth / 600;

  // Convert time to pixels
  const timeToPx = useCallback(
    (time: number) => time * pixelsPerSecond,
    [pixelsPerSecond]
  );

  // Convert pixels to time
  const pxToTime = useCallback(
    (px: number) => px / pixelsPerSecond,
    [pixelsPerSecond]
  );

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // Clamp time within valid range
  const clampTime = useCallback(
    (time: number, min = 0, max = totalDuration) =>
      Math.max(min, Math.min(max, time)),
    [totalDuration]
  );

  // Check if playhead is inside any segment - memoized to avoid recalculating on every render
  const isInsideSegment = useMemo(() => {
    return segments.some(
      (s) => currentTime >= s.startTime && currentTime < s.endTime
    );
  }, [segments, currentTime]);

  // Snap time to nearest segment edge if within threshold (in edit mode only)
  const SNAP_THRESHOLD_PX = 10; // pixels
  const snapToSegmentEdge = useCallback(
    (time: number): number => {
      if (previewMode) return time;

      const snapThresholdTime = pxToTime(SNAP_THRESHOLD_PX);
      let closestEdge = time;
      let closestDistance = Infinity;

      for (const seg of segments) {
        // Check start edge
        const startDist = Math.abs(time - seg.startTime);
        if (startDist < snapThresholdTime && startDist < closestDistance) {
          closestDistance = startDist;
          closestEdge = seg.startTime;
        }

        // Check end edge
        const endDist = Math.abs(time - seg.endTime);
        if (endDist < snapThresholdTime && endDist < closestDistance) {
          closestDistance = endDist;
          closestEdge = seg.endTime;
        }
      }

      return closestEdge;
    },
    [segments, pxToTime, previewMode]
  );

  // Sync playing state with video
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);

    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    setIsPlaying(!video.paused);

    return () => {
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
    };
  }, [videoRef]);

  // Frame step amount: 1/30th second ≈ 33.33ms (works well for 24/25/30fps content)
  const FRAME_STEP = 1 / 30;

  // Keyboard shortcuts (Space for play/pause, Delete for delete segment, Arrow keys for frame stepping)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      if (e.code === "Space") {
        e.preventDefault();
        const video = videoRef.current;
        if (video) {
          if (video.paused) {
            const playPromise = video.play();
            if (playPromise !== undefined) {
              playPromise.catch((error) => {
                // Ignore AbortError - it's expected when user rapidly interacts
                if (error.name !== "AbortError") {
                  console.error("Playback error:", error);
                }
              });
            }
          } else {
            video.pause();
          }
        }
      } else if (e.code === "Delete" || e.code === "Backspace") {
        if (selectedId) {
          e.preventDefault();
          dispatch(deleteSegment(selectedId));
        }
      } else if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
        e.preventDefault();
        const video = videoRef.current;
        if (video) {
          // Pause video when frame stepping
          if (!video.paused) {
            video.pause();
          }

          const direction = e.code === "ArrowLeft" ? -1 : 1;
          // Shift + Arrow = 10 frames, just Arrow = 1 frame
          const multiplier = e.shiftKey ? 10 : 1;
          const delta = direction * FRAME_STEP * multiplier;

          const newTime = clampTime(currentTime + delta);
          video.currentTime = newTime;
          dispatch(setCurrentTime(newTime));
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [videoRef, selectedId, dispatch, currentTime, clampTime]);

  // Auto-scroll to keep playhead visible when playing
  useEffect(() => {
    if (!scrollRef.current || !isPlaying) return;

    const scrollContainer = scrollRef.current;
    const playheadPx = timeToPx(effectiveCurrentTime);
    const containerWidth = scrollContainer.clientWidth;
    const scrollLeft = scrollContainer.scrollLeft;

    // If playhead is outside visible area, scroll
    const buffer = containerWidth * 0.2;
    if (playheadPx < scrollLeft + buffer) {
      scrollContainer.scrollLeft = Math.max(0, playheadPx - buffer);
    } else if (playheadPx > scrollLeft + containerWidth - buffer) {
      scrollContainer.scrollLeft = playheadPx - containerWidth + buffer;
    }
  }, [effectiveCurrentTime, isPlaying, timeToPx]);

  // Auto-select the segment containing the playhead
  useEffect(() => {
    const containingSegment = segments.find(
      (s) => currentTime >= s.startTime && currentTime < s.endTime
    );

    const newSelectedId = containingSegment?.id || null;
    if (newSelectedId !== selectedId) {
      dispatch(selectSegment(newSelectedId));
    }
  }, [currentTime, segments, selectedId, dispatch]);

  // Handle playhead drag start
  const handlePlayheadMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDragState({
      mode: "playhead",
      segmentId: null,
      startX: e.clientX,
      initialStart: currentTime,
      initialEnd: 0,
      scrollLeft: scrollRef.current?.scrollLeft || 0,
    });
  };

  // Handle segment resize start (disabled in preview mode)
  const handleResizeMouseDown = (
    e: React.MouseEvent,
    segmentId: string,
    mode: "left" | "right"
  ) => {
    if (previewMode) return; // No resizing in preview mode

    e.stopPropagation();
    const segment = segments.find((s) => s.id === segmentId);
    if (!segment) return;

    dispatch(selectSegment(segmentId));

    setDragState({
      mode,
      segmentId,
      startX: e.clientX,
      initialStart: segment.startTime,
      initialEnd: segment.endTime,
      scrollLeft: scrollRef.current?.scrollLeft || 0,
    });
  };

  // Convert click position to time - handles scroll offset correctly
  const getTimeFromClickEvent = useCallback(
    (e: React.MouseEvent) => {
      const scrollContainer = scrollRef.current;
      if (!scrollContainer) return 0;

      // Get the scroll container's viewport position
      const scrollRect = scrollContainer.getBoundingClientRect();
      // Click position relative to scroll container's visible area
      const clickXInViewport = e.clientX - scrollRect.left;
      // Add scroll offset to get position in the full track
      const clickXInTrack = clickXInViewport + scrollContainer.scrollLeft;
      // Convert to time (this gives us preview time in preview mode)
      const clickTime = pxToTime(clickXInTrack);

      // In preview mode, convert preview time to real time
      if (previewMode) {
        return previewTimeToRealTime(
          Math.max(0, Math.min(previewDuration, clickTime))
        );
      }

      return clampTime(clickTime);
    },
    [clampTime, pxToTime, previewMode, previewTimeToRealTime, previewDuration]
  );

  // Handle segment click - select AND seek to click position
  const handleSegmentClick = (e: React.MouseEvent, segmentId: string) => {
    e.stopPropagation();
    dispatch(selectSegment(segmentId));

    const time = getTimeFromClickEvent(e);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
    dispatch(setCurrentTime(time));
  };

  // Handle track click to seek
  const handleTrackClick = (e: React.MouseEvent) => {
    if (dragState) return;

    const time = getTimeFromClickEvent(e);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
    dispatch(setCurrentTime(time));

    // Deselect segment when clicking on empty track
    dispatch(selectSegment(null));
  };

  // Mouse move handler for dragging
  useEffect(() => {
    if (!dragState) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - dragState.startX;
      const deltaTime = pxToTime(deltaX);

      if (dragState.mode === "playhead") {
        const rawTime = clampTime(dragState.initialStart + deltaTime);
        // Snap playhead to segment edges in edit mode
        const newTime = snapToSegmentEdge(rawTime);
        if (videoRef.current) {
          videoRef.current.currentTime = newTime;
        }
        dispatch(setCurrentTime(newTime));
      } else if (dragState.mode === "left" && dragState.segmentId) {
        const newStart = clampTime(
          dragState.initialStart + deltaTime,
          0,
          dragState.initialEnd - 0.1
        );
        dispatch(
          updateSegmentTime({
            id: dragState.segmentId,
            start: newStart,
            end: dragState.initialEnd,
          })
        );
      } else if (dragState.mode === "right" && dragState.segmentId) {
        const newEnd = clampTime(
          dragState.initialEnd + deltaTime,
          dragState.initialStart + 0.1,
          totalDuration
        );
        dispatch(
          updateSegmentTime({
            id: dragState.segmentId,
            start: dragState.initialStart,
            end: newEnd,
          })
        );
      }
    };

    const handleMouseUp = () => {
      // If we were resizing a segment, finalize (merge overlapping segments)
      if (dragState.mode === "left" || dragState.mode === "right") {
        dispatch(finalizeSegmentEdit());
      }
      setDragState(null);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [
    dragState,
    pxToTime,
    clampTime,
    totalDuration,
    videoRef,
    dispatch,
    snapToSegmentEdge,
  ]);

  // Toolbar handlers
  const handleSplit = () => {
    if (!selectedId) return;
    const segment = segments.find((s) => s.id === selectedId);
    if (!segment) return;

    if (currentTime > segment.startTime && currentTime < segment.endTime) {
      dispatch(splitSegment({ id: selectedId, atTime: currentTime }));
    }
  };

  const handleAdd = () => {
    dispatch(addSegment({ atTime: currentTime }));
  };

  const handleDelete = () => {
    if (selectedId) {
      dispatch(deleteSegment(selectedId));
    }
  };

  // Button zoom - bigger steps (50% change)
  const handleZoomIn = () => {
    setZoom((z) => Math.min(z * 1.5, MAX_ZOOM));
  };

  const handleZoomOut = () => {
    setZoom((z) => Math.max(z / 1.5, MIN_ZOOM));
  };

  // Touch-based pinch zoom (mobile)
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;

        const scrollContainer = scrollRef.current;
        if (scrollContainer) {
          const rect = scrollContainer.getBoundingClientRect();
          const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2;

          pinchStateRef.current = {
            initialDistance: Math.hypot(dx, dy),
            initialZoom: zoom,
            centerX: centerX - rect.left,
            scrollLeft: scrollContainer.scrollLeft,
          };
        }
      }
    },
    [zoom]
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (
        e.touches.length === 2 &&
        pinchStateRef.current.initialDistance !== null
      ) {
        e.preventDefault();

        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const currentDistance = Math.hypot(dx, dy);

        const scale = currentDistance / pinchStateRef.current.initialDistance;
        const newZoom = Math.max(
          MIN_ZOOM,
          Math.min(MAX_ZOOM, pinchStateRef.current.initialZoom * scale)
        );

        // Zoom toward pinch center
        const scrollContainer = scrollRef.current;
        if (scrollContainer) {
          const oldPps =
            (containerWidth * pinchStateRef.current.initialZoom) /
            effectiveDuration;
          const newPps = (containerWidth * newZoom) / effectiveDuration;

          const centerPxInTrack =
            pinchStateRef.current.centerX + pinchStateRef.current.scrollLeft;
          const timeAtCenter = centerPxInTrack / oldPps;
          const newCenterPx = timeAtCenter * newPps;
          const newScrollLeft = newCenterPx - pinchStateRef.current.centerX;

          scrollContainer.scrollLeft = Math.max(0, newScrollLeft);
        }

        setZoom(newZoom);
      }
    },
    [containerWidth, effectiveDuration]
  );

  const handleTouchEnd = useCallback(() => {
    pinchStateRef.current.initialDistance = null;
  }, []);

  // Wheel event handler - must use native listener with passive:false to prevent default
  // React synthetic events can't prevent default on passive listeners
  useEffect(() => {
    const scrollContainer = scrollRef.current;
    if (!scrollContainer) return;

    const handleWheel = (e: WheelEvent) => {
      // Skip if Safari gesture is in progress
      if (gestureStateRef.current.isGesturing) return;

      // Ctrl/Cmd + wheel = zoom (also handles trackpad pinch on Chrome/Firefox/Edge)
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();

        const rect = scrollContainer.getBoundingClientRect();
        const cursorX = e.clientX - rect.left;
        const scrollLeft = scrollContainer.scrollLeft;

        const cursorPxInTrack = cursorX + scrollLeft;
        const timeAtCursor = cursorPxInTrack / pixelsPerSecond;

        const zoomDelta = -e.deltaY * 0.01;
        const newZoom = Math.max(
          MIN_ZOOM,
          Math.min(MAX_ZOOM, zoom * (1 + zoomDelta))
        );

        const newPixelsPerSecond =
          (containerWidth * newZoom) / effectiveDuration;
        const newCursorPxInTrack = timeAtCursor * newPixelsPerSecond;
        const newScrollLeft = newCursorPxInTrack - cursorX;

        setZoom(newZoom);
        requestAnimationFrame(() => {
          scrollContainer.scrollLeft = Math.max(0, newScrollLeft);
        });
      } else {
        // Plain wheel = horizontal scroll
        e.preventDefault();

        if (e.deltaX !== 0) {
          scrollContainer.scrollLeft += e.deltaX;
        } else if (e.deltaY !== 0) {
          scrollContainer.scrollLeft += e.deltaY;
        }
      }
    };

    // MUST use passive:false to allow preventDefault
    scrollContainer.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      scrollContainer.removeEventListener("wheel", handleWheel);
    };
  }, [zoom, pixelsPerSecond, containerWidth, effectiveDuration]);

  // Safari gesture events (only needs useEffect for non-React events)
  useEffect(() => {
    const container = containerRef.current;
    const scrollContainer = scrollRef.current;
    if (!container || !scrollContainer) return;

    const handleGestureStart = (e: Event) => {
      e.preventDefault();
      gestureStateRef.current = {
        isGesturing: true,
        initialZoom: zoom,
        centerX: scrollContainer.clientWidth / 2,
        scrollLeft: scrollContainer.scrollLeft,
      };
    };

    const handleGestureChange = (e: Event) => {
      e.preventDefault();
      const gestureEvent = e as unknown as { scale: number };
      const newZoom = Math.max(
        MIN_ZOOM,
        Math.min(
          MAX_ZOOM,
          gestureStateRef.current.initialZoom * gestureEvent.scale
        )
      );

      const oldPps =
        (containerWidth * gestureStateRef.current.initialZoom) /
        effectiveDuration;
      const newPps = (containerWidth * newZoom) / effectiveDuration;

      const centerPxInTrack =
        gestureStateRef.current.centerX + gestureStateRef.current.scrollLeft;
      const timeAtCenter = centerPxInTrack / oldPps;
      const newCenterPx = timeAtCenter * newPps;
      const newScrollLeft = newCenterPx - gestureStateRef.current.centerX;

      scrollContainer.scrollLeft = Math.max(0, newScrollLeft);
      setZoom(newZoom);
    };

    const handleGestureEnd = (e: Event) => {
      e.preventDefault();
      gestureStateRef.current.isGesturing = false;
    };

    // Safari gesture events don't have React equivalents
    container.addEventListener("gesturestart", handleGestureStart, {
      passive: false,
    });
    container.addEventListener("gesturechange", handleGestureChange, {
      passive: false,
    });
    container.addEventListener("gestureend", handleGestureEnd, {
      passive: false,
    });

    return () => {
      container.removeEventListener("gesturestart", handleGestureStart);
      container.removeEventListener("gesturechange", handleGestureChange);
      container.removeEventListener("gestureend", handleGestureEnd);
    };
  }, [containerWidth, effectiveDuration, zoom]);

  // Check if split is possible (segment selected AND playhead inside that segment)
  // Memoized to avoid recalculating on every render
  const canSplit = useMemo(() => {
    if (!selectedId) return false;
    const segment = segments.find((s) => s.id === selectedId);
    if (!segment) return false;
    return currentTime > segment.startTime && currentTime < segment.endTime;
  }, [selectedId, segments, currentTime]);

  // Can add only when outside any segment
  const canAdd = !isInsideSegment;

  // Generate time markers - aim for ~8-15 markers visible at any zoom level
  // Memoized since it's used twice in render (markers + tick marks)
  const timeMarkers = useMemo(() => {
    const markers: { time: number; px: number }[] = [];
    const durationToUse = previewMode ? previewDuration : totalDuration;

    if (durationToUse <= 0) return markers;

    // Calculate ideal interval to show ~10 markers across the visible width
    const targetMarkerCount = 10;
    const visibleDuration = durationToUse / zoom;
    const rawInterval = visibleDuration / targetMarkerCount;

    // Snap to nice intervals: 1s, 5s, 10s, 30s, 1m, 2m, 5m, 10m, 15m, 30m
    const niceIntervals = [1, 5, 10, 30, 60, 120, 300, 600, 900, 1800];
    let interval = niceIntervals[niceIntervals.length - 1];
    for (const nice of niceIntervals) {
      if (nice >= rawInterval) {
        interval = nice;
        break;
      }
    }

    for (let t = 0; t <= durationToUse; t += interval) {
      markers.push({ time: t, px: timeToPx(t) });
    }
    return markers;
  }, [previewMode, previewDuration, totalDuration, zoom, timeToPx]);

  // Display zoom as percentage where 1x = 0%, max = 100%
  const zoomPercent = Math.round(
    ((zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM)) * 100
  );

  return (
    <div
      ref={containerRef}
      className="w-full h-full bg-background border rounded-lg flex flex-col p-1.5 select-none"
    >
      {/* Toolbar */}
      <div className="flex items-center gap-1 mb-1.5">
        {/* Segment editing tools */}
        <Button
          size="sm"
          variant="secondary"
          onClick={handleSplit}
          disabled={!canSplit}
          className="h-7 w-7 p-0"
          title="Split segment at playhead"
        >
          <Scissors className="h-3.5 w-3.5" />
        </Button>
        {!previewMode && (
          <Button
            size="sm"
            variant="secondary"
            onClick={handleAdd}
            disabled={!canAdd}
            className="h-7 w-7 p-0"
            title="Add segment at playhead"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        )}

        <div className="h-4 w-px bg-border mx-1.5" />

        {/* Zoom controls */}
        <Button
          size="sm"
          variant="secondary"
          onClick={handleZoomOut}
          disabled={zoom <= MIN_ZOOM}
          className="h-7 w-7 p-0"
          title="Zoom out"
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <span className="text-xs text-foreground/70 font-medium w-9 text-center tabular-nums">
          {zoomPercent}%
        </span>
        <Button
          size="sm"
          variant="secondary"
          onClick={handleZoomIn}
          disabled={zoom >= MAX_ZOOM}
          className="h-7 w-7 p-0"
          title="Zoom in"
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>

        {/* Centered playback controls */}
        <div className="flex-1 flex items-center justify-center gap-2">
          <Button
            size="sm"
            variant="default"
            onClick={() => {
              const video = videoRef.current;
              if (video) {
                if (video.paused) {
                  video.play().catch(() => {});
                } else {
                  video.pause();
                }
              }
            }}
            className="h-7 w-7 p-0"
            title={isPlaying ? "Pause (Space)" : "Play (Space)"}
          >
            {isPlaying ? (
              <Pause className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5 ml-0.5" />
            )}
          </Button>
          <span className="text-xs text-foreground font-mono tabular-nums">
            {formatTime(effectiveCurrentTime)} / {formatTime(effectiveDuration)}
          </span>
        </div>

        {/* Preview mode toggle */}
        <Button
          size="sm"
          variant={previewMode ? "default" : "secondary"}
          onClick={() => onPreviewModeChange(!previewMode)}
          className="h-7 w-7 p-0"
          title={previewMode ? "Exit preview mode" : "Preview final video"}
        >
          {previewMode ? (
            <EyeOff className="h-3.5 w-3.5" />
          ) : (
            <Eye className="h-3.5 w-3.5" />
          )}
        </Button>

        {/* Delete button - far right */}
        <Button
          size="sm"
          variant="ghost"
          onClick={handleDelete}
          disabled={!selectedId}
          className="h-7 w-7 p-0 text-red-500 hover:text-red-400 hover:bg-red-500/10 disabled:opacity-30"
          title="Delete selected segment"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Scrollable timeline container */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-x-auto overflow-y-hidden relative timeline-scrollbar"
        style={{
          scrollbarWidth: "thin",
          scrollbarColor: "hsl(var(--muted-foreground) / 0.3) transparent",
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* Fixed-width track based on duration * pixelsPerSecond */}
        <div
          className="h-full flex flex-col relative"
          style={{ width: `${trackWidth}px`, minWidth: "100%" }}
        >
          {/* Time markers */}
          <div className="h-5 relative shrink-0">
            {timeMarkers.map(({ time, px }) => (
              <span
                key={time}
                className="absolute text-[11px] text-foreground/60 font-medium -translate-x-1/2 tabular-nums"
                style={{ left: `${px}px` }}
              >
                {formatTime(time)}
              </span>
            ))}
          </div>

          {/* Track */}
          <div
            className="relative flex-1 rounded cursor-pointer min-h-0 overflow-hidden"
            onClick={handleTrackClick}
          >
            {/* Base video layer - always visible, shows full duration */}
            {!previewMode && (
              <div className="absolute inset-y-1 inset-x-0 bg-zinc-700/60 rounded" />
            )}

            {/* Time tick marks */}
            {timeMarkers.map(({ time, px }) => (
              <div
                key={time}
                className="absolute top-0 bottom-0 border-l border-white/10 pointer-events-none"
                style={{ left: `${px}px` }}
              />
            ))}

            {/* Segments */}
            {segments.map((segment) => {
              // In preview mode, use the accumulated offset; in edit mode, use real time
              const left = previewMode
                ? timeToPx(segmentPreviewOffsets.get(segment.id) || 0)
                : timeToPx(segment.startTime);
              const width = Math.max(
                timeToPx(segment.endTime - segment.startTime),
                4
              );

              return (
                <div
                  key={segment.id}
                  className={cn(
                    "absolute top-1 bottom-1 cursor-pointer transition-all",
                    selectedId === segment.id
                      ? "bg-emerald-500 ring-2 ring-white ring-offset-1 ring-offset-background z-10 rounded-md"
                      : "bg-emerald-600/80 hover:bg-emerald-500/90 rounded-sm"
                  )}
                  style={{ left: `${left}px`, width: `${width}px` }}
                  onClick={(e) => handleSegmentClick(e, segment.id)}
                  title={segment.title}
                >
                  {/* Resize handles - only in edit mode */}
                  {!previewMode && (
                    <>
                      {/* Left resize handle - covers left half */}
                      <div
                        className="absolute left-0 top-0 bottom-0 w-1/2 cursor-ew-resize z-10"
                        onMouseDown={(e) =>
                          handleResizeMouseDown(e, segment.id, "left")
                        }
                      />
                      {/* Right resize handle - covers right half */}
                      <div
                        className="absolute right-0 top-0 bottom-0 w-1/2 cursor-ew-resize z-10"
                        onMouseDown={(e) =>
                          handleResizeMouseDown(e, segment.id, "right")
                        }
                      />
                    </>
                  )}

                  {width > 40 && (
                    <div className="px-2 py-0.5 text-[10px] text-white font-semibold truncate pointer-events-none drop-shadow-sm">
                      {segment.title}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Playhead */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-20 pointer-events-none"
              style={{ left: `${timeToPx(effectiveCurrentTime)}px` }}
            >
              {/* Playhead handle */}
              <div
                className="absolute -top-1 left-1/2 -translate-x-1/2 w-3 h-3 bg-red-500 rounded-full cursor-ew-resize pointer-events-auto hover:scale-110 transition-transform"
                onMouseDown={handlePlayheadMouseDown}
              />
              {/* Playhead bottom indicator */}
              <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[4px] border-r-[4px] border-t-[6px] border-l-transparent border-r-transparent border-t-red-500" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
