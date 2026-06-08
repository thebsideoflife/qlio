import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
} from "lucide-react";

interface FramingSliderProps {
  orientation: "horizontal" | "vertical";
  value: number; // 0-1
  aspectRatio: number;
  onChange: (value: number) => void;
}

export function FramingSlider({
  orientation,
  value,
  aspectRatio,
  onChange,
}: FramingSliderProps) {
  const isHorizontal = orientation === "horizontal";

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const bar = e.currentTarget as HTMLElement;
    const rect = bar.getBoundingClientRect();

    const updatePosition = (clientX: number, clientY: number) => {
      let newValue: number;
      if (isHorizontal) {
        newValue = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      } else {
        newValue = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      }

      // Snap to center (0.5) if within 0.05 range
      if (Math.abs(newValue - 0.5) < 0.05) {
        newValue = 0.5;
      }

      onChange(newValue);
    };

    updatePosition(e.clientX, e.clientY);

    const onMove = (ev: MouseEvent) => updatePosition(ev.clientX, ev.clientY);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(0.5);
  };

  const trackSize = isHorizontal ? "w-48 h-5" : "w-5 h-48";
  const handleInset = isHorizontal ? "top-1 bottom-1" : "left-1 right-1";

  return (
    <div
      className={
        isHorizontal
          ? "absolute bottom-3 left-1/2 -translate-x-1/2 pointer-events-auto"
          : "absolute right-3 top-1/2 -translate-y-1/2 pointer-events-auto"
      }
      onMouseDown={(e) => e.stopPropagation()}
      title={`Drag to adjust ${
        isHorizontal ? "horizontal" : "vertical"
      } position\nDouble-click to center`}
    >
      <div
        className={`relative rounded-full border border-zinc-600/90 bg-zinc-900/85 backdrop-blur-sm shadow-lg hover:border-zinc-500 transition-colors overflow-hidden ${trackSize} ${
          isHorizontal ? "cursor-ew-resize" : "cursor-ns-resize"
        }`}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
      >
        {/* Inset groove — visible slot the handle travels in */}
        <div className="absolute inset-[3px] rounded-full bg-black/50 shadow-[inset_0_1px_4px_rgba(0,0,0,0.55)] ring-1 ring-inset ring-white/10 pointer-events-none" />

        {/* Direction hints at track ends */}
        {isHorizontal ? (
          <>
            <ChevronLeft className="absolute left-0.5 top-1/2 -translate-y-1/2 h-3 w-3 text-zinc-500/90 pointer-events-none" />
            <ChevronRight className="absolute right-0.5 top-1/2 -translate-y-1/2 h-3 w-3 text-zinc-500/90 pointer-events-none" />
          </>
        ) : (
          <>
            <ChevronUp className="absolute top-0.5 left-1/2 -translate-x-1/2 h-3 w-3 text-zinc-500/90 pointer-events-none" />
            <ChevronDown className="absolute bottom-0.5 left-1/2 -translate-x-1/2 h-3 w-3 text-zinc-500/90 pointer-events-none" />
          </>
        )}

        {/* Center snap indicator line */}
        <div
          className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white/40 pointer-events-none z-[1] ${
            isHorizontal ? "w-px h-full" : "w-full h-px"
          }`}
        />

        {/* Proportional block - represents the viewport window */}
        <div
          className={`absolute z-10 rounded-full bg-white shadow-md border border-zinc-300/80 flex items-center justify-center overflow-hidden ${handleInset}`}
          style={
            isHorizontal
              ? {
                  width: `${aspectRatio * 100}%`,
                  left: `${value * 100}%`,
                  transform: `translateX(-${value * 100}%)`,
                }
              : {
                  height: `${aspectRatio * 100}%`,
                  top: `${value * 100}%`,
                  transform: `translateY(-${value * 100}%)`,
                }
          }
        >
          {isHorizontal ? (
            <div className="flex items-center gap-px text-zinc-500 pointer-events-none">
              <ChevronLeft className="h-2.5 w-2.5 shrink-0" strokeWidth={2.5} />
              <ChevronRight className="h-2.5 w-2.5 shrink-0" strokeWidth={2.5} />
            </div>
          ) : (
            <div className="flex flex-col items-center gap-px text-zinc-500 pointer-events-none">
              <ChevronUp className="h-2.5 w-2.5 shrink-0" strokeWidth={2.5} />
              <ChevronDown className="h-2.5 w-2.5 shrink-0" strokeWidth={2.5} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
