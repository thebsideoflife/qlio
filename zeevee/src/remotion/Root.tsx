import React from "react";
import { Composition, registerRoot } from "remotion";
import { CaptionedVideo } from "./CaptionedVideo";
import type { CaptionedVideoProps } from "./types";
import { DEFAULT_CAPTION_SETTINGS } from "./types";

export function RemotionRoot() {
  return (
    <Composition
      id="CaptionedVideo"
      component={
        CaptionedVideo as React.FC<
          CaptionedVideoProps & Record<string, unknown>
        >
      }
      durationInFrames={60 * 30 * 60} // 60 minutes max (increased from 60 seconds)
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{
        videoUrl: "",
        segments: [],
        captions: [],
        captionSettings: DEFAULT_CAPTION_SETTINGS,
      }}
    />
  );
}

registerRoot(RemotionRoot);
