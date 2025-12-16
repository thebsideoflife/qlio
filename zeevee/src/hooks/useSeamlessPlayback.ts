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

    const tick = () => {
      // Don't do anything while seeking - wait for it to complete
      if (video.paused || video.seeking) {
        rafId = requestAnimationFrame(tick);
        return;
      }

      const t = video.currentTime;

      // Are we inside any segment?
      const inSegment = sorted.some(
        (s) => t >= s.startTime && t < s.endTime
      );

      if (!inSegment) {
        // Find next segment that starts after current time
        const next = sorted.find((s) => s.startTime > t);
        if (next) {
          video.currentTime = next.startTime;
        } else {
          video.pause();
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [segments, videoRef]);
}
