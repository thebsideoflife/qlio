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
import { SquareTopVideo } from "./SquareTopVideo";
import { CaptionDisplay } from "../components/editor/CaptionDisplay";
// Ensures Sanchez, Stardos Stencil (and other caption Google fonts) are ready for Lambda.
import "./loadCaptionFonts";

interface SegmentVideoProps {
  videoUrl: string;
  startTime: number;
  endTime: number;
  captions: CaptionLine[];
  captionSettings: CaptionSettings;
  framing?: SegmentFraming;
  framingEnabled?: boolean;
  squareTop?: boolean;
  sourceAspect?: number;
}

function SegmentVideo({
  videoUrl,
  startTime,
  endTime,
  captions,
  captionSettings,
  framing,
  framingEnabled = false,
  squareTop = false,
  sourceAspect,
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

  // Square-top mode wipes out all other framing — render the square-top layout
  // and ignore segment.framing entirely.
  if (squareTop) {
    return (
      <SquareTopVideo
        src={videoUrl}
        startTime={startTime}
        endTime={endTime}
        captions={captions}
        captionSettings={captionSettings}
        currentTime={currentTime}
        containerHeight={height}
      />
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
        sourceAspect={sourceAspect}
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
  sourceAspect,
}) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();

  const framingEnabled = globalFraming?.enabled ?? false;
  // Square-top portrait mode wipes out all other framing while on. Only honored
  // when framing is enabled (consistent with the framingEnabled gate below).
  const squareTop = framingEnabled && !!globalFraming?.squareTop;

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

    // Square-top mode: render the full video as a square at the top of the
    // portrait frame, ignoring framing entirely.
    if (squareTop) {
      return (
        <SquareTopVideo
          src={videoUrl}
          startTime={0}
          endTime={0}
          captions={captions}
          captionSettings={captionSettings}
          currentTime={currentTime}
          containerHeight={height}
        />
      );
    }

    // Apply framing if enabled (use default framing with global aspect ratio)
    if (framingEnabled && globalFraming) {
      const defaultFraming: SegmentFraming = {
        ...DEFAULT_SEGMENT_FRAMING,
        aspectRatio: globalFraming.aspectRatio,
      };
      return (
        <AutoFramedVideo
          src={videoUrl}
          framing={defaultFraming}
          sourceAspect={sourceAspect}
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
              squareTop={squareTop}
              sourceAspect={sourceAspect}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
