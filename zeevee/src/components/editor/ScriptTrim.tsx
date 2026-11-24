import { cn } from "@/lib/utils";
import type { TrimEdge } from "@/lib/trimMath";

export type ScriptMenuAction = "clip" | "in" | "out" | "new";

export function SelectionMenuView({
  top,
  left,
  targetNumber,
  canTrim,
  canMoveEdges,
  canCreate,
  seconds,
  onAction,
}: {
  top: number;
  left: number;
  targetNumber: number | null;
  /** Selection overlaps a clip: offer trimming that clip to it. */
  canTrim: boolean;
  /** A clip is selected or overlapped: offer moving one of its edges. */
  canMoveEdges: boolean;
  canCreate: boolean;
  seconds: number;
  onAction: (action: ScriptMenuAction) => void;
}) {
  const btn =
    "px-2 h-7 rounded-md text-xs font-semibold whitespace-nowrap hover:bg-muted";
  return (
    <div
      className="absolute z-30 flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-lg"
      style={{ top, left }}
      // Keep the text selection while clicking the menu
      onMouseDown={(e) => e.preventDefault()}
    >
      <span className="px-1.5 text-[11px] text-muted-foreground tabular-nums">
        {seconds.toFixed(1)}s
      </span>
      {canCreate && (
        <button
          type="button"
          className={cn(btn, "bg-blue-600 text-white hover:bg-blue-500")}
          onClick={() => onAction("new")}
        >
          New clip
        </button>
      )}
      {canTrim && (
        <button type="button" className={cn(btn, "bg-blue-600 text-white hover:bg-blue-500")} onClick={() => onAction("clip")}>
          {targetNumber ? `Trim clip ${targetNumber} to this` : "Trim clip to this"}
        </button>
      )}
      {canMoveEdges && (
        <>
          <button type="button" className={btn} onClick={() => onAction("in")} title="Start the clip on the first selected word">
            {canTrim || !targetNumber ? "Start here" : `Start clip ${targetNumber} here`}
          </button>
          <button type="button" className={btn} onClick={() => onAction("out")} title="End the clip after the last selected word">
            {canTrim || !targetNumber ? "End here" : `End clip ${targetNumber} here`}
          </button>
        </>
      )}
    </div>
  );
}

/** In / Out bracket shown in the script text; drag it onto another word. */
export function CutMarker({
  edge,
  active,
  dragging,
  splitsWord,
  onPointerDown,
}: {
  edge: TrimEdge;
  active: boolean;
  dragging: boolean;
  splitsWord: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <span
      data-cut-marker={edge}
      onPointerDown={onPointerDown}
      contentEditable={false}
      title={
        (edge === "start"
          ? "Clip starts here. Drag onto another word to move the cut."
          : "Clip ends here. Drag onto another word to move the cut.") +
        (splitsWord ? " The cut is part-way through this word." : "")
      }
      className={cn(
        "inline-flex items-center justify-center align-middle select-none cursor-ew-resize touch-none",
        "mx-0.5 h-[1.3em] min-w-[0.9em] px-0.5 rounded-sm text-[0.8em] font-bold leading-none",
        "bg-amber-400 text-zinc-900",
        active && "ring-2 ring-amber-300 ring-offset-1 ring-offset-background",
        dragging && "scale-110",
        splitsWord && "bg-orange-500 text-white",
      )}
    >
      {edge === "start" ? "[" : "]"}
    </span>
  );
}
