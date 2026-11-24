import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X as CloseIcon } from "lucide-react";
import type { CaptionWord } from "@/remotion/types";
import { cn } from "@/lib/utils";
import {
  edgeFrames,
  formatFrameTimecode,
  frameDisplayTime,
  lensWindowStart,
  nudgeEdge,
  parseFrameTimecode,
  setEdgeTime,
  type TrimEdge,
} from "@/lib/trimMath";

/** Lens window lengths in seconds. */
const SPANS = [2, 5, 10, 30] as const;
const DEFAULT_SPAN = 10;
/** Recenter once the edge leaves the middle of the window. */
const RECENTER_MARGIN = 0.15;
const PAN_THRESHOLD_PX = 3;

interface LensSegment {
  id: string;
  startTime: number;
  endTime: number;
}

export interface TrimLensProps {
  segment: LensSegment;
  segments: LensSegment[];
  edge: TrimEdge;
  fps: number | null;
  totalDuration: number;
  currentTime: number;
  videoSrc: string | null;
  words: CaptionWord[];
  onEdgeChange: (edge: TrimEdge) => void;
  /** Live trim; the timeline applies it and moves the viewer to the edge. */
  onTrim: (start: number, end: number, edge: TrimEdge) => void;
  /** End of one trim gesture (drag released, nudge, typed timecode). */
  onTrimCommit: () => void;
  onSeek: (time: number) => void;
  onClose: () => void;
  /** Reports the seconds shown in the lens (for the overview strip). */
  onWindowChange?: (from: number, to: number) => void;
}

/** "1:05" for whole seconds, "1:05.5" for half seconds, with hours when needed. */
function rulerLabel(t: number): string {
  const whole = Math.floor(t + 1e-6);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const sec = (whole % 60).toString().padStart(2, "0");
  const half = t - whole > 0.25 ? ".5" : "";
  return h > 0 ? `${h}:${m.toString().padStart(2, "0")}:${sec}${half}` : `${m}:${sec}${half}`;
}

function FramePreview({
  src,
  time,
  label,
  timecode,
  emphasis,
}: {
  src: string | null;
  time: number | null;
  label: string;
  timecode: string;
  emphasis: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video || time == null) return;
    const seek = () => {
      if (Math.abs(video.currentTime - time) > 1e-4) video.currentTime = time;
    };
    if (video.readyState >= 1) {
      seek();
      return;
    }
    video.addEventListener("loadedmetadata", seek, { once: true });
    return () => video.removeEventListener("loadedmetadata", seek);
  }, [time, src]);

  return (
    <div className="flex flex-col gap-0.5 shrink-0">
      <span className="text-[10px] text-muted-foreground leading-none">{label}</span>
      <div
        className={cn(
          "relative w-[136px] h-[76px] rounded bg-black overflow-hidden",
          emphasis ? "ring-2 ring-amber-400" : "ring-1 ring-border",
        )}
      >
        {src && time != null ? (
          <video
            ref={ref}
            src={src}
            muted
            playsInline
            preload="auto"
            className="w-full h-full object-contain pointer-events-none"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-zinc-500">
            No frame
          </div>
        )}
      </div>
      <span className="text-[10px] font-mono tabular-nums text-muted-foreground leading-none">
        {timecode}
      </span>
    </div>
  );
}

/**
 * Magnified, frame-accurate view of one segment edge. Shows a few seconds
 * around the cut with every frame marked, the frames on each side of the cut,
 * nudge buttons and a timecode field.
 */
