import { useSelector, useDispatch } from "react-redux";
import { useState, useCallback, useRef, useEffect } from "react";
import type { RootState } from "@/store/store";
import { updateCaptionPosition, updateCaptionStyle } from "@/store/editorSlice";
import { SNAP_POSITIONS } from "@/remotion/types";
import { CaptionDisplay } from "./CaptionDisplay";

interface CaptionOverlayProps {
  currentTime: number;
}

const SNAP_THRESHOLD = 8;

export function CaptionOverlay({ currentTime }: CaptionOverlayProps) {
  const dispatch = useDispatch();
  const captions = useSelector((state: RootState) => state.editor.captions);
  const { enabled, style } = useSelector(
    (state: RootState) => state.editor.captionSettings,
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [initialPos, setInitialPos] = useState({ x: 0, y: 0 });
  const [initialSize, setInitialSize] = useState(0);
  const [resizeDirection, setResizeDirection] = useState({ x: 1, y: 1 });

  // Snap helper
  const findSnap = useCallback((x: number, y: number) => {
    for (const snap of SNAP_POSITIONS) {
      if (
        Math.abs(x - snap.x) < SNAP_THRESHOLD &&
        Math.abs(y - snap.y) < SNAP_THRESHOLD
      ) {
        return { x: snap.x, y: snap.y };
      }
    }
    return null;
  }, []);

  // Drag start
  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(true);
      setDragStart({ x: e.clientX, y: e.clientY });
      setInitialPos({ x: style.position.x, y: style.position.y });
    },
    [style.position],
  );

  // Resize start - detect which corner
  const onResizeStart = useCallback(
    (e: React.MouseEvent, corner: string) => {
      e.preventDefault();
      e.stopPropagation();
      setIsResizing(true);
      setDragStart({ x: e.clientX, y: e.clientY });
      setInitialSize(style.fontSize);

      // Set direction based on corner
      // For bottom-right: drag out (away from center) = grow
      const directions: Record<string, { x: number; y: number }> = {
        "bottom-right": { x: 1, y: 1 },
        "bottom-left": { x: -1, y: 1 },
        "top-right": { x: 1, y: -1 },
        "top-left": { x: -1, y: -1 },
      };
      setResizeDirection(directions[corner] || { x: 1, y: 1 });
    },
    [style.fontSize],
  );

  // Global mouse handlers
  useEffect(() => {
    if (!isDragging && !isResizing) return;

    const onMove = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();

      if (isDragging) {
        const dx = ((e.clientX - dragStart.x) / rect.width) * 100;
        const dy = ((e.clientY - dragStart.y) / rect.height) * 100;
        let x = Math.max(10, Math.min(90, initialPos.x + dx));
        let y = Math.max(10, Math.min(90, initialPos.y + dy));
        const snap = findSnap(x, y);
        if (snap) {
          x = snap.x;
          y = snap.y;
        }
        dispatch(updateCaptionPosition({ x, y }));
      } else if (isResizing) {
        // Calculate distance from drag start
        const deltaX = (e.clientX - dragStart.x) * resizeDirection.x;
        const deltaY = (e.clientY - dragStart.y) * resizeDirection.y;
        const delta = Math.max(deltaX, deltaY); // Use the larger movement

        // Positive delta = drag out = grow
        const size = Math.max(3, Math.min(8, initialSize + delta * 0.02));
        dispatch(updateCaptionStyle({ fontSize: Math.round(size * 10) / 10 }));
      }
    };

    const onUp = () => {
      setIsDragging(false);
      setIsResizing(false);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [
    isDragging,
    isResizing,
    dragStart,
    initialPos,
    initialSize,
    resizeDirection,
    findSnap,
    dispatch,
  ]);

  useEffect(() => {
    if (containerRef.current)
      setContainerHeight(containerRef.current.offsetHeight);
  }, []);

  if (!enabled) return null;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 10 }}
      onMouseDown={onDragStart}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <CaptionDisplay
        captions={captions}
        settings={{ enabled, style }}
        currentTime={currentTime}
        containerHeight={containerHeight}
      >
        {/* Drag ring + resize handles */}
        {(isHovered || isDragging) && (
          <div className="absolute inset-0 ring-2 ring-green-500 rounded pointer-events-none" />
        )}
        {(isHovered || isResizing) && (
          <>
            <div
              className="absolute -bottom-1 -right-1 w-2.5 h-2.5 bg-green-500 rounded-full cursor-nwse-resize pointer-events-auto"
              onMouseDown={(e) => onResizeStart(e, "bottom-right")}
            />
            <div
              className="absolute -bottom-1 -left-1 w-2.5 h-2.5 bg-green-500 rounded-full cursor-nesw-resize pointer-events-auto"
              onMouseDown={(e) => onResizeStart(e, "bottom-left")}
            />
            <div
              className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-green-500 rounded-full cursor-nesw-resize pointer-events-auto"
              onMouseDown={(e) => onResizeStart(e, "top-right")}
            />
            <div
              className="absolute -top-1 -left-1 w-2.5 h-2.5 bg-green-500 rounded-full cursor-nwse-resize pointer-events-auto"
              onMouseDown={(e) => onResizeStart(e, "top-left")}
            />
          </>
        )}
      </CaptionDisplay>
    </div>
  );
}
