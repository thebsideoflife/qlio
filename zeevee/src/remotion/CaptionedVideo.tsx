import {
  AbsoluteFill,
  OffthreadVideo,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type {
  CaptionedVideoProps,
  CaptionLine,
  CaptionSettings,
  SegmentFraming,
} from "./types";
import { DEFAULT_SEGMENT_FRAMING } from "./types";
import { AutoFramedVideo } from "./AutoFramedVideo";
import { CaptionDisplay } from "../components/editor/CaptionDisplay";

interface SegmentVideoProps {
  videoUrl: string;
  startTime: number;
  endTime: number;
  captions: CaptionLine[];
  captionSettings: CaptionSettings;
  framing?: SegmentFraming;
  framingEnabled?: boolean;
}

function SegmentVideo({
  videoUrl,
  startTime,
  endTime,
  captions,
  captionSettings,
  framing,
  framingEnabled = false,
}: SegmentVideoProps) {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();

  // Current time within the original video
  const currentTime = startTime + frame / fps;
  // Time relative to segment start (for keyframe resolution)
  const timeInSegment = frame / fps;

  // Validate videoUrl
  if (!videoUrl || videoUrl.trim() === "") {
    console.error("SegmentVideo: videoUrl is empty", {
      videoUrl,
      startTime,
      endTime,
    });
    return (
      <AbsoluteFill
        style={{
          backgroundColor: "red",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "white",
        }}
      >
        Error: No video URL
      </AbsoluteFill>
    );
  }

  // Use AutoFramedVideo when framing is enabled
  if (framingEnabled && framing) {
    return (
      <AutoFramedVideo
        src={videoUrl}
        framing={framing}
        startFrom={Math.round(startTime * fps)}
        endAt={Math.round(endTime * fps)}
        timeInSegment={timeInSegment}
      >
        <CaptionDisplay
          captions={captions}
          settings={captionSettings}
          currentTime={currentTime}
          containerHeight={height}
        />
      </AutoFramedVideo>
    );
  }

  // Default: no framing applied
  return (
    <AbsoluteFill>
      <OffthreadVideo
        src={videoUrl}
        startFrom={Math.round(startTime * fps)}
        endAt={Math.round(endTime * fps)}
      />
      <CaptionDisplay
        captions={captions}
        settings={captionSettings}
        currentTime={currentTime}
        containerHeight={height}
      />
    </AbsoluteFill>
  );
}

export const CaptionedVideo: React.FC<CaptionedVideoProps> = ({
  videoUrl,
  segments,
  captions,
  captionSettings,
  globalFraming,
}) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();

  const framingEnabled = globalFraming?.enabled ?? false;

  // Validate videoUrl
  if (!videoUrl || videoUrl.trim() === "") {
    console.error("CaptionedVideo: videoUrl is empty or undefined", {
      videoUrl,
      segments: segments?.length,
      captions: captions?.length,
    });
    return (
      <AbsoluteFill
        style={{
          backgroundColor: "black",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "white",
          fontSize: "2rem",
          padding: "2rem",
          textAlign: "center",
        }}
      >
        <div>
          <div style={{ marginBottom: "1rem" }}>⚠️ Error</div>
          <div style={{ fontSize: "1.5rem" }}>
            No video source provided (videoUrl is empty)
          </div>
        </div>
      </AbsoluteFill>
    );
  }

  // No segments = render full video
  if (segments.length === 0) {
    const currentTime = frame / fps;

    // Apply framing if enabled (use default framing with global aspect ratio)
    if (framingEnabled && globalFraming) {
      const defaultFraming: SegmentFraming = {
        ...DEFAULT_SEGMENT_FRAMING,
        aspectRatio: globalFraming.aspectRatio,
      };
      return (
        <AutoFramedVideo src={videoUrl} framing={defaultFraming}>
          <CaptionDisplay
            captions={captions}
            settings={captionSettings}
            currentTime={currentTime}
            containerHeight={height}
          />
        </AutoFramedVideo>
      );
    }

    return (
      <AbsoluteFill style={{ backgroundColor: "black" }}>
        <OffthreadVideo src={videoUrl} />
        <CaptionDisplay
          captions={captions}
          settings={captionSettings}
          currentTime={currentTime}
          containerHeight={height}
        />
      </AbsoluteFill>
    );
  }

  // Build sequences for each segment
  const sequences = segments.reduce<
    Array<{
      segment: (typeof segments)[0];
      startFrame: number;
      duration: number;
    }>
  >((acc, segment) => {
    const startFrame =
      acc.length > 0
        ? acc[acc.length - 1].startFrame + acc[acc.length - 1].duration
        : 0;
    const duration = Math.round((segment.endTime - segment.startTime) * fps);
    acc.push({ segment, startFrame, duration });
    return acc;
  }, []);

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {sequences.map(({ segment, startFrame, duration }) => {
        // Use segment-specific framing, or default with global aspect ratio
        const segmentFraming: SegmentFraming = segment.framing || {
          ...DEFAULT_SEGMENT_FRAMING,
          aspectRatio: globalFraming?.aspectRatio ?? "9:16",
        };

        return (
          <Sequence
            key={segment.id}
            from={startFrame}
            durationInFrames={duration}
          >
            <SegmentVideo
              videoUrl={videoUrl}
              startTime={segment.startTime}
              endTime={segment.endTime}
              captions={captions}
              captionSettings={captionSettings}
              framing={segmentFraming}
              framingEnabled={framingEnabled}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
