import { useSelector, useDispatch } from "react-redux";
import { useCallback, useRef, useEffect, useState } from "react";
import type { RootState } from "@/store/store";
import {
  updateCaptionPosition,
  updateCaptionStyle,
} from "@/store/editorSlice";
import { SNAP_POSITIONS } from "@/remotion/types";
import { CaptionDisplay } from "@/remotion/CaptionDisplay";
import { activeCaptionAt } from "@/remotion/captionTiming";
import { outputFrameForAspect } from "@/remotion/captionGrouping";

interface CaptionOverlayProps {
  currentTime: number;
  segmentStart?: number;
}

const SNAP_THRESHOLD = 8;
export function CaptionOverlay({
  currentTime,
  segmentStart,
}: CaptionOverlayProps) {
  const dispatch = useDispatch();
  const captions = useSelector((state: RootState) => state.editor.captions);
  const captionSettings = useSelector(
    (state: RootState) => state.editor.captionSettings,
  );
  const { enabled, style } = captionSettings;
  const globalFraming = useSelector(
    (state: RootState) => state.editor.globalFraming,
  );
  const frame = outputFrameForAspect(
    globalFraming.enabled && globalFraming.squareTop
      ? "9:16"
      : globalFraming.aspectRatio,
  );
  const transcriptionStatus = useSelector(
    (state: RootState) => state.editor.transcriptionStatus,
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setPreviewSize({ width: rect.width, height: rect.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled]);
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

  // Find the active caption for the current time
  const activeCaption = activeCaptionAt(captions, currentTime);

  if (!enabled) return null;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 10 }}
    >
      {previewSize.width > 0 && previewSize.height > 0 && (
        <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: frame.width,
          height: frame.height,
          transformOrigin: "top left",
          transform: `scale(${previewSize.width / frame.width}, ${previewSize.height / frame.height})`,
        }}
      >
      {!activeCaption && transcriptionStatus === "pending" && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: `${style.position.x}%`,
            top: `${style.position.y}%`,
            transform: "translate(-50%, -50%)",
            width: `${style.maxWidth}%`,
            display: "flex",
            justifyContent: "center",
          }}
        >
          <div
            className="animate-pulse"
            style={{
              display: "inline-block",
              padding: "0.45em 1.2em",
              backgroundColor: style.backgroundColor,
              borderRadius: 6,
              minWidth: "55%",
            }}
          >
            <div
              style={{
                height: `${(style.fontSize / 100) * frame.height * 0.55}px`,
                backgroundColor: "rgba(255,255,255,0.28)",
                borderRadius: 4,
              }}
            />
          </div>
        </div>
      )}

      <CaptionDisplay
        captions={captions}
        settings={captionSettings}
        currentTime={currentTime}
        containerHeight={frame.height}
        segmentStart={segmentStart}
      >
        <div
          className="absolute inset-0 pointer-events-auto cursor-move"
          onMouseDown={onDragStart}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          {(isHovered || isDragging) && (
            <div className="absolute inset-0 ring-2 ring-green-500 rounded pointer-events-none" />
          )}
          {(isHovered || isResizing) && (
            <>
              <div
                className="absolute -bottom-1 -right-1 w-2.5 h-2.5 bg-green-500 rounded-full cursor-nwse-resize"
                onMouseDown={(e) => onResizeStart(e, "bottom-right")}
              />
              <div
                className="absolute -bottom-1 -left-1 w-2.5 h-2.5 bg-green-500 rounded-full cursor-nesw-resize"
                onMouseDown={(e) => onResizeStart(e, "bottom-left")}
              />
              <div
                className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-green-500 rounded-full cursor-nesw-resize"
                onMouseDown={(e) => onResizeStart(e, "top-right")}
              />
              <div
                className="absolute -top-1 -left-1 w-2.5 h-2.5 bg-green-500 rounded-full cursor-nwse-resize"
                onMouseDown={(e) => onResizeStart(e, "top-left")}
              />
            </>
          )}
        </div>
      </CaptionDisplay>
        </div>
      )}
    </div>
  );
}
