import {
  Composition,
  registerRoot,
  type CalculateMetadataFunction,
} from "remotion";
import { CaptionedVideo } from "./CaptionedVideo";
import type { CaptionedVideoProps } from "./types";
import { DEFAULT_CAPTION_SETTINGS, DEFAULT_GLOBAL_FRAMING } from "./types";
import { DEFAULT_SOURCE_ASPECT } from "../lib/zoomMath";

const FPS = 30;

/**
 * Calculate duration from segments (not the video file).
 * Each segment's duration determines the render length.
 */
const calculateMetadata: CalculateMetadataFunction<
  CaptionedVideoProps
> = async ({ props }) => {
  const { segments } = props;

  // Calculate duration from segments only
  // We render just the segment(s), not the full video
  const durationInSeconds =
    segments?.reduce((sum, seg) => sum + (seg.endTime - seg.startTime), 0) || 0;
  
  return {
    durationInFrames: Math.max(FPS, Math.ceil(durationInSeconds * FPS)),
  };
};

export function RemotionRoot() {
  return (
    <>
      <Composition
        id="CaptionedVideo"
        component={CaptionedVideo}
        fps={FPS}
        width={1920}
        height={1080}
        durationInFrames={FPS} // Default, overridden by calculateMetadata
        calculateMetadata={calculateMetadata}
        defaultProps={{
          videoUrl: "",
          segments: [],
          captions: [],
          captionSettings: DEFAULT_CAPTION_SETTINGS,
          globalFraming: DEFAULT_GLOBAL_FRAMING,
          sourceAspect: DEFAULT_SOURCE_ASPECT,
        }}
      />

      <Composition
        id="CaptionedVideoPortrait"
        component={CaptionedVideo}
        fps={FPS}
        width={1080}
        height={1920}
        durationInFrames={FPS}
        calculateMetadata={calculateMetadata}
        defaultProps={{
          videoUrl: "",
          segments: [],
          captions: [],
          captionSettings: DEFAULT_CAPTION_SETTINGS,
          globalFraming: {
            ...DEFAULT_GLOBAL_FRAMING,
            aspectRatio: "9:16",
            enabled: true,
          },
          sourceAspect: DEFAULT_SOURCE_ASPECT,
        }}
      />

      <Composition
        id="CaptionedVideoSquare"
        component={CaptionedVideo}
        fps={FPS}
        width={1080}
        height={1080}
        durationInFrames={FPS}
        calculateMetadata={calculateMetadata}
        defaultProps={{
          videoUrl: "",
          segments: [],
          captions: [],
          captionSettings: DEFAULT_CAPTION_SETTINGS,
          globalFraming: {
            ...DEFAULT_GLOBAL_FRAMING,
            aspectRatio: "1:1",
            enabled: true,
          },
          sourceAspect: DEFAULT_SOURCE_ASPECT,
        }}
      />
    </>
  );
}

registerRoot(RemotionRoot);
