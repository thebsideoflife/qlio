import { useSelector, useDispatch } from "react-redux";
import type { RootState } from "@/store/store";
import {
  selectKeyframe,
  addFramingKeyframe,
  removeFramingKeyframe,
} from "@/store/editorSlice";
import { getEffectiveKeyframes } from "@/remotion/types";
import type { FramingKeyframe } from "@/remotion/types";
import { X, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

function getZoomLabel(zoom: number): string {
  if (zoom >= 0.9) return "Tight";
  if (zoom >= 0.6) return "Med";
  if (zoom >= 0.3) return "Wide";
  return "Fit";
}

export function KeyframeList() {
  const dispatch = useDispatch();
  const selectedSegmentId = useSelector(
    (state: RootState) => state.editor.selectedSegmentId,
  );
  const selectedKeyframeId = useSelector(
    (state: RootState) => state.editor.selectedKeyframeId,
  );
  const segment = useSelector((state: RootState) =>
    state.editor.segments.find((s) => s.id === selectedSegmentId),
  );

  if (!segment || !segment.framing) return null;

  const keyframes = getEffectiveKeyframes(segment.framing);
  const segmentDuration = segment.endTime - segment.startTime;
  const isShortSegment = segmentDuration < 5;

  const sorted = [...keyframes].sort((a, b) => a.time - b.time);

  const handleAddKeyframe = () => {
    if (isShortSegment) return;

    const lastKf = sorted[sorted.length - 1];
    let time = segmentDuration / 2;
    const existingTimes = sorted.map((kf) => kf.time);
    while (existingTimes.some((t) => Math.abs(t - time) < 0.5)) {
      time += 0.5;
      if (time >= segmentDuration) {
        time = segmentDuration - 0.5;
        break;
      }
    }

    const newKeyframe: FramingKeyframe = {
      id: crypto.randomUUID(),
      time: Math.max(0.1, Math.min(time, segmentDuration - 0.1)),
      focusX: lastKf.focusX,
      focusY: lastKf.focusY,
      zoom: lastKf.zoom,
      isAiGenerated: false,
    };

    dispatch(
      addFramingKeyframe({ segmentId: segment.id, keyframe: newKeyframe }),
    );
  };

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mr-1 shrink-0">
        KF
      </span>

      {sorted.map((kf, idx) => {
        const isFirst = idx === 0;
        const isSelected =
          selectedKeyframeId === kf.id ||
          (!selectedKeyframeId && idx === 0);

        return (
          <button
            key={kf.id}
            className={cn(
              "flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-mono font-semibold transition-all border cursor-pointer",
              isSelected
                ? "bg-blue-500/15 border-blue-500/40 text-foreground"
                : "bg-muted/30 border-transparent hover:bg-muted/50 text-muted-foreground hover:text-foreground",
            )}
            onClick={() => dispatch(selectKeyframe(kf.id))}
          >
            <div
              className={cn(
                "w-1.5 h-1.5 rounded-full shrink-0",
                kf.isAiGenerated ? "bg-purple-400" : "bg-blue-400",
              )}
            />
            <span>{kf.time.toFixed(1)}s</span>
            <span className="text-muted-foreground font-normal">{getZoomLabel(kf.zoom)}</span>
            {!isFirst && isSelected && (
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch(
                    removeFramingKeyframe({
                      segmentId: segment.id,
                      keyframeId: kf.id,
                    }),
                  );
                }}
                className="ml-0.5 hover:text-red-400 transition-colors"
              >
                <X className="h-3 w-3" />
              </span>
            )}
          </button>
        );
      })}

      {/* Add keyframe */}
      {!isShortSegment && sorted.length < 4 && (
        <button
          onClick={handleAddKeyframe}
          className="flex items-center justify-center w-6 h-6 rounded-md border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-blue-500/50 transition-all"
          title="Add keyframe"
        >
          <Plus className="h-3 w-3" />
        </button>
      )}

      <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
        {sorted.length}/4
      </span>
    </div>
  );
}
