import { useCallback, useMemo, useRef } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  formatWindowAspect,
  snapsForCanvas,
  type ZoomSnap,
} from "@/lib/zoomMath";

/** Half the thumb height — keeps the handle inside the bar at both ends. */
const THUMB_INSET_PX = 7;

function snapZoom(raw: number, snaps: ZoomSnap[]): number {
  if (snaps.length === 0) return raw;

  let nearest = 0;
  let nearestDist = Infinity;
  for (let i = 0; i < snaps.length; i++) {
    const dist = Math.abs(raw - snaps[i].zoom);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = i;
    }
  }

  const zoom = snaps[nearest].zoom;
  const prev = nearest > 0 ? snaps[nearest - 1].zoom : 0;
  const next = nearest < snaps.length - 1 ? snaps[nearest + 1].zoom : 1;
  const threshold = Math.max(
    0.02,
    Math.min(0.05, Math.min(zoom - prev, next - zoom) * 0.45),
  );
  return nearestDist <= threshold ? zoom : raw;
}

interface ZoomSliderProps {
  value: number;
  canvasAspect: number;
  sourceAspect: number;
  onChange: (zoom: number) => void;
  disabled?: boolean;
}

export function ZoomSlider({
  value,
  canvasAspect,
  sourceAspect,
  onChange,
  disabled = false,
}: ZoomSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const snaps = useMemo(
    () => snapsForCanvas(canvasAspect, sourceAspect),
    [canvasAspect, sourceAspect],
  );
  const activeIndex = snaps.findIndex((s) => Math.abs(s.zoom - value) < 0.01);
  const liveAspect = formatWindowAspect(value, canvasAspect, sourceAspect);

  const valueFromClientY = useCallback(
    (clientY: number) => {
      const track = trackRef.current;
      if (!track) return value;
      const rect = track.getBoundingClientRect();
      if (rect.height <= 0) return value;
      const raw = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      return snapZoom(raw, snaps);
    },
    [snaps, value],
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    onChange(valueFromClientY(e.clientY));
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    onChange(valueFromClientY(e.clientY));
  };

  const tooltipText = disabled
    ? "Turn off Square Top to adjust framing"
    : `Window ${liveAspect}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            "relative flex h-full min-h-0 w-full select-none overflow-visible",
            disabled && "pointer-events-none opacity-40",
          )}
          style={{ paddingTop: THUMB_INSET_PX, paddingBottom: THUMB_INSET_PX }}
        >
          <div className="relative min-w-0 flex-1">
            {snaps.map((snap, i) => (
              <button
                key={snap.label}
                type="button"
                disabled={disabled}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onChange(snap.zoom);
                }}
                className={cn(
                  "absolute right-1.5 text-sm font-semibold leading-none tabular-nums tracking-wide whitespace-nowrap",
                  "transition-colors hover:text-foreground",
                  i === activeIndex
                    ? "text-foreground font-medium"
                    : "text-zinc-500",
                )}
                style={{ top: `${snap.zoom * 100}%`, transform: "translateY(-50%)" }}
              >
                {snap.label}
              </button>
            ))}
          </div>

          <div
            ref={trackRef}
            className={cn(
              "relative h-full w-4 shrink-0 touch-none",
              disabled ? "cursor-not-allowed" : "cursor-ns-resize",
            )}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
            role="slider"
            aria-label="Zoom"
            aria-orientation="vertical"
            aria-disabled={disabled}
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={value}
            aria-valuetext={liveAspect}
          >
            <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 rounded-full bg-zinc-600/80" />

            {snaps.map((snap, i) => (
              <div
                key={snap.label}
                className="pointer-events-none absolute left-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{ top: `${snap.zoom * 100}%` }}
              >
                <div
                  className={cn(
                    "h-1 w-1 rounded-full",
                    i === activeIndex ? "bg-white" : "bg-zinc-500",
                  )}
                />
              </div>
            ))}

            <div
              className="pointer-events-none absolute left-1/2 z-[2] h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_3px_rgba(24,24,27,0.9),0_1px_4px_rgba(0,0,0,0.45)]"
              style={{ top: `${value * 100}%` }}
            />
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent side="left">{tooltipText}</TooltipContent>
    </Tooltip>
  );
}
