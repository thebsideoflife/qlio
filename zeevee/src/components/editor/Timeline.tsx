import { useRef } from "react";
import { useSelector, useDispatch } from "react-redux";
import type { RootState } from "@/store/store";
import { selectSegment } from "@/store/editorSlice";
import { cn } from "@/lib/utils";

export function Timeline() {
  const dispatch = useDispatch();
  const segments = useSelector((state: RootState) => state.editor.segments);
  const selectedId = useSelector(
    (state: RootState) => state.editor.selectedSegmentId
  );
  const duration = useSelector((state: RootState) => state.editor.duration);

  // Use real duration, or fallback to 10 mins (600s) if 0 to avoid division by zero
  const totalDuration = duration > 0 ? duration : 600;

  const trackRef = useRef<HTMLDivElement>(null);

  const getLeftPercent = (time: number) => (time / totalDuration) * 100;
  const getWidthPercent = (start: number, end: number) =>
    ((end - start) / totalDuration) * 100;

  const handleMouseDown = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    dispatch(selectSegment(id));
  };

  const formatTime = (seconds: number) => {
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60);
      return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="w-full h-32 bg-background border rounded-lg flex flex-col p-4 select-none">
      <div className="flex justify-between text-xs text-muted-foreground mb-2 px-1">
        <span>0:00</span>
        <span>{formatTime(totalDuration * 0.25)}</span>
        <span>{formatTime(totalDuration * 0.5)}</span>
        <span>{formatTime(totalDuration * 0.75)}</span>
        <span>{formatTime(totalDuration)}</span>
      </div>

      <div
        className="relative flex-1 bg-muted/30 rounded overflow-hidden"
        ref={trackRef}
      >
        {/* Time ticks */}
        {[...Array(9)].map((_, i) => (
          <div
            key={i}
            className="absolute top-0 bottom-0 border-l border-muted-foreground/10"
            style={{ left: `${(i + 1) * 10}%` }}
          />
        ))}

        {/* Segments */}
        {segments.map((segment) => (
          <div
            key={segment.id}
            className={cn(
              "absolute top-2 bottom-2 rounded cursor-pointer transition-colors border-2",
              selectedId === segment.id
                ? "bg-blue-600 border-white z-10"
                : "bg-blue-500/60 border-transparent hover:bg-blue-500/80"
            )}
            style={{
              left: `${getLeftPercent(segment.startTime)}%`,
              width: `${Math.max(getWidthPercent(segment.startTime, segment.endTime), 0.5)}%`, // Min width
            }}
            onMouseDown={(e) => handleMouseDown(e, segment.id)}
            title={segment.title}
          >
            {/* Drag Handles (Visual only for MVP) */}
            <div className="absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize bg-white/20 hover:bg-white/50" />
            <div className="absolute right-0 top-0 bottom-0 w-1 cursor-ew-resize bg-white/20 hover:bg-white/50" />

            <div className="px-2 py-1 text-[10px] text-white font-medium truncate">
              {segment.title}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
