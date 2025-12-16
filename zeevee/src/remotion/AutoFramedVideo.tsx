import React from "react";
import { AbsoluteFill, OffthreadVideo } from "remotion";
import type { SegmentFraming, AspectRatio } from "./types";
import { DEFAULT_SEGMENT_FRAMING } from "./types";

interface AutoFramedVideoProps {
  src: string;
  framing?: SegmentFraming;
  startFrom?: number;
  endAt?: number;
  children?: React.ReactNode;
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
 * AutoFramedVideo component that applies CSS-based framing to video content.
 *
 * This component uses CSS object-fit and object-position to simulate cropping
 * without actually modifying the video. This approach is:
 * - Lightweight: No video processing required
 * - Real-time: Instant preview updates
 * - Render-compatible: Works with Remotion Lambda rendering
 *
 * Framing modes:
 * - "crop": Uses object-fit: cover to fill the frame, cropping edges.
 *           The focusX/focusY values control which part of the video is visible.
 * - "fit": Uses object-fit: contain to show the entire video with letterboxing.
 */
export const AutoFramedVideo: React.FC<AutoFramedVideoProps> = ({
  src,
  framing = DEFAULT_SEGMENT_FRAMING,
  startFrom,
  endAt,
  children,
}) => {
  const { mode, focusX, focusY } = framing;

  // Determine the object-fit strategy
  const isCrop = mode === "crop";

  // For crop mode: position the video based on focus point
  // focusX: 0 = left edge visible, 0.5 = center, 1 = right edge visible
  // focusY: 0 = top edge visible, 0.5 = center, 1 = bottom edge visible
  const objectPosition = isCrop
    ? `${focusX * 100}% ${focusY * 100}%`
    : "center center";

  // Video styles for framing
  const videoStyle: React.CSSProperties = {
    width: "100%",
    height: "100%",
    objectFit: isCrop ? "cover" : "contain",
    objectPosition,
    // Smooth transition for live adjustments in the editor
    transition: "object-position 0.3s ease-out",
  };

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <OffthreadVideo
        src={src}
        startFrom={startFrom}
        endAt={endAt}
        style={videoStyle}
      />
      {/* Render children (like captions) on top of the video */}
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

