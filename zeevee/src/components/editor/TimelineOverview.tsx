import { useRef } from "react";
import { cn } from "@/lib/utils";

export interface OverviewSegment {
  id: string;
  /** Fractions of the whole timeline (0..1). */
  from: number;
  to: number;
  selected: boolean;
}

interface TimelineOverviewProps {
  segments: OverviewSegment[];
  playhead: number;
  /** Part of the timeline visible in the track below, as fractions. */
  viewport: { from: number; to: number };
  /** Window shown in the trim lens, if open. */
  lens: { from: number; to: number } | null;
  /** Move the visible window so it starts at `from` (fraction). */
  onViewportChange: (from: number) => void;
}

/**
 * Whole-video strip above the track. The outlined box is what the track shows;
 * drag it, or click anywhere, to jump there. Always shows the full length, so
 * the material outside the clips ("the wings") is one click away at any zoom.
 */
export function TimelineOverview({
  segments,
  playhead,
  viewport,
  lens,
  onViewportChange,
}: TimelineOverviewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const grabRef = useRef<number | null>(null);
  const width = Math.max(0, Math.min(1, viewport.to) - Math.max(0, viewport.from));
  const showViewport = width < 0.995;

  const fractionAt = (clientX: number) => {
    const rect = ref.current!.getBoundingClientRect();
    return (clientX - rect.left) / Math.max(1, rect.width);
  };

  const move = (clientX: number) => {
    const grab = grabRef.current ?? width / 2;
    const from = Math.max(0, Math.min(1 - width, fractionAt(clientX) - grab));
    onViewportChange(from);
  };

  return (
    <div
      ref={ref}
      className="relative h-4 mx-6 mr-3 mb-1 rounded-sm bg-secondary/60 dark:bg-zinc-800/50 cursor-pointer touch-none"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const f = fractionAt(e.clientX);
        const inside = f >= viewport.from && f <= viewport.to;
        grabRef.current = inside ? f - viewport.from : width / 2;
        move(e.clientX);
      }}
      onPointerMove={(e) => {
        if (grabRef.current == null) return;
        move(e.clientX);
      }}
      onPointerUp={() => (grabRef.current = null)}
      onPointerCancel={() => (grabRef.current = null)}
      title="Whole video — drag or click to move the timeline view"
    >
      {segments.map((s) => (
        <div
          key={s.id}
          className={cn(
            "absolute top-[3px] bottom-[3px] rounded-[1px] pointer-events-none",
            s.selected ? "bg-blue-400" : "bg-blue-600/70",
          )}
          style={{
            left: `${s.from * 100}%`,
            width: `max(2px, ${(s.to - s.from) * 100}%)`,
          }}
        />
      ))}

      {lens && (
        <div
          className="absolute -top-px -bottom-px border border-amber-400 bg-amber-400/20 rounded-[2px] pointer-events-none"
          style={{
            left: `${lens.from * 100}%`,
            width: `max(3px, ${(lens.to - lens.from) * 100}%)`,
          }}
        />
      )}

      {showViewport && (
        <div
          className="absolute -top-0.5 -bottom-0.5 rounded-[3px] border-2 border-foreground/60 bg-foreground/5 cursor-grab active:cursor-grabbing pointer-events-none"
          style={{
            left: `${Math.max(0, viewport.from) * 100}%`,
            width: `max(6px, ${width * 100}%)`,
          }}
        />
      )}

      <div
        className="absolute -top-0.5 -bottom-0.5 w-px bg-red-500 pointer-events-none"
        style={{ left: `${Math.max(0, Math.min(1, playhead)) * 100}%` }}
      />
    </div>
  );
}
