import React from "react";
import { Composition, registerRoot } from "remotion";
import { CaptionedVideo } from "./CaptionedVideo";
import type { CaptionedVideoProps } from "./types";
import { DEFAULT_CAPTION_SETTINGS, DEFAULT_GLOBAL_FRAMING } from "./types";

export function RemotionRoot() {
  return (
    <>
      {/* Original landscape composition */}
      <Composition
        id="CaptionedVideo"
        component={
          CaptionedVideo as React.FC<
            CaptionedVideoProps & Record<string, unknown>
          >
        }
        durationInFrames={60 * 30 * 60} // 60 minutes max
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          videoUrl: "",
          segments: [],
          captions: [],
          captionSettings: DEFAULT_CAPTION_SETTINGS,
          globalFraming: DEFAULT_GLOBAL_FRAMING,
        }}
      />

      {/* Portrait (9:16) composition for vertical video */}
      <Composition
        id="CaptionedVideoPortrait"
        component={
          CaptionedVideo as React.FC<
            CaptionedVideoProps & Record<string, unknown>
          >
        }
        durationInFrames={60 * 30 * 60}
        fps={30}
        width={1080}
        height={1920}
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

      {/* Square (1:1) composition */}
      <Composition
        id="CaptionedVideoSquare"
        component={
          CaptionedVideo as React.FC<
            CaptionedVideoProps & Record<string, unknown>
          >
        }
        durationInFrames={60 * 30 * 60}
        fps={30}
        width={1080}
        height={1080}
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
