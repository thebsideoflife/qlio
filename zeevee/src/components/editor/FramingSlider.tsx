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
        className={`bg-black/40 backdrop-blur-sm rounded-full relative hover:bg-black/50 transition-colors overflow-hidden shadow-lg ${
          isHorizontal
            ? "w-48 h-4 cursor-ew-resize"
            : "w-4 h-48 cursor-ns-resize"
        }`}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
      >
        {/* Center snap indicator line */}
        <div
          className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white/50 ${
            isHorizontal ? "w-px h-6" : "w-6 h-px"
          }`}
        />

        {/* Proportional block - represents the viewport window */}
        <div
          className={`absolute bg-white rounded-full shadow-md ${
            isHorizontal ? "top-0.5 bottom-0.5" : "left-0.5 right-0.5"
          }`}
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
        />
      </div>
    </div>
  );
}
