import React from "react";
import { AbsoluteFill, OffthreadVideo, useVideoConfig } from "remotion";
import type { SegmentFraming, AspectRatio } from "./types";
import { DEFAULT_SEGMENT_FRAMING, getEffectiveKeyframes } from "./types";
import { resolveFramingAtTime } from "./framingInterpolation";
import {
  DEFAULT_SOURCE_ASPECT,
  videoSizeAtZoom,
} from "../lib/zoomMath";

interface AutoFramedVideoProps {
  src: string;
  framing?: SegmentFraming;
  startFrom?: number;
  endAt?: number;
  children?: React.ReactNode;
  /** Time in seconds relative to segment start, for keyframe resolution */
  timeInSegment?: number;
  /** Source video width/height. Defaults to 16:9 when unknown. */
  sourceAspect?: number;
}

/**
 * Get the aspect ratio as a decimal value (width/height)
 */
function getAspectRatioValue(aspectRatio: AspectRatio): number {
  switch (aspectRatio) {
    case "9:16":
      return 9 / 16; // 0.5625 - Portrait
    case "1:1":
      return 1; // Square
    case "16:9":
      return 16 / 9; // 1.777 - Landscape
    default:
      return 9 / 16;
  }
}

/**
 * AutoFramedVideo component that applies zoom-based framing to video content.
 *
 * Zoom model:
 * - zoom=0.0: object-fit: contain (full frame, letterboxed) — same as "fit"
 * - zoom=1.0: object-fit: cover + object-position — same as "crop"
 * - 0 < zoom < 1: intermediate size between contain and cover, positioned by focusX/focusY
 *
 * Supports multiple keyframes per segment — resolves the active keyframe
 * based on timeInSegment using hard-cut logic.
 */
export const AutoFramedVideo: React.FC<AutoFramedVideoProps> = ({
  src,
  framing = DEFAULT_SEGMENT_FRAMING,
  startFrom,
  endAt,
  children,
  timeInSegment = 0,
  sourceAspect = DEFAULT_SOURCE_ASPECT,
}) => {
  const { width: containerW, height: containerH, fps } = useVideoConfig();

  const keyframes = getEffectiveKeyframes(framing);
  const { focusX, focusY, zoom } = resolveFramingAtTime(
    keyframes,
    timeInSegment,
    fps,
  );

  const { width: videoW, height: videoH } = videoSizeAtZoom(
    zoom,
    containerW,
    containerH,
    sourceAspect,
  );

  const overflowX = videoW - containerW;
  const overflowY = videoH - containerH;
  const left = overflowX > 0 ? -(focusX - 0.5) * overflowX : 0;
  const top = overflowY > 0 ? -(focusY - 0.5) * overflowY : 0;

  const videoStyle: React.CSSProperties = {
    width: videoW,
    height: videoH,
    position: "absolute",
    left: "50%",
    top: "50%",
    transform: `translate(calc(-50% + ${left}px), calc(-50% + ${top}px))`,
    objectFit: "cover",
  };

  return (
    <AbsoluteFill style={{ backgroundColor: "black", overflow: "hidden" }}>
      <OffthreadVideo
        src={src}
        startFrom={startFrom}
        endAt={endAt}
        style={videoStyle}
      />
      {children}
    </AbsoluteFill>
  );
};

/**
 * Container component that provides the correct aspect ratio frame.
 * This is used to preview how the video will look in different aspect ratios.
 */
interface AspectRatioContainerProps {
  aspectRatio: AspectRatio;
  children: React.ReactNode;
  className?: string;
}

export const AspectRatioContainer: React.FC<AspectRatioContainerProps> = ({
  aspectRatio,
  children,
  className = "",
}) => {
  const ratio = getAspectRatioValue(aspectRatio);

  return (
    <div
      className={className}
      style={{
        position: "relative",
        width: "100%",
        paddingBottom: `${(1 / ratio) * 100}%`,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
        }}
      >
        {children}
      </div>
    </div>
  );
};

export default AutoFramedVideo;
