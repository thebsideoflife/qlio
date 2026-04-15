import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { flushSync } from "react-dom";
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
  selectKeyframe,
  toggleShowKeyframes,
  updateFramingKeyframe,
  addFramingKeyframe,
  removeFramingKeyframe,
} from "@/store/editorSlice";
import type { FramingKeyframe } from "@/remotion/types";
import { getEffectiveKeyframes } from "@/remotion/types";
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
  Layers,
} from "lucide-react";

interface TimelineProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  previewMode: boolean;
  onPreviewModeChange: (preview: boolean) => void;
}

type DragMode = "playhead" | "left" | "right" | "keyframe" | null;

// Zoom: 1 = fit to container, higher = zoomed in
const MIN_ZOOM = 1;
const MAX_ZOOM = 20;
const DEFAULT_ZOOM = 1;
// Frame step: 1/30th second ≈ 33.33ms (works well for 24/25/30fps content)
const FRAME_STEP = 1 / 30;

// Drag state stored in ref for immediate updates without re-render
interface DragInfo {
  mode: DragMode;
  segmentId: string | null;
  startX: number;
  initialStart: number;
  initialEnd: number;
  // Keyframe drag
  keyframeId?: string;
  keyframeInitialTime?: number;
  segmentStartTime?: number;
  segmentEndTime?: number;
}