export function TrimLens({
  segment,
  segments,
  edge,
  fps,
  totalDuration,
  currentTime,
  videoSrc,
  words,
  onEdgeChange,
  onTrim,
  onTrimCommit,
  onSeek,
  onClose,
  onWindowChange,
}: TrimLensProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [stripWidth, setStripWidth] = useState(600);
  const [span, setSpan] = useState<number>(DEFAULT_SPAN);
  const edgeTime = edge === "start" ? segment.startTime : segment.endTime;
  const [viewStart, setViewStart] = useState(() =>
    lensWindowStart(edgeTime, DEFAULT_SPAN, totalDuration),
  );
  const draggingRef = useRef(false);
  const [timecodeDraft, setTimecodeDraft] = useState<string | null>(null);
  const [timecodeError, setTimecodeError] = useState(false);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const update = () => setStripWidth(Math.max(1, el.clientWidth));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the edge in view: recenter when switching edge/segment/span, or when
  // the edge drifts out of the middle (main-track drag, nudges, typed time).
  useEffect(() => {
    setViewStart(lensWindowStart(edgeTime, span, totalDuration));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment.id, edge, span]);
  useEffect(() => {
    if (draggingRef.current) return;
    setViewStart((v) => {
      const lo = v + span * RECENTER_MARGIN;
      const hi = v + span * (1 - RECENTER_MARGIN);
      return edgeTime < lo || edgeTime > hi
        ? lensWindowStart(edgeTime, span, totalDuration)
        : v;
    });
  }, [edgeTime, span, totalDuration]);

  useEffect(() => {
    onWindowChange?.(viewStart, viewStart + span);
  }, [viewStart, span, onWindowChange]);

  const pps = stripWidth / span;
  const viewEnd = viewStart + span;
  const X = useCallback((t: number) => (t - viewStart) * pps, [viewStart, pps]);

  const latest = useRef({ segment, edge, fps, totalDuration, viewStart, pps });
  latest.current = { segment, edge, fps, totalDuration, viewStart, pps };

  const applyTrim = useCallback(
    (next: { start: number; end: number }, which: TrimEdge, commit: boolean) => {
      onTrim(next.start, next.end, which);
      if (commit) onTrimCommit();
    },
    [onTrim, onTrimCommit],
  );

  const nudge = useCallback(
    (frames: number) => {
      const { segment: seg, edge: e, fps: f, totalDuration: total } = latest.current;
      applyTrim(nudgeEdge(seg, e, frames, f, total), e, true);
    },
    [applyTrim],
  );

  // Pointer handling on the strip: handles trim, empty area pans, a click seeks.
  const pointerRef = useRef<
    | { kind: "edge"; edge: TrimEdge; seg: LensSegment }
    | { kind: "pan"; startX: number; startView: number; moved: boolean }
    | null
  >(null);

  const timeAtClientX = (clientX: number) => {
    const rect = stripRef.current!.getBoundingClientRect();
    const { viewStart: vs, pps: p } = latest.current;
    return vs + (clientX - rect.left) / p;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const handle = (e.target as HTMLElement).closest<HTMLElement>("[data-trim-edge]");
    e.currentTarget.setPointerCapture(e.pointerId);
    if (handle) {
      const which = handle.dataset.trimEdge as TrimEdge;
      if (which !== edge) onEdgeChange(which);
      pointerRef.current = { kind: "edge", edge: which, seg: { ...segment } };
      draggingRef.current = true;
    } else {
      pointerRef.current = { kind: "pan", startX: e.clientX, startView: viewStart, moved: false };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pointerRef.current;
    if (!p) return;
    const { fps: f, totalDuration: total, pps: px } = latest.current;
    if (p.kind === "edge") {
      applyTrim(setEdgeTime(p.seg, p.edge, timeAtClientX(e.clientX), f, total), p.edge, false);
    } else {
      const dx = e.clientX - p.startX;
      if (!p.moved && Math.abs(dx) < PAN_THRESHOLD_PX) return;
      p.moved = true;
      const maxStart = Math.max(0, total - span);
      setViewStart(Math.max(0, Math.min(maxStart, p.startView - dx / px)));
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pointerRef.current;
    pointerRef.current = null;
    if (!p) return;
    if (p.kind === "edge") {
      draggingRef.current = false;
      onTrimCommit();
    } else if (!p.moved) {
      const t = Math.max(0, Math.min(totalDuration, timeAtClientX(e.clientX)));
      onSeek(fps && fps > 0 ? frameDisplayTime(Math.floor(t * fps), fps) : t);
    }
  };

  // Wheel pans the lens (non-passive so the page doesn't scroll).
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const raw = e.deltaX !== 0 ? e.deltaX : e.deltaY;
      const delta = e.deltaMode === 1 ? raw * 40 : raw;
      const { pps: p, totalDuration: total } = latest.current;
      const maxStart = Math.max(0, total - span);
      setViewStart((v) => Math.max(0, Math.min(maxStart, v + delta / p)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [span]);

  // Frames on either side of the cut
  const frames = fps && fps > 0 ? edgeFrames(segment, edge, fps) : null;
  const totalFrames = fps && fps > 0 ? Math.round(totalDuration * fps) : 0;
  const frameTime = (frame: number) =>
    fps && frame >= 0 && frame < totalFrames ? frameDisplayTime(frame, fps) : null;
  const beforeFrame = frames ? (edge === "start" ? frames.outside : frames.inside) : null;
  const afterFrame = frames ? (edge === "start" ? frames.inside : frames.outside) : null;
  const tcOf = (frame: number | null) =>
    frame == null || !fps ? "—" : formatFrameTimecode(frame / fps, fps);

  // Ruler: per-frame ticks as a repeating gradient, second labels as text
  const pxPerFrame = fps && fps > 0 ? pps / fps : 0;
  const showFrameTicks = pxPerFrame >= 3;
  const firstFrameX = fps && fps > 0 ? X(Math.ceil(viewStart * fps) / fps) : 0;
  const labelStep = [0.5, 1, 2, 5, 10].find((s) => s * pps >= 70) ?? 10;
  const labels = useMemo(() => {
    const out: number[] = [];
    for (let t = Math.ceil(viewStart / labelStep) * labelStep; t <= viewEnd; t += labelStep) {
      out.push(Math.round(t * 1000) / 1000);
    }
    return out;
  }, [viewStart, viewEnd, labelStep]);

  const visibleWords = useMemo(
    () => words.filter((w) => w.end > viewStart && w.start < viewEnd),
    [words, viewStart, viewEnd],
  );
  const visibleSegments = segments.filter(
    (s) => s.endTime > viewStart && s.startTime < viewEnd,
  );

  const clipSeconds = segment.endTime - segment.startTime;
  const clipFrames = fps && fps > 0 ? Math.round(segment.endTime * fps) - Math.round(segment.startTime * fps) : null;
  // The field shows the highlighted frame: first frame (In) or last frame (Out)
  const oneFrame = fps && fps > 0 ? 1 / fps : 0;
  const edgeTimecode = formatFrameTimecode(
    edge === "end" ? Math.max(segment.startTime, edgeTime - oneFrame) : edgeTime,
    fps,
  );

  const submitTimecode = () => {
    if (timecodeDraft == null) return;
    const t = parseFrameTimecode(timecodeDraft, fps);
    if (t == null) {
      setTimecodeError(true);
      return;
    }
    const target = edge === "end" ? t + oneFrame : t;
    applyTrim(setEdgeTime(segment, edge, target, fps, totalDuration), edge, true);
    setTimecodeDraft(null);
    setTimecodeError(false);
  };

  const nudgeButton = (frames: number, label: string) => (
    <button
      type="button"
      onClick={() => nudge(frames)}
      className="h-7 px-2 rounded-md border border-border text-xs font-mono tabular-nums hover:bg-muted"
      title={`${frames > 0 ? "+" : ""}${frames} frame${Math.abs(frames) === 1 ? "" : "s"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="mx-3 mb-2 rounded-lg border border-border bg-background/60 p-2 flex flex-col gap-2">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex rounded-md border border-border overflow-hidden text-xs font-semibold">
          {(["start", "end"] as const).map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => onEdgeChange(e)}
              className={cn(
                "px-2.5 h-7",
                edge === e ? "bg-amber-400 text-zinc-900" : "hover:bg-muted text-muted-foreground",
              )}
            >
              {e === "start" ? "In" : "Out"}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          {nudgeButton(-10, "−10f")}
          {nudgeButton(-1, "−1f")}
          <input
            value={timecodeDraft ?? edgeTimecode}
            onChange={(e) => {
              setTimecodeDraft(e.target.value);
              setTimecodeError(false);
            }}
            onFocus={(e) => {
              setTimecodeDraft(edgeTimecode);
              requestAnimationFrame(() => e.target.select());
            }}
            onBlur={() => {
              setTimecodeDraft(null);
              setTimecodeError(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitTimecode();
              } else if (e.key === "Escape") {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              }
            }}
            aria-label={edge === "start" ? "First frame timecode" : "Last frame timecode"}
            title={fps ? "Type HH:MM:SS:FF and press Enter" : "Type m:ss.cc and press Enter"}
            className={cn(
              "h-7 w-[120px] rounded-md border bg-background px-2 text-center text-xs font-mono tabular-nums",
              timecodeError ? "border-red-500" : "border-border",
            )}
          />
          {nudgeButton(1, "+1f")}
          {nudgeButton(10, "+10f")}
        </div>

        <span className="text-xs text-muted-foreground tabular-nums">
          {clipSeconds.toFixed(2)} s{clipFrames != null ? ` · ${clipFrames} frames` : ""}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <span className="hidden xl:inline text-[11px] text-muted-foreground">
            , . nudge · Shift ×10 · [ ] set to playhead · Esc close
          </span>
          <div className="flex rounded-md border border-border overflow-hidden text-[11px]">
            {SPANS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSpan(s)}
                className={cn(
                  "px-2 h-6 tabular-nums",
                  span === s ? "bg-muted text-foreground font-semibold" : "text-muted-foreground hover:bg-muted/60",
                )}
                title={`Show ${s} seconds`}
              >
                {s}s
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-6 w-6 rounded-md flex items-center justify-center text-muted-foreground hover:bg-muted"
            aria-label="Close trim lens"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Body: frames either side of the cut, then the magnified strip */}
      <div className="flex gap-2 items-stretch">
        <FramePreview
          src={videoSrc}
          time={beforeFrame == null ? null : frameTime(beforeFrame)}
          label={edge === "start" ? "Before cut" : "Last frame"}
          timecode={tcOf(beforeFrame)}
          emphasis={edge === "end"}
        />
        <FramePreview
          src={videoSrc}
          time={afterFrame == null ? null : frameTime(afterFrame)}
          label={edge === "start" ? "First frame" : "After cut"}
          timecode={tcOf(afterFrame)}
          emphasis={edge === "start"}
        />

        <div
          ref={stripRef}
          className="relative flex-1 min-w-0 h-[100px] rounded-md bg-secondary/60 dark:bg-zinc-900/70 border border-border/60 overflow-hidden cursor-grab active:cursor-grabbing touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {/* Ruler */}
          <div
            className="absolute inset-x-0 bottom-0 h-[10px] pointer-events-none"
            style={
              showFrameTicks
                ? {
                    backgroundImage: `repeating-linear-gradient(to right, hsl(var(--muted-foreground) / 0.45) 0 1px, transparent 1px ${pxPerFrame}px)`,
                    backgroundPositionX: `${firstFrameX}px`,
                  }
                : undefined
            }
          />
          {labels.map((t) => (
            <div key={t} className="absolute bottom-0 pointer-events-none" style={{ left: X(t) }}>
              <div className="w-px h-[16px] bg-muted-foreground/60" />
              <span className="absolute bottom-[12px] left-1 text-[10px] font-mono tabular-nums text-muted-foreground whitespace-nowrap">
                {rulerLabel(t)}
              </span>
            </div>
          ))}

          {/* Words */}
          {visibleWords.map((w, i) => (
            <div
              key={`${w.start}-${i}`}
              className="absolute top-1 h-[18px] rounded-sm bg-foreground/5 border-l border-foreground/20 px-0.5 text-[10px] leading-[18px] text-muted-foreground overflow-hidden whitespace-nowrap pointer-events-none"
              style={{ left: X(w.start), width: Math.max(2, (w.end - w.start) * pps) }}
              title={w.value}
            >
              {w.value}
            </div>
          ))}

          {/* Segments in view */}
          {visibleSegments.map((s) => {
            const left = Math.max(0, X(s.startTime));
            const right = Math.min(stripWidth, X(s.endTime));
            const active = s.id === segment.id;
            return (
              <div
                key={s.id}
                className={cn(
                  "absolute top-[26px] h-[40px] rounded-sm pointer-events-none",
                  active ? "bg-blue-500/80" : "bg-blue-600/30",
                )}
                style={{ left, width: Math.max(1, right - left) }}
              />
            );
          })}

          {/* Handles for the active segment */}
          {(["start", "end"] as const).map((e) => {
            const t = e === "start" ? segment.startTime : segment.endTime;
            const x = X(t);
            if (x < -8 || x > stripWidth + 8) return null;
            const active = e === edge;
            return (
              <div
                key={e}
                data-trim-edge={e}
                className="absolute top-[18px] h-[56px] w-4 -ml-2 flex justify-center cursor-ew-resize z-10"
                style={{ left: x }}
                title={e === "start" ? "Drag the in point" : "Drag the out point"}
              >
                <div
                  className={cn(
                    "h-full rounded-full",
                    active ? "w-1 bg-amber-400" : "w-0.5 bg-blue-200",
                  )}
                />
              </div>
            );
          })}

          {/* Playhead */}
          {currentTime >= viewStart && currentTime <= viewEnd && (
            <div
              className="absolute top-0 bottom-0 w-px bg-red-500 pointer-events-none z-20"
              style={{ left: X(currentTime) }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
