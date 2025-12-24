import {
  Composition,
  registerRoot,
  type CalculateMetadataFunction,
} from "remotion";
import { parseMedia } from "@remotion/media-parser";
import { webReader } from "@remotion/media-parser/web";
import { CaptionedVideo } from "./CaptionedVideo";
import type { CaptionedVideoProps } from "./types";
import { DEFAULT_CAPTION_SETTINGS, DEFAULT_GLOBAL_FRAMING } from "./types";

const FPS = 30;

/**
 * Calculate duration from the actual video file.
 */
const calculateMetadata: CalculateMetadataFunction<
  CaptionedVideoProps
> = async ({ props }) => {
  const { videoUrl, segments } = props;

  // Get actual video duration
  if (videoUrl && videoUrl.trim() !== "") {
    try {
      const { durationInSeconds } = await parseMedia({
        src: videoUrl,
        fields: { durationInSeconds: true },
        reader: webReader,
      });
      if (durationInSeconds !== null) {
        return {
          durationInFrames: Math.max(FPS, Math.ceil(durationInSeconds * FPS)),
        };
      }
    } catch (error) {
      console.error("Failed to get video metadata:", error);
    }
  }

  // Fallback: calculate from segments
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
        }}
      />
    </>
  );
}

registerRoot(RemotionRoot);