export function Timeline({
  videoRef,
  previewMode,
  onPreviewModeChange,
}: TimelineProps) {
  const dispatch = useDispatch();
  const segments = useSelector((state: RootState) => state.editor.segments);
  const selectedId = useSelector(
    (state: RootState) => state.editor.selectedSegmentId,
  );
  const currentTime = useSelector(
    (state: RootState) => state.editor.currentTime,
  );
  const duration = useSelector((state: RootState) => state.editor.duration);
  const selectedKeyframeId = useSelector(
    (state: RootState) => state.editor.selectedKeyframeId,
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Suppress playhead auto-scroll when user is manually scrolling
  const userScrollingRef = useRef(false);
  const userScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Set before programmatic scrolls so onScroll doesn't treat them as user scrolls
  const programmaticScrollRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<DragInfo | null>(null);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  // "segment" = blue bar was clicked directly; "keyframe" = a framing block was clicked
  const [selectionMode, setSelectionMode] = useState<"segment" | "keyframe">(
    "segment",
  );
  const selectionModeRef = useRef<"segment" | "keyframe">("segment");
  const selectedKeyframeIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectionModeRef.current = selectionMode;
  }, [selectionMode]);
  useEffect(() => {
    selectedKeyframeIdRef.current = selectedKeyframeId;
  }, [selectedKeyframeId]);
  const [containerWidth, setContainerWidth] = useState(800);
  const [isPlaying, setIsPlaying] = useState(false);
  const showAllKeyframes = useSelector(
    (state: RootState) => state.editor.showKeyframes,
  );

  // Track zoom in ref for event handlers
  const zoomRef = useRef(zoom);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

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
    [segments],
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
    [sortedSegments],
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
    [sortedSegments],
  );

  // Effective duration based on mode
  const effectiveDuration = previewMode ? previewDuration : totalDuration;
  // Effective current time for display
  const effectiveCurrentTime = previewMode
    ? realTimeToPreviewTime(currentTime)
    : currentTime;

  // Track margin (ml-6 = 24px, mr-3 = 12px)
  const TRACK_MARGIN = 36;

  // Measure container width
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const updateWidth = () => {
      // Subtract margin so track fits within margins at zoom=1
      setContainerWidth(Math.max(0, container.clientWidth - TRACK_MARGIN));
    };

    updateWidth();
    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(container);

    return () => resizeObserver.disconnect();
  }, []);

  // At zoom=1, track fits exactly in container (minus margins). Higher zoom = wider track.
  const trackWidth = containerWidth * zoom;

  // Pixels per second based on zoom and container (use effective duration for preview mode)
  const pixelsPerSecond =
    effectiveDuration > 0 ? trackWidth / effectiveDuration : trackWidth / 600;

  // Convert time to pixels
  const timeToPx = useCallback(
    (time: number) => time * pixelsPerSecond,
    [pixelsPerSecond],
  );

  // Convert pixels to time
  const pxToTime = useCallback(
    (px: number) => px / pixelsPerSecond,
    [pixelsPerSecond],
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
    [totalDuration],
  );

  // Check if playhead is inside any segment - memoized to avoid recalculating on every render
  const isInsideSegment = useMemo(() => {
    return segments.some(
      (s) => currentTime >= s.startTime && currentTime < s.endTime,
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
    [segments, pxToTime, previewMode],
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

  // FRAME_STEP is defined as a module constant above

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
        e.preventDefault();
        // Dispatch is deferred to avoid stale closure — call site logic duplicated from handleDelete
        if (
          selectionModeRef.current === "keyframe" &&
          selectedKeyframeIdRef.current &&
          selectedId
        ) {
          dispatch(
            removeFramingKeyframe({
              segmentId: selectedId,
              keyframeId: selectedKeyframeIdRef.current,
            }),
          );
        } else if (selectionModeRef.current === "segment" && selectedId) {
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

  // Auto-scroll to keep playhead visible when playing (suppressed while user scrolls manually)
  useEffect(() => {
    if (!scrollRef.current || !isPlaying || userScrollingRef.current) return;

    const scrollContainer = scrollRef.current;
    const playheadPx = timeToPx(effectiveCurrentTime);
    const containerWidth = scrollContainer.clientWidth;
    const scrollLeft = scrollContainer.scrollLeft;

    const buffer = containerWidth * 0.2;
    if (playheadPx < scrollLeft + buffer) {
      programmaticScrollRef.current = true;
      scrollContainer.scrollLeft = Math.max(0, playheadPx - buffer);
      programmaticScrollRef.current = false;
    } else if (playheadPx > scrollLeft + containerWidth - buffer) {
      programmaticScrollRef.current = true;
      scrollContainer.scrollLeft = playheadPx - containerWidth + buffer;
      programmaticScrollRef.current = false;
    }
  }, [effectiveCurrentTime, isPlaying, timeToPx]);

  // Track which keyframe ID is selected via ref to avoid dependency cycle
  const selectedKfRef = useRef(selectedKeyframeId);
  useEffect(() => {
    selectedKfRef.current = selectedKeyframeId;
  }, [selectedKeyframeId]);

  // Auto-select segment + active keyframe as playhead moves
  useEffect(() => {
    const containingSegment = segments.find(
      (s) => currentTime >= s.startTime && currentTime < s.endTime,
    );

    if (containingSegment && containingSegment.id !== selectedId) {
      dispatch(selectSegment(containingSegment.id));
    }

    // Track active keyframe within the selected segment
    const activeSeg =
      containingSegment?.id === selectedId
        ? containingSegment
        : segments.find((s) => s.id === selectedId);
    if (
      activeSeg?.framing &&
      currentTime >= activeSeg.startTime &&
      currentTime < activeSeg.endTime
    ) {
      const kfs = getEffectiveKeyframes(activeSeg.framing);
      const timeInSeg = currentTime - activeSeg.startTime;
      const sorted = [...kfs].sort((a, b) => a.time - b.time);
      const active = sorted.filter((k) => k.time <= timeInSeg + 0.05);
      if (active.length > 0) {
        const activeId = active[active.length - 1].id;
        if (activeId !== selectedKfRef.current) {
          dispatch(selectKeyframe(activeId));
        }
      }
    }
  }, [currentTime, segments, selectedId, dispatch]);

  // Handle playhead drag start
  const handlePlayheadMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = {
      mode: "playhead",
      segmentId: null,
      startX: e.clientX,
      initialStart: currentTime,
      initialEnd: 0,
    };
    setIsDragging(true);
  };

  // Handle segment resize start (disabled in preview mode)
  const handleResizeMouseDown = (
    e: React.MouseEvent,
    segmentId: string,
    mode: "left" | "right",
  ) => {
    if (previewMode) return; // No resizing in preview mode

    e.stopPropagation();
    e.preventDefault();
    const segment = segments.find((s) => s.id === segmentId);
    if (!segment) return;

    dispatch(selectSegment(segmentId));

    dragRef.current = {
      mode,
      segmentId,
      startX: e.clientX,
      initialStart: segment.startTime,
      initialEnd: segment.endTime,
    };
    setIsDragging(true);
  };

  // Left margin offset (ml-6 = 24px)
  const TRACK_LEFT_MARGIN = 24;

  // Convert click position to time - handles scroll offset correctly
  const getTimeFromClickEvent = useCallback(
    (e: React.MouseEvent) => {
      const scrollContainer = scrollRef.current;
      if (!scrollContainer) return 0;

      // Get the scroll container's viewport position
      const scrollRect = scrollContainer.getBoundingClientRect();
      // Click position relative to scroll container's visible area
      const clickXInViewport = e.clientX - scrollRect.left;
      // Add scroll offset and subtract left margin to get position in the track
      const clickXInTrack =
        clickXInViewport + scrollContainer.scrollLeft - TRACK_LEFT_MARGIN;
      // Convert to time (this gives us preview time in preview mode)
      const clickTime = pxToTime(Math.max(0, clickXInTrack));

      // In preview mode, convert preview time to real time
      if (previewMode) {
        return previewTimeToRealTime(
          Math.max(0, Math.min(previewDuration, clickTime)),
        );
      }

      return clampTime(clickTime);
    },
    [clampTime, pxToTime, previewMode, previewTimeToRealTime, previewDuration],
  );

  // Handle segment click - select AND seek to click position
  const handleSegmentClick = (e: React.MouseEvent, segmentId: string) => {
    e.stopPropagation();
    setSelectionMode("segment");
    dispatch(selectSegment(segmentId));

    const time = getTimeFromClickEvent(e);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
    dispatch(setCurrentTime(time));
  };

  // Handle track click to seek
  const handleTrackClick = (e: React.MouseEvent) => {
    if (isDragging) return;

    const time = getTimeFromClickEvent(e);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
    dispatch(setCurrentTime(time));

    // Deselect segment when clicking on empty track
    setSelectionMode("segment");
    dispatch(selectSegment(null));
  };

  // Mouse move handler for dragging - direct Redux updates with flushSync
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;

      const deltaX = e.clientX - drag.startX;
      const deltaTime = pxToTime(deltaX);

      if (drag.mode === "keyframe" && drag.segmentId && drag.keyframeId) {
        const segDuration = drag.segmentEndTime! - drag.segmentStartTime!;
        // Find adjacent keyframe boundaries to prevent crossing
        const seg = segments.find((s) => s.id === drag.segmentId);
        const kfs = seg?.framing ? getEffectiveKeyframes(seg.framing) : [];
        const sorted = [...kfs].sort((a, b) => a.time - b.time);
        const idx = sorted.findIndex((k) => k.id === drag.keyframeId);
        const minTime = idx > 0 ? sorted[idx - 1].time + 0.1 : 0.1;
        const maxTime =
          idx < sorted.length - 1
            ? sorted[idx + 1].time - 0.1
            : segDuration - 0.1;
        const newTime = Math.max(
          minTime,
          Math.min(maxTime, drag.keyframeInitialTime! + deltaTime),
        );
        flushSync(() => {
          dispatch(
            updateFramingKeyframe({
              segmentId: drag.segmentId!,
              keyframeId: drag.keyframeId!,
              changes: { time: Math.round(newTime * 10) / 10 },
            }),
          );
        });
      } else if (drag.mode === "playhead") {
        const rawTime = clampTime(drag.initialStart + deltaTime);
        const newTime = snapToSegmentEdge(rawTime);
        if (videoRef.current) {
          videoRef.current.currentTime = newTime;
        }
        dispatch(setCurrentTime(newTime));
      } else if (drag.mode === "left" && drag.segmentId) {
        const newStart = clampTime(
          drag.initialStart + deltaTime,
          0,
          drag.initialEnd - 0.1,
        );
        // Direct Redux update - flushSync ensures immediate DOM update
        flushSync(() => {
          dispatch(
            updateSegmentTime({
              id: drag.segmentId!,
              start: newStart,
              end: drag.initialEnd,
            }),
          );
        });
      } else if (drag.mode === "right" && drag.segmentId) {
        const newEnd = clampTime(
          drag.initialEnd + deltaTime,
          drag.initialStart + 0.1,
          totalDuration,
        );
        flushSync(() => {
          dispatch(
            updateSegmentTime({
              id: drag.segmentId!,
              start: drag.initialStart,
              end: newEnd,
            }),
          );
        });
      }
    };

    const handleMouseUp = () => {
      const drag = dragRef.current;
      if (drag && (drag.mode === "left" || drag.mode === "right")) {
        dispatch(finalizeSegmentEdit());
      }
      // Keyframe drag just ends - changes were applied live via updateFramingKeyframe
      dragRef.current = null;
      setIsDragging(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [
    isDragging,
    pxToTime,
    clampTime,
    totalDuration,
    videoRef,
    dispatch,
    snapToSegmentEdge,
    segments,
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

  // True when the focused keyframe can be deleted (segment has >1 keyframes)
  const canDeleteKeyframe = useMemo(() => {
    if (!selectedKeyframeId || !selectedId) return false;
    const seg = segments.find((s) => s.id === selectedId);
    if (!seg?.framing) return false;
    return getEffectiveKeyframes(seg.framing).length > 1;
  }, [selectedKeyframeId, selectedId, segments]);

  const handleDelete = useCallback(() => {
    if (
      selectionMode === "keyframe" &&
      selectedKeyframeId &&
      selectedId &&
      canDeleteKeyframe
    ) {
      dispatch(
        removeFramingKeyframe({
          segmentId: selectedId,
          keyframeId: selectedKeyframeId,
        }),
      );
    } else if (selectionMode === "segment" && selectedId) {
      dispatch(deleteSegment(selectedId));
    }
  }, [
    selectionMode,
    selectedKeyframeId,
    selectedId,
    canDeleteKeyframe,
    dispatch,
  ]);

  // Button zoom - bigger steps (50% change)
  const applyZoom = (newZoom: number) => {
    const scrollContainer = scrollRef.current;
    if (!scrollContainer) return;
    // Same math as gesture zoom — keep effectiveCurrentTime pinned to viewport center
    const cursorX = scrollContainer.clientWidth / 2;
    const newPps =
      effectiveDuration > 0
        ? (containerWidth * newZoom) / effectiveDuration
        : 600;
    const newScroll = Math.max(0, effectiveCurrentTime * newPps - cursorX);
    zoomRef.current = newZoom;
    flushSync(() => setZoom(newZoom));
    programmaticScrollRef.current = true;
    scrollContainer.scrollLeft = newScroll;
    programmaticScrollRef.current = false;
  };

  const handleZoomIn = () => applyZoom(Math.min(zoom * 1.5, MAX_ZOOM));
  const handleZoomOut = () => applyZoom(Math.max(zoom / 1.5, MIN_ZOOM));

  // Touch-based pinch zoom (mobile)
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const currentZoom = zoomRef.current;

      const scrollContainer = scrollRef.current;
      if (scrollContainer) {
        const rect = scrollContainer.getBoundingClientRect();
        const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2;

        pinchStateRef.current = {
          initialDistance: Math.hypot(dx, dy),
          initialZoom: currentZoom,
          centerX: centerX - rect.left,
          scrollLeft: scrollContainer.scrollLeft,
        };
      }
    }
  }, []);

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (
        e.touches.length === 2 &&
        pinchStateRef.current.initialDistance !== null
      ) {
        e.preventDefault();
        const scrollContainer = scrollRef.current;
        if (!scrollContainer) return;

        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const currentDistance = Math.hypot(dx, dy);

        const scaleRatio =
          currentDistance / pinchStateRef.current.initialDistance;
        const newZoom = Math.max(
          MIN_ZOOM,
          Math.min(MAX_ZOOM, pinchStateRef.current.initialZoom * scaleRatio),
        );

        const initialPps =
          effectiveDuration > 0
            ? (containerWidth * pinchStateRef.current.initialZoom) /
              effectiveDuration
            : 1;
        const centerPxInTrack =
          pinchStateRef.current.centerX + pinchStateRef.current.scrollLeft;
        const timeAtCenter = centerPxInTrack / initialPps;

        const newPps =
          effectiveDuration > 0
            ? (containerWidth * newZoom) / effectiveDuration
            : 1;
        const newScroll = Math.max(
          0,
          timeAtCenter * newPps - pinchStateRef.current.centerX,
        );

        zoomRef.current = newZoom;
        flushSync(() => setZoom(newZoom));
        scrollContainer.scrollLeft = newScroll;
      }
    },
    [containerWidth, effectiveDuration],
  );

  const handleTouchEnd = useCallback(() => {
    pinchStateRef.current.initialDistance = null;
  }, []);

  // Simple wheel handler - just update zoom and scroll
  useEffect(() => {
    const scrollContainer = scrollRef.current;
    if (!scrollContainer) return;

    const handleWheel = (e: WheelEvent) => {
      if (gestureStateRef.current.isGesturing) return;

      // Ctrl/Cmd + wheel = zoom
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();

        const rect = scrollContainer.getBoundingClientRect();
        const cursorX = e.clientX - rect.left;
        const scrollLeft = scrollContainer.scrollLeft;
        const currentZoom = zoomRef.current;

        // Time at cursor
        const pps =
          effectiveDuration > 0
            ? (containerWidth * currentZoom) / effectiveDuration
            : 1;
        const timeAtCursor = (cursorX + scrollLeft) / pps;

        // New zoom
        const zoomDelta = -e.deltaY * 0.01;
        const newZoom = Math.max(
          MIN_ZOOM,
          Math.min(MAX_ZOOM, currentZoom * (1 + zoomDelta)),
        );

        // New scroll to keep cursor over same time
        const newPps =
          effectiveDuration > 0
            ? (containerWidth * newZoom) / effectiveDuration
            : 1;
        const newScroll = Math.max(0, timeAtCursor * newPps - cursorX);

        // Update synchronously
        zoomRef.current = newZoom;
        flushSync(() => setZoom(newZoom));
        scrollContainer.scrollLeft = newScroll;
      } else {
        // Plain wheel = horizontal scroll
        // Normalize deltaMode: 0=pixels (trackpad), 1=lines (mouse), 2=pages
        e.preventDefault();
        const raw = e.deltaX !== 0 ? e.deltaX : e.deltaY;
        const delta =
          e.deltaMode === 1
            ? raw * 40
            : e.deltaMode === 2
              ? raw * scrollContainer.clientWidth
              : raw;
        scrollContainer.scrollLeft += delta;
      }
    };

    scrollContainer.addEventListener("wheel", handleWheel, { passive: false });
    return () => scrollContainer.removeEventListener("wheel", handleWheel);
  }, [containerWidth, effectiveDuration]);

  // Safari gesture events (only needs useEffect for non-React events)
  useEffect(() => {
    const container = containerRef.current;
    const scrollContainer = scrollRef.current;
    if (!container || !scrollContainer) return;

    const handleGestureStart = (e: Event) => {
      e.preventDefault();
      gestureStateRef.current = {
        isGesturing: true,
        initialZoom: zoomRef.current,
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
          gestureStateRef.current.initialZoom * gestureEvent.scale,
        ),
      );

      const initialPps =
        effectiveDuration > 0
          ? (containerWidth * gestureStateRef.current.initialZoom) /
            effectiveDuration
          : 1;
      const centerPxInTrack =
        gestureStateRef.current.centerX + gestureStateRef.current.scrollLeft;
      const timeAtCenter = centerPxInTrack / initialPps;

      const newPps =
        effectiveDuration > 0
          ? (containerWidth * newZoom) / effectiveDuration
          : 1;
      const newScroll = Math.max(
        0,
        timeAtCenter * newPps - gestureStateRef.current.centerX,
      );

      zoomRef.current = newZoom;
      flushSync(() => setZoom(newZoom));
      scrollContainer.scrollLeft = newScroll;
    };

    const handleGestureEnd = (e: Event) => {
      e.preventDefault();
      gestureStateRef.current.isGesturing = false;
    };

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
  }, [containerWidth, effectiveDuration]);

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
    ((zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM)) * 100,
  );

  return (
    <div ref={containerRef} className="w-full h-full flex flex-col select-none">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0">
        <Button
          size="sm"
          variant="outline"
          onClick={handleSplit}
          disabled={!canSplit}
          className="h-9 w-9 p-0"
          title="Split segment at playhead"
        >
          <Scissors className="h-4 w-4" />
        </Button>
        {!previewMode && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleAdd}
            disabled={!canAdd}
            className="h-9 w-9 p-0"
            title="Add segment at playhead"
          >
            <Plus className="h-4 w-4" />
          </Button>
        )}

        <div className="h-5 w-px bg-border mx-1" />

        <Button
          size="sm"
          variant="outline"
          onClick={handleZoomOut}
          disabled={zoom <= MIN_ZOOM}
          className="h-9 w-9 p-0"
          title="Zoom out"
        >
          <ZoomOut className="h-4 w-4" />
        </Button>
        <span className="text-xs text-muted-foreground font-semibold w-9 text-center tabular-nums">
          {zoomPercent}%
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={handleZoomIn}
          disabled={zoom >= MAX_ZOOM}
          className="h-9 w-9 p-0"
          title="Zoom in"
        >
          <ZoomIn className="h-4 w-4" />
        </Button>

        {/* Centered playback controls */}
        <div className="flex-1 flex items-center justify-center gap-3">
          <Button
            size="sm"
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
            className="h-9 w-9 p-0"
            title={isPlaying ? "Pause (Space)" : "Play (Space)"}
          >
            {isPlaying ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4 ml-0.5" />
            )}
          </Button>
          <span className="text-sm text-foreground font-mono font-bold tabular-nums">
            {formatTime(effectiveCurrentTime)} / {formatTime(effectiveDuration)}
          </span>
        </div>

        <Button
          size="sm"
          variant={showAllKeyframes ? "default" : "outline"}
          onClick={() => dispatch(toggleShowKeyframes())}
          className="h-9 w-9 p-0"
          title={
            showAllKeyframes
              ? "Show selected keyframes only"
              : "Show all keyframes"
          }
        >
          <Layers className="h-4 w-4" />
        </Button>

        <Button
          size="sm"
          variant={previewMode ? "default" : "outline"}
          onClick={() => onPreviewModeChange(!previewMode)}
          className="h-9 w-9 p-0"
          title={previewMode ? "Exit preview mode" : "Preview final video"}
        >
          {previewMode ? (
            <EyeOff className="h-4 w-4" />
          ) : (
            <Eye className="h-4 w-4" />
          )}
        </Button>

        <Button
          size="sm"
          variant="outline"
          onClick={handleDelete}
          disabled={
            selectionMode === "keyframe" ? !canDeleteKeyframe : !selectedId
          }
          className="h-9 w-9 p-0 text-red-500 hover:text-red-400 hover:bg-red-500/10 hover:border-red-500/50 disabled:opacity-30"
          title={
            selectionMode === "keyframe"
              ? "Delete framing keyframe"
              : "Delete selected segment"
          }
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {/* Timeline track */}
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
        onScroll={() => {
          // Ignore programmatic scrolls (applyZoom, auto-scroll) — only react to user scrolls
          if (programmaticScrollRef.current) return;
          userScrollingRef.current = true;
          if (userScrollTimeoutRef.current)
            clearTimeout(userScrollTimeoutRef.current);
          userScrollTimeoutRef.current = setTimeout(() => {
            userScrollingRef.current = false;
          }, 2000);
        }}
      >
        <div
          className="h-full flex flex-col relative ml-6 mr-3"
          style={{ width: `${trackWidth}px`, minWidth: "calc(100% - 36px)" }}
        >
          {/* Time markers */}
          <div className="h-5 relative shrink-0">
            {timeMarkers.map(({ time, px }) => (
              <span
                key={time}
                className="absolute text-[11px] text-muted-foreground font-medium -translate-x-1/2 tabular-nums"
                style={{ left: `${px}px` }}
              >
                {formatTime(time)}
              </span>
            ))}
          </div>

          {/* Keyframe lane — blocks showing each keyframe's active range */}
          {(() => {
            const segsToShow = showAllKeyframes
              ? segments.filter((s) => s.framing)
              : [];
            if (segsToShow.length === 0) return null;

            return (
              <div className="h-5 shrink-0 relative mb-0.5 overflow-visible">
                {segsToShow.map((seg) => {
                  const kfs = getEffectiveKeyframes(seg.framing!);
                  const segDuration = seg.endTime - seg.startTime;
                  const isShort = segDuration < 5;
                  const isSelected = seg.id === selectedId;
                  const laneLeft = previewMode
                    ? timeToPx(segmentPreviewOffsets.get(seg.id) || 0)
                    : timeToPx(seg.startTime);
                  const laneWidth = Math.max(timeToPx(segDuration), 20);
                  const sortedKfs = [...kfs].sort((a, b) => a.time - b.time);
                  const GAP = 2;

                  return (
                    <div key={seg.id}>
                      <div
                        className="absolute top-0 bottom-0"
                        style={{
                          left: `${laneLeft}px`,
                          width: `${laneWidth}px`,
                        }}
                      >
                        {sortedKfs.map((kf, idx) => {
                          const nextTime =
                            idx < sortedKfs.length - 1
                              ? sortedKfs[idx + 1].time
                              : segDuration;
                          const blockLeft =
                            (kf.time / segDuration) * laneWidth +
                            (idx > 0 ? GAP / 2 : 0);
                          const blockRight =
                            (nextTime / segDuration) * laneWidth -
                            (idx < sortedKfs.length - 1 ? GAP / 2 : 0);
                          const blockWidth = Math.max(
                            blockRight - blockLeft,
                            4,
                          );
                          const isKfSelected =
                            isSelected && selectedKeyframeId === kf.id;
                          const isFirst = idx === 0;

                          return (
                            <div
                              key={kf.id}
                              className={cn(
                                "absolute top-0 bottom-0 rounded transition-colors cursor-pointer",
                                isKfSelected
                                  ? "bg-amber-500/90 ring-1 ring-amber-400/60"
                                  : isSelected
                                    ? "bg-amber-600/40 hover:bg-amber-500/55"
                                    : "bg-amber-600/20 hover:bg-amber-600/35",
                              )}
                              style={{
                                left: `${blockLeft}px`,
                                width: `${blockWidth}px`,
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectionMode("keyframe");
                                dispatch(selectSegment(seg.id));
                                dispatch(selectKeyframe(kf.id));
                                const rect =
                                  e.currentTarget.getBoundingClientRect();
                                const pct =
                                  (e.clientX - rect.left) / rect.width;
                                const blockDuration = nextTime - kf.time;
                                const timeInSeg = kf.time + pct * blockDuration;
                                const seekTo = seg.startTime + timeInSeg;
                                if (videoRef.current) {
                                  videoRef.current.currentTime = seekTo;
                                }
                                dispatch(setCurrentTime(seekTo));
                              }}
                              onDoubleClick={(e) => {
                                if (isShort) return;
                                e.stopPropagation();
                                const rect =
                                  e.currentTarget.getBoundingClientRect();
                                const clickX = e.clientX - rect.left;
                                const pct = clickX / rect.width;
                                const blockDuration = nextTime - kf.time;
                                const timeInSeg = kf.time + pct * blockDuration;
                                const rounded =
                                  Math.round(
                                    Math.max(
                                      0.1,
                                      Math.min(segDuration - 0.1, timeInSeg),
                                    ) * 10,
                                  ) / 10;
                                if (
                                  sortedKfs.some(
                                    (k) => Math.abs(k.time - rounded) < 0.5,
                                  )
                                )
                                  return;
                                const newKf: FramingKeyframe = {
                                  id: crypto.randomUUID(),
                                  time: rounded,
                                  focusX: kf.focusX,
                                  focusY: kf.focusY,
                                  zoom: kf.zoom,
                                  isAiGenerated: false,
                                };
                                dispatch(
                                  addFramingKeyframe({
                                    segmentId: seg.id,
                                    keyframe: newKf,
                                  }),
                                );
                              }}
                            >
                              {/* Start/end times — vertically centered in the block */}
                              {isKfSelected && blockWidth > 40 && (
                                <span className="absolute inset-y-0 left-0.5 flex items-center text-[8px] font-mono text-white/70 pointer-events-none leading-none">
                                  {formatTime(seg.startTime + kf.time)}
                                </span>
                              )}
                              {isKfSelected && blockWidth > 60 && (
                                <span className="absolute inset-y-0 right-0.5 flex items-center text-[8px] font-mono text-white/70 pointer-events-none leading-none">
                                  {formatTime(seg.startTime + nextTime)}
                                </span>
                              )}
                              {/* Drag handle on the left edge (not for first keyframe, only selected segment) */}
                              {isSelected && !isFirst && (
                                <div
                                  className="absolute -left-[3px] top-0 bottom-0 w-[6px] cursor-ew-resize z-10 group flex items-center justify-center"
                                  onMouseDown={(e) => {
                                    e.stopPropagation();
                                    e.preventDefault();
                                    dispatch(selectKeyframe(kf.id));
                                    dragRef.current = {
                                      mode: "keyframe",
                                      segmentId: seg.id,
                                      startX: e.clientX,
                                      initialStart: 0,
                                      initialEnd: 0,
                                      keyframeId: kf.id,
                                      keyframeInitialTime: kf.time,
                                      segmentStartTime: seg.startTime,
                                      segmentEndTime: seg.endTime,
                                    };
                                    setIsDragging(true);
                                  }}
                                >
                                  <div className="w-px h-2/3 bg-white/30 group-hover:bg-white/70 transition-colors" />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      {/* Delete framing keyframe button — floats over lane, same style as split indicator */}
                      {isSelected &&
                        (() => {
                          const selKf = selectedKeyframeId
                            ? sortedKfs.find((k) => k.id === selectedKeyframeId)
                            : null;
                          if (!selKf || sortedKfs.length <= 1) return null;
                          const selIdx = sortedKfs.indexOf(selKf);
                          const nextT =
                            selIdx < sortedKfs.length - 1
                              ? sortedKfs[selIdx + 1].time
                              : segDuration;
                          const centerPx =
                            (nextT / segDuration) * laneWidth - 4;
                          return (
                            <div
                              className="absolute z-20 group cursor-pointer"
                              style={{
                                left: `${laneLeft + centerPx}px`,
                                transform: "translateX(-50%)",
                                width: "14px",
                                top: "-14px",
                                height: "14px",
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                dispatch(
                                  removeFramingKeyframe({
                                    segmentId: seg.id,
                                    keyframeId: selKf.id,
                                  }),
                                );
                              }}
                              title="Delete framing keyframe"
                            >
                              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-zinc-800 border border-red-500/60 group-hover:border-red-400 flex items-center justify-center transition-colors">
                                <span className="text-[9px] font-bold text-red-400 group-hover:text-red-300 leading-none">
                                  x
                                </span>
                              </div>
                            </div>
                          );
                        })()}

                      {/* Split-framing indicator — only for selected segment */}
                      {isSelected &&
                        (() => {
                          if (isShort) return null;
                          const timeInSeg = currentTime - seg.startTime;
                          const rounded = Math.round(timeInSeg * 10) / 10;
                          if (rounded <= 0 || rounded >= segDuration)
                            return null;
                          if (
                            sortedKfs.some(
                              (k) => Math.abs(k.time - rounded) < 0.5,
                            )
                          )
                            return null;
                          const pxPos =
                            (timeInSeg / segDuration) * laneWidth + 1;

                          return (
                            <div
                              className="absolute top-0 bottom-0 z-20 group cursor-pointer"
                              style={{
                                left: `${laneLeft + pxPos}px`,
                                transform: "translateX(-50%)",
                                width: "14px",
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                const sourceKf =
                                  [...sortedKfs]
                                    .reverse()
                                    .find((k) => k.time <= timeInSeg) ||
                                  sortedKfs[0];
                                dispatch(
                                  addFramingKeyframe({
                                    segmentId: seg.id,
                                    keyframe: {
                                      id: crypto.randomUUID(),
                                      time: rounded,
                                      focusX: sourceKf.focusX,
                                      focusY: sourceKf.focusY,
                                      zoom: sourceKf.zoom,
                                      isAiGenerated: false,
                                    },
                                  }),
                                );
                              }}
                              title="Split framing here"
                            >
                              <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-red-500/50 group-hover:bg-red-500" />
                              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-zinc-800 border border-red-500/60 group-hover:border-red-400 flex items-center justify-center transition-colors">
                                <span className="text-[9px] font-bold text-red-400 group-hover:text-red-300 leading-none">
                                  +
                                </span>
                              </div>
                            </div>
                          );
                        })()}
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {/* Track */}
          <div
            className="relative flex-1 rounded cursor-pointer min-h-0 bg-zinc-800/50"
            onClick={handleTrackClick}
          >
            {/* Time tick marks */}
            {timeMarkers.map(({ time, px }) => (
              <div
                key={time}
                className="absolute top-0 bottom-0 border-l border-white/5 pointer-events-none"
                style={{ left: `${px}px` }}
              />
            ))}

            {/* Segments */}
            {segments.map((segment) => {
              const left = previewMode
                ? timeToPx(segmentPreviewOffsets.get(segment.id) || 0)
                : timeToPx(segment.startTime);
              const width = Math.max(
                timeToPx(segment.endTime - segment.startTime),
                4,
              );

              return (
                <div
                  key={segment.id}
                  className={cn(
                    "absolute top-1 bottom-1 cursor-pointer rounded",
                    selectedId === segment.id && selectionMode === "segment"
                      ? "bg-blue-500 ring-2 ring-blue-400 z-10"
                      : selectedId === segment.id
                        ? "bg-blue-600/70 ring-2 ring-amber-400/60 z-10"
                        : "bg-blue-600/70 hover:bg-blue-500/80",
                  )}
                  style={{ left: `${left}px`, width: `${width}px` }}
                  onClick={(e) => handleSegmentClick(e, segment.id)}
                  title={segment.title}
                >
                  {!previewMode && (
                    <>
                      <div
                        className="absolute left-0 top-0 bottom-0 w-1/2 cursor-ew-resize z-10"
                        onMouseDown={(e) =>
                          handleResizeMouseDown(e, segment.id, "left")
                        }
                      />
                      <div
                        className="absolute right-0 top-0 bottom-0 w-1/2 cursor-ew-resize z-10"
                        onMouseDown={(e) =>
                          handleResizeMouseDown(e, segment.id, "right")
                        }
                      />
                    </>
                  )}

                  {width > 30 && (
                    <div className="px-1.5 py-0.5 text-[10px] text-white font-semibold truncate pointer-events-none">
                      {segment.title}
                    </div>
                  )}
                  {width > 60 && (
                    <div className="absolute bottom-1 left-1 text-[9px] text-white/50 font-mono pointer-events-none">
                      {formatTime(segment.startTime)}
                    </div>
                  )}
                  {width > 80 && (
                    <div className="absolute bottom-1 right-1 text-[9px] text-white/50 font-mono pointer-events-none">
                      {formatTime(segment.endTime)}
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
              <div
                className="absolute -top-1 left-1/2 -translate-x-1/2 w-3 h-3 bg-red-500 rounded-full cursor-ew-resize pointer-events-auto hover:scale-110 transition-transform"
                onMouseDown={handlePlayheadMouseDown}
              />
              <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[4px] border-r-[4px] border-t-[6px] border-l-transparent border-r-transparent border-t-red-500" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
