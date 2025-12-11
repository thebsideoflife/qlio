import { useRef, useState, useCallback, useEffect } from "react";
import { useSelector, useDispatch } from "react-redux";
import type { RootState } from "@/store/store";
import {
  selectSegment,
  updateSegmentTime,
  splitSegment,
  addSegment,
  deleteSegment,
  setCurrentTime,
} from "@/store/editorSlice";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Scissors, Plus, Trash2, ZoomIn, ZoomOut } from "lucide-react";

interface TimelineProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
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

export function Timeline({ videoRef }: TimelineProps) {
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

  // Use real duration, or fallback to 10 mins if 0
  const totalDuration = duration > 0 ? duration : 600;

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

  // Pixels per second based on zoom and container
  const pixelsPerSecond = trackWidth / totalDuration;

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

  // Check if playhead is inside any segment
  const isInsideSegment = useCallback(() => {
    return segments.some(
      (s) => currentTime >= s.startTime && currentTime < s.endTime
    );
  }, [segments, currentTime]);

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

  // Keyboard shortcuts (Space for play/pause, Delete for delete segment)
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
            video.play();
          } else {
            video.pause();
          }
        }
      } else if (e.code === "Delete" || e.code === "Backspace") {
        if (selectedId) {
          e.preventDefault();
          dispatch(deleteSegment(selectedId));
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [videoRef, selectedId, dispatch]);

  // Auto-scroll to keep playhead visible when playing
  useEffect(() => {
    if (!scrollRef.current || !isPlaying) return;

    const scrollContainer = scrollRef.current;
    const playheadPx = timeToPx(currentTime);
    const containerWidth = scrollContainer.clientWidth;
    const scrollLeft = scrollContainer.scrollLeft;

    // If playhead is outside visible area, scroll
    const buffer = containerWidth * 0.2;
    if (playheadPx < scrollLeft + buffer) {
      scrollContainer.scrollLeft = Math.max(0, playheadPx - buffer);
    } else if (playheadPx > scrollLeft + containerWidth - buffer) {
      scrollContainer.scrollLeft = playheadPx - containerWidth + buffer;
    }
  }, [currentTime, isPlaying, timeToPx]);

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

  // Handle segment resize start
  const handleResizeMouseDown = (
    e: React.MouseEvent,
    segmentId: string,
    mode: "left" | "right"
  ) => {
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
      // Convert to time
      return clampTime(pxToTime(clickXInTrack));
    },
    [clampTime, pxToTime]
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
        const newTime = clampTime(dragState.initialStart + deltaTime);
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
      setDragState(null);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragState, pxToTime, clampTime, totalDuration, videoRef, dispatch]);

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

  // Pinch/gesture zoom using native event listeners
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Track pinch state
    let initialPinchDistance: number | null = null;
    let initialZoom = zoom;
    let pinchCenterX = 0;
    let pinchScrollLeft = 0;

    // Touch-based pinch (mobile)
    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        initialPinchDistance = Math.hypot(dx, dy);
        initialZoom = zoom;

        // Calculate pinch center for zoom-toward-center
        const scrollContainer = scrollRef.current;
        if (scrollContainer) {
          const rect = scrollContainer.getBoundingClientRect();
          const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          pinchCenterX = centerX - rect.left;
          pinchScrollLeft = scrollContainer.scrollLeft;
        }
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && initialPinchDistance !== null) {
        e.preventDefault();
        e.stopPropagation();

        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const currentDistance = Math.hypot(dx, dy);

        const scale = currentDistance / initialPinchDistance;
        const newZoom = Math.max(
          MIN_ZOOM,
          Math.min(MAX_ZOOM, initialZoom * scale)
        );

        // Zoom toward pinch center
        const scrollContainer = scrollRef.current;
        if (scrollContainer) {
          const oldPps = (containerWidth * initialZoom) / totalDuration;
          const newPps = (containerWidth * newZoom) / totalDuration;

          const centerPxInTrack = pinchCenterX + pinchScrollLeft;
          const timeAtCenter = centerPxInTrack / oldPps;
          const newCenterPx = timeAtCenter * newPps;
          const newScrollLeft = newCenterPx - pinchCenterX;

          scrollContainer.scrollLeft = Math.max(0, newScrollLeft);
        }

        setZoom(newZoom);
      }
    };

    const handleTouchEnd = () => {
      initialPinchDistance = null;
    };

    // Safari gesture events (trackpad pinch on Safari)
    let gestureScrollLeft = 0;
    let gestureCenterX = 0;

    const handleGestureStart = (e: Event) => {
      e.preventDefault();
      initialZoom = zoom;

      // Capture scroll position and center for zoom-toward-center
      const scrollContainer = scrollRef.current;
      if (scrollContainer) {
        const rect = scrollContainer.getBoundingClientRect();
        gestureScrollLeft = scrollContainer.scrollLeft;
        gestureCenterX = rect.width / 2; // Use viewport center
      }
    };

    const handleGestureChange = (e: Event) => {
      e.preventDefault();
      const gestureEvent = e as unknown as { scale: number };
      const newZoom = Math.max(
        MIN_ZOOM,
        Math.min(MAX_ZOOM, initialZoom * gestureEvent.scale)
      );

      // Zoom toward center
      const scrollContainer = scrollRef.current;
      if (scrollContainer) {
        const oldPps = (containerWidth * initialZoom) / totalDuration;
        const newPps = (containerWidth * newZoom) / totalDuration;

        const centerPxInTrack = gestureCenterX + gestureScrollLeft;
        const timeAtCenter = centerPxInTrack / oldPps;
        const newCenterPx = timeAtCenter * newPps;
        const newScrollLeft = newCenterPx - gestureCenterX;

        scrollContainer.scrollLeft = Math.max(0, newScrollLeft);
      }

      setZoom(newZoom);
    };

    const handleGestureEnd = (e: Event) => {
      e.preventDefault();
    };

    // Wheel handler: Ctrl/Cmd + wheel = zoom toward cursor, plain wheel = horizontal scroll
    const handleWheel = (e: WheelEvent) => {
      const scrollContainer = scrollRef.current;
      if (!scrollContainer) return;

      if (e.ctrlKey || e.metaKey) {
        // Zoom toward cursor position
        e.preventDefault();
        e.stopPropagation();

        // Get cursor position relative to the scroll container
        const rect = scrollContainer.getBoundingClientRect();
        const cursorX = e.clientX - rect.left;
        const scrollLeft = scrollContainer.scrollLeft;

        // Calculate the time position under the cursor (before zoom)
        const cursorPxInTrack = cursorX + scrollLeft;
        const timeAtCursor = cursorPxInTrack / pixelsPerSecond;

        // Calculate new zoom
        const zoomDelta = -e.deltaY * 0.01;
        const newZoom = Math.max(
          MIN_ZOOM,
          Math.min(MAX_ZOOM, zoom * (1 + zoomDelta))
        );

        // Calculate new pixels per second
        const newPixelsPerSecond = (containerWidth * newZoom) / totalDuration;

        // Calculate where the cursor time would be at new zoom
        const newCursorPxInTrack = timeAtCursor * newPixelsPerSecond;

        // Adjust scroll to keep the same time under cursor
        const newScrollLeft = newCursorPxInTrack - cursorX;

        setZoom(newZoom);

        // Apply scroll adjustment after state update
        requestAnimationFrame(() => {
          scrollContainer.scrollLeft = Math.max(0, newScrollLeft);
        });
      } else {
        // Horizontal scroll (plain wheel or shift+wheel)
        // Use deltaX for horizontal scroll, or deltaY if shift is held or deltaX is 0
        const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY;

        if (delta !== 0) {
          e.preventDefault();
          scrollContainer.scrollLeft += delta;
        }
      }
    };

    // Add all listeners with { passive: false } to allow preventDefault
    container.addEventListener("touchstart", handleTouchStart, {
      passive: false,
    });
    container.addEventListener("touchmove", handleTouchMove, {
      passive: false,
    });
    container.addEventListener("touchend", handleTouchEnd);
    container.addEventListener("gesturestart", handleGestureStart, {
      passive: false,
    });
    container.addEventListener("gesturechange", handleGestureChange, {
      passive: false,
    });
    container.addEventListener("gestureend", handleGestureEnd, {
      passive: false,
    });
    container.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
      container.removeEventListener("gesturestart", handleGestureStart);
      container.removeEventListener("gesturechange", handleGestureChange);
      container.removeEventListener("gestureend", handleGestureEnd);
      container.removeEventListener("wheel", handleWheel);
    };
  }, [zoom, pixelsPerSecond, containerWidth, totalDuration]);

  // Check if split is possible (segment selected AND playhead inside that segment)
  const canSplit = (() => {
    if (!selectedId) return false;
    const segment = segments.find((s) => s.id === selectedId);
    if (!segment) return false;
    return currentTime > segment.startTime && currentTime < segment.endTime;
  })();

  // Can add only when outside any segment
  const canAdd = !isInsideSegment();

  // Generate time markers - aim for ~8-15 markers visible at any zoom level
  const generateTimeMarkers = () => {
    const markers: { time: number; px: number }[] = [];

    // Calculate ideal interval to show ~10 markers across the visible width
    const targetMarkerCount = 10;
    const visibleDuration = totalDuration / zoom;
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

    for (let t = 0; t <= totalDuration; t += interval) {
      markers.push({ time: t, px: timeToPx(t) });
    }
    return markers;
  };

  // Display zoom as percentage where 1x = 0%, max = 100%
  const zoomPercent = Math.round(
    ((zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM)) * 100
  );

  return (
    <div
      ref={containerRef}
      className="w-full h-full bg-background border rounded-lg flex flex-col p-2 select-none"
    >
      {/* Toolbar */}
      <div className="flex items-center gap-1 mb-2">
        <Button
          size="sm"
          variant="outline"
          onClick={handleSplit}
          disabled={!canSplit}
          className="h-7 w-7 p-0"
          title="Split segment at playhead"
        >
          <Scissors className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleAdd}
          disabled={!canAdd}
          className="h-7 w-7 p-0"
          title="Add segment at playhead"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>

        <div className="h-4 w-px bg-border mx-1" />

        {/* Zoom controls */}
        <Button
          size="sm"
          variant="outline"
          onClick={handleZoomOut}
          disabled={zoom <= MIN_ZOOM}
          className="h-7 w-7 p-0"
          title="Zoom out"
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <span className="text-xs text-muted-foreground w-10 text-center">
          {zoomPercent}%
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={handleZoomIn}
          disabled={zoom >= MAX_ZOOM}
          className="h-7 w-7 p-0"
          title="Zoom in"
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>

        <div className="flex-1" />

        {/* Delete button - near time display */}
        <Button
          size="sm"
          variant="ghost"
          onClick={handleDelete}
          disabled={!selectedId}
          className="h-7 w-7 p-0 text-red-500 hover:text-red-400 hover:bg-red-500/10 disabled:text-muted-foreground/30"
          title="Delete selected segment"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>

        <span className="text-xs text-muted-foreground font-mono">
          {formatTime(currentTime)} / {formatTime(totalDuration)}
        </span>
      </div>

      {/* Scrollable timeline container */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-x-auto overflow-y-hidden relative"
        style={{ scrollbarWidth: "thin" }}
      >
        {/* Fixed-width track based on duration * pixelsPerSecond */}
        <div
          className="h-full flex flex-col relative"
          style={{ width: `${trackWidth}px`, minWidth: "100%" }}
        >
          {/* Time markers */}
          <div className="h-4 relative shrink-0">
            {generateTimeMarkers().map(({ time, px }) => (
              <span
                key={time}
                className="absolute text-[10px] text-muted-foreground -translate-x-1/2"
                style={{ left: `${px}px` }}
              >
                {formatTime(time)}
              </span>
            ))}
          </div>

          {/* Track */}
          <div
            className="relative flex-1 bg-muted/30 rounded cursor-pointer min-h-0"
            onClick={handleTrackClick}
          >
            {/* Time tick marks */}
            {generateTimeMarkers().map(({ time, px }) => (
              <div
                key={time}
                className="absolute top-0 bottom-0 border-l border-muted-foreground/20 pointer-events-none"
                style={{ left: `${px}px` }}
              />
            ))}

            {/* Segments */}
            {segments.map((segment) => {
              const left = timeToPx(segment.startTime);
              const width = Math.max(
                timeToPx(segment.endTime - segment.startTime),
                4
              );

              return (
                <div
                  key={segment.id}
                  className={cn(
                    "absolute top-1 bottom-1 rounded cursor-pointer transition-colors border-2",
                    selectedId === segment.id
                      ? "bg-blue-600 border-white z-10"
                      : "bg-blue-500/60 border-transparent hover:bg-blue-500/80"
                  )}
                  style={{ left: `${left}px`, width: `${width}px` }}
                  onClick={(e) => handleSegmentClick(e, segment.id)}
                  title={segment.title}
                >
                  {/* Left resize handle */}
                  <div
                    className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize bg-white/0 hover:bg-white/40 rounded-l z-10"
                    onMouseDown={(e) =>
                      handleResizeMouseDown(e, segment.id, "left")
                    }
                  />
                  {/* Right resize handle */}
                  <div
                    className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize bg-white/0 hover:bg-white/40 rounded-r z-10"
                    onMouseDown={(e) =>
                      handleResizeMouseDown(e, segment.id, "right")
                    }
                  />

                  {width > 40 && (
                    <div className="px-3 py-0.5 text-[10px] text-white font-medium truncate pointer-events-none">
                      {segment.title}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Playhead */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-20 pointer-events-none"
              style={{ left: `${timeToPx(currentTime)}px` }}
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
