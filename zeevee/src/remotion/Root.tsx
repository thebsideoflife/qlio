import { Composition, registerRoot } from "remotion";
import { CaptionedVideo } from "./CaptionedVideo";
import { DEFAULT_CAPTION_SETTINGS } from "./types";

export function RemotionRoot() {
  return (
    <Composition
      id="CaptionedVideo"
      component={CaptionedVideo}
      durationInFrames={30 * 60}
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
