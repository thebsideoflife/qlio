import { useEffect, type RefObject } from "react";
import type { Segment } from "@/store/editorSlice";

export function useSeamlessPlayback(
  videoRef: RefObject<HTMLVideoElement | null>,
  segments: Segment[]
) {
  useEffect(() => {
    const video = videoRef.current;
    if (!video || segments.length === 0) return;

    const sorted = [...segments].sort((a, b) => a.startTime - b.startTime);

    let rafId: number;
    let lastJump = -1;

    const tick = () => {
      if (!video.paused) {
        const t = video.currentTime;

        // Are we in a segment?
        const inSegment = sorted.some((s) => t >= s.startTime && t < s.endTime);

        if (!inSegment) {
          const next = sorted.find((s) => s.startTime > t);
          if (next && next.startTime !== lastJump) {
            lastJump = next.startTime;
            video.currentTime = next.startTime;
          } else if (!next) {
            video.pause();
          }
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [segments, videoRef]);
}
