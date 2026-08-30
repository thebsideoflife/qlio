import {
  Composition,
  registerRoot,
  type CalculateMetadataFunction,
} from "remotion";
import { CaptionedVideo } from "./CaptionedVideo";
import type { CaptionedVideoProps } from "./types";
import { DEFAULT_CAPTION_SETTINGS, DEFAULT_GLOBAL_FRAMING } from "./types";
import { DEFAULT_SOURCE_ASPECT } from "../lib/zoomMath";
import { canonicalizeFps, probeSourceFps } from "../lib/sourceFps";

const PLACEHOLDER_FPS = 30;

const calculateMetadata: CalculateMetadataFunction<
  CaptionedVideoProps
> = async ({ props }) => {
  const durationInSeconds =
    props.segments?.reduce((sum, seg) => sum + (seg.endTime - seg.startTime), 0) ||
    0;

  const rawFps =
    props.sourceFps && props.sourceFps > 0
      ? props.sourceFps
      : props.videoUrl
        ? await probeSourceFps(props.videoUrl)
        : null;
  const fps = rawFps && rawFps > 0 ? canonicalizeFps(rawFps) : null;

  if (!(fps && fps > 0)) {
    if (props.videoUrl) {
      throw new Error("Could not determine source video frame rate");
    }
    return { durationInFrames: PLACEHOLDER_FPS };
  }

  return {
    fps,
    durationInFrames: Math.max(1, Math.round(durationInSeconds * fps)),
  };
};

export function RemotionRoot() {
  return (
    <>
      <Composition
        id="CaptionedVideo"
        component={CaptionedVideo}
        fps={PLACEHOLDER_FPS}
        width={1920}
        height={1080}
        durationInFrames={PLACEHOLDER_FPS}
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
        fps={PLACEHOLDER_FPS}
        width={1080}
        height={1920}
        durationInFrames={PLACEHOLDER_FPS}
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
        fps={PLACEHOLDER_FPS}
        width={1080}
        height={1080}
        durationInFrames={PLACEHOLDER_FPS}
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
