import type { ReactNode } from "react";
import { Wifi, BatteryFull } from "lucide-react";
import { cn } from "@/lib/utils";

interface PhonePreviewFrameProps {
  children: ReactNode;
  className?: string;
}

/** Decorative phone bezel around the 9:16 preview — wraps content, never overlays it. */
export function PhonePreviewFrame({ children, className }: PhonePreviewFrameProps) {
  return (
    <div
      className={cn(
        "relative flex flex-col h-full max-h-full",
        "rounded-[2rem] px-1.5 pt-1 pb-1.5",
        "bg-gradient-to-b from-zinc-600 via-zinc-800 to-zinc-900",
        "shadow-2xl shadow-black/50 ring-1 ring-inset ring-white/10",
        className,
      )}
      // Height drives size; explicit phone aspect ratio derives the width.
      style={{ aspectRatio: "9 / 17.6", maxWidth: "100%" }}
    >
      {/* Side buttons — protrude slightly to read as physical hardware */}
      <div
        className="absolute -left-1 top-[26%] h-6 w-1 rounded-l-md bg-zinc-900 ring-1 ring-black/40 pointer-events-none"
        aria-hidden
      />
      <div
        className="absolute -left-1 top-[37%] h-10 w-1 rounded-l-md bg-zinc-900 ring-1 ring-black/40 pointer-events-none"
        aria-hidden
      />
      <div
        className="absolute -right-1 top-[32%] h-12 w-1 rounded-r-md bg-zinc-900 ring-1 ring-black/40 pointer-events-none"
        aria-hidden
      />

      {/* Status bar on the bezel — time, dynamic island, wifi + battery */}
      <div className="relative flex items-center justify-between px-3 pb-1 shrink-0 select-none pointer-events-none text-white/75">
        <span className="text-[9px] font-semibold tabular-nums">9:41</span>
        {/* Dynamic island */}
        <div className="absolute left-1/2 -translate-x-1/2 top-0.5 h-3.5 w-12 rounded-full bg-black ring-1 ring-white/5" />
        <div className="flex items-center gap-1">
          <Wifi className="h-2.5 w-2.5" strokeWidth={2.5} />
          <BatteryFull className="h-3 w-3" />
        </div>
      </div>

      {/* Screen — preview + its controls live here */}
      <div className="flex-1 min-h-0 flex items-center justify-center">
        {children}
      </div>

      {/* Home indicator */}
      <div className="flex justify-center pt-1 shrink-0 pointer-events-none select-none">
        <div className="h-1 w-16 rounded-full bg-white/30" />
      </div>
    </div>
  );
}
