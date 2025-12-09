import { useEffect, type RefObject } from "react";
import type { Segment } from "@/store/editorSlice";

export function useSeamlessPlayback(
  videoRef: RefObject<HTMLVideoElement | null>,
  segments: Segment[]
) {
  useEffect(() => {
    let animationFrameId: number;

    const checkTime = () => {
      const video = videoRef.current;

      if (video && !video.paused && segments.length > 0) {
        const t = video.currentTime;
        // Check if we are inside any valid segment
        // Optimization: We could binary search or sort, but for <50 segments finding is fast enough.
        const currentSegment = segments.find(
          (s) => t >= s.startTime && t < s.endTime
        );

        if (!currentSegment) {
          // Find the next segment to jump to
          const nextSegment = segments
            .filter((s) => s.startTime > t)
            .sort((a, b) => a.startTime - b.startTime)[0];

          if (nextSegment) {
            video.currentTime = nextSegment.startTime;
          } else {
            // End of all segments
            video.pause();
          }
        }
      }

      animationFrameId = requestAnimationFrame(checkTime);
    };

    animationFrameId = requestAnimationFrame(checkTime);
    return () => cancelAnimationFrame(animationFrameId);
  }, [segments, videoRef]);
}
