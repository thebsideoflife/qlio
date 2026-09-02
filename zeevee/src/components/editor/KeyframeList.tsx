import { useSelector, useDispatch } from "react-redux";
import type { RootState } from "@/store/store";
import {
  selectKeyframe,
  addFramingKeyframe,
  updateFramingKeyframe,
  removeFramingKeyframe,
} from "@/store/editorSlice";
import { getEffectiveKeyframes } from "@/remotion/types";
import type { FramingKeyframe } from "@/remotion/types";
import {
  frameToTime,
} from "@/remotion/framingInterpolation";
import {
  segmentFrameBounds,
  sourceTimeToClipFrame,
  storedTimeToClipFrame,
} from "@/remotion/segmentFrameBounds";
import { X, Plus, MoveHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

function getZoomLabel(zoom: number): string {
  if (zoom >= 0.9) return "Tight";
  if (zoom >= 0.6) return "Med";
  if (zoom >= 0.3) return "Wide";
  return "Fit";
}

function formatFrameLabel(
  time: number,
  startSec: number,
  fps: number | null,
): string {
  if (fps != null && fps > 0) {
    return `f${storedTimeToClipFrame(time, startSec, fps)}`;
  }
  return `${time.toFixed(1)}s`;
}

export function KeyframeList() {
  const dispatch = useDispatch();
  const selectedSegmentId = useSelector(
    (state: RootState) => state.editor.selectedSegmentId,
  );
  const selectedKeyframeId = useSelector(
    (state: RootState) => state.editor.selectedKeyframeId,
  );
  const sourceFps = useSelector((state: RootState) => state.editor.sourceFps);
  const currentTime = useSelector((state: RootState) => state.editor.currentTime);
  const segment = useSelector((state: RootState) =>
    state.editor.segments.find((s) => s.id === selectedSegmentId),
  );

  if (!segment || !segment.framing) return null;

  const keyframes = getEffectiveKeyframes(segment.framing);
  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  const bounds =
    sourceFps != null && sourceFps > 0
      ? segmentFrameBounds(segment.startTime, segment.endTime, sourceFps)
      : null;

  const playheadInSegment =
    currentTime >= segment.startTime && currentTime < segment.endTime;
  const cutFrame =
    sourceFps != null && sourceFps > 0
      ? sourceTimeToClipFrame(currentTime, segment.startTime, sourceFps)
      : null;
  const cutTime =
    cutFrame != null && sourceFps != null
      ? frameToTime(cutFrame, sourceFps)
      : currentTime - segment.startTime;
  const canPlaceAtPlayhead =
    playheadInSegment &&
    bounds != null &&
    cutFrame != null &&
    cutFrame >= 1 &&
    cutFrame <= bounds.durationInFrames - 1 &&
    !sorted.some(
      (kf) =>
        sourceFps != null &&
        storedTimeToClipFrame(kf.time, segment.startTime, sourceFps) ===
          cutFrame,
    );

  const selectedKeyframe = sorted.find((kf) => kf.id === selectedKeyframeId);
  const selectedIsInterior =
    !!selectedKeyframe && sorted[0]?.id !== selectedKeyframe.id;
  const canMoveSelected =
    selectedIsInterior &&
    playheadInSegment &&
    bounds != null &&
    cutFrame != null &&
    sourceFps != null &&
    cutFrame >= 1 &&
    cutFrame <= bounds.durationInFrames - 1 &&
    !sorted.some(
      (kf) =>
        kf.id !== selectedKeyframe!.id &&
        storedTimeToClipFrame(kf.time, segment.startTime, sourceFps) ===
          cutFrame,
    );

  const handleAddAtPlayhead = () => {
    if (!canPlaceAtPlayhead) return;
    const sourceKf =
      [...sorted]
        .reverse()
        .find(
          (k) =>
            sourceFps != null &&
            storedTimeToClipFrame(k.time, segment.startTime, sourceFps) <=
              (cutFrame ?? 0),
        ) || sorted[0];
    const newKeyframe: FramingKeyframe = {
      id: crypto.randomUUID(),
      time: cutTime,
      focusX: sourceKf.focusX,
      focusY: sourceKf.focusY,
      zoom: sourceKf.zoom,
      isAiGenerated: false,
    };
    dispatch(
      addFramingKeyframe({ segmentId: segment.id, keyframe: newKeyframe }),
    );
  };

  const handleMoveSelected = () => {
    if (!canMoveSelected || !selectedKeyframe) return;
    dispatch(
      updateFramingKeyframe({
        segmentId: segment.id,
        keyframeId: selectedKeyframe.id,
        changes: { time: cutTime },
      }),
    );
  };

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
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
            <span>{formatFrameLabel(kf.time, segment.startTime, sourceFps)}</span>
            <span className="text-muted-foreground font-normal">
              {getZoomLabel(kf.zoom)}
            </span>
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

      <button
        onClick={handleAddAtPlayhead}
        disabled={!canPlaceAtPlayhead}
        className={cn(
          "flex items-center gap-1 px-2 h-6 rounded-md border text-[10px] font-semibold transition-all",
          canPlaceAtPlayhead
            ? "border-dashed border-blue-500/50 text-blue-400 hover:bg-blue-500/10"
            : "border-dashed border-border text-muted-foreground/50 cursor-not-allowed",
        )}
        title={
          sourceFps == null
            ? "Detecting frame rate…"
            : !playheadInSegment
              ? "Move the playhead into this segment"
              : canPlaceAtPlayhead
                ? `Add cut at frame ${cutFrame}`
                : "Playhead already has a cut"
        }
      >
        <Plus className="h-3 w-3" />
        Add cut
        {cutFrame != null && playheadInSegment ? ` f${cutFrame}` : ""}
      </button>

      <button
        onClick={handleMoveSelected}
        disabled={!canMoveSelected}
        className={cn(
          "flex items-center gap-1 px-2 h-6 rounded-md border text-[10px] font-semibold transition-all",
          canMoveSelected
            ? "border-dashed border-blue-500/50 text-blue-400 hover:bg-blue-500/10"
            : "border-dashed border-border text-muted-foreground/50 cursor-not-allowed",
        )}
        title={
          !selectedIsInterior
            ? "Select an interior cut to move"
            : canMoveSelected
              ? `Move selected cut to frame ${cutFrame}`
              : "Cannot move cut to this frame"
        }
      >
        <MoveHorizontal className="h-3 w-3" />
        Move here
      </button>

      <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
        {sorted.length}
      </span>
    </div>
  );
}
