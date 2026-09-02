import React from "react";
import { AbsoluteFill, OffthreadVideo, useVideoConfig } from "remotion";
import type { CaptionLine, CaptionSettings } from "./types";
import { CaptionDisplay } from "./CaptionDisplay";
import { segmentFrameBounds } from "./segmentFrameBounds";

interface SquareTopVideoProps {
  src: string;
  // Segment bounds (seconds). Omit/leave at 0 to render the full video.
  startTime?: number;
  endTime?: number;
  captions: CaptionLine[];
  captionSettings: CaptionSettings;
  currentTime: number;
  containerHeight: number;
}

/**
 * Square-top portrait layout.
 *
 * The composition is the portrait canvas (1080x1920). The source 16:9 video is
 * center-cropped to a 1:1 square that fills the full width (1080x1080) and is
 * anchored to the top of the frame. The remaining 840px below is black.
 *
 * This is the "wipe out all other framing" mode: segment.framing / keyframe
 * zoom/focus is intentionally ignored here — no AI, no focus math, just a fixed
 * square crop. Captions render over the full portrait frame (same positioning
 * as non–square-top portrait), not confined to the square.
 */
export const SquareTopVideo: React.FC<SquareTopVideoProps> = ({
  src,
  startTime,
  endTime,
  captions,
  captionSettings,
  currentTime,
  containerHeight,
}) => {
  const { fps } = useVideoConfig();

  // startFrom/endAt are only meaningful with explicit segment bounds; omitting
  // them renders the full video (matches the no-segments full-video path).
  const hasBounds =
    startTime !== undefined && endTime !== undefined && endTime > startTime;
  const bounds = hasBounds
    ? segmentFrameBounds(startTime, endTime, fps)
    : null;

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <AbsoluteFill
        style={{
          // Square fills the full width, anchored to the top of the portrait frame.
          height: "56.25%", // 1080 / 1920 = 0.5625 → a 1:1 square at full width
          top: 0,
          overflow: "hidden",
        }}
      >
        <OffthreadVideo
          src={src}
          startFrom={bounds?.startFrame}
          endAt={bounds?.endFrame}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "center center",
          }}
        />
      </AbsoluteFill>
      <CaptionDisplay
        captions={captions}
        settings={captionSettings}
        currentTime={currentTime}
        containerHeight={containerHeight}
      />
    </AbsoluteFill>
  );
};
