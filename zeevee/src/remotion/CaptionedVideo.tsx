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
} from "./types";

interface CaptionDisplayProps {
  captions: CaptionLine[];
  settings: CaptionSettings;
  currentTime: number;
}

function CaptionDisplay({
  captions,
  settings,
  currentTime,
}: CaptionDisplayProps) {
  if (!settings.enabled) return null;

  const activeCaption = captions.find(
    (c) => currentTime >= c.startTime && currentTime < c.endTime
  );

  if (!activeCaption) return null;

  const { style } = settings;
  const activeWordIndex = activeCaption.words.findIndex(
    (w) => currentTime >= w.start && currentTime < w.end
  );

  const highlightColor = style.highlightColor || "#fbbf24";
  const showAnimation = highlightColor !== "none";

  return (
    <div
      style={{
        position: "absolute",
        left: `${style.position.x}%`,
        top: `${style.position.y}%`,
        transform: "translate(-50%, -50%)",
        maxWidth: `${style.maxWidth}%`,
        textAlign: "center",
      }}
    >
      <div
        style={{
          display: "inline-block",
          padding: "0.3em 0.6em",
          backgroundColor: style.backgroundColor,
          borderRadius: 6,
        }}
      >
        <span
          style={{
            fontFamily: style.fontFamily,
            fontSize: `${style.fontSize}vh`,
            lineHeight: 1.25,
            color: style.color,
            textShadow: "0 1px 2px rgba(0,0,0,0.8)",
          }}
        >
          {activeCaption.words.map((word, idx) => (
            <span
              key={idx}
              style={{
                color:
                  showAnimation && idx === activeWordIndex
                    ? highlightColor
                    : style.color,
                fontWeight:
                  showAnimation && idx === activeWordIndex ? 600 : 400,
              }}
            >
              {word.value}
              {idx < activeCaption.words.length - 1 ? " " : ""}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}

interface SegmentClipProps {
  videoUrl: string;
  startTime: number;
  endTime: number;
  captions: CaptionLine[];
  captionSettings: CaptionSettings;
}

function SegmentClip({
  videoUrl,
  startTime,
  endTime,
  captions,
  captionSettings,
}: SegmentClipProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Current time within the original video
  const currentTime = startTime + frame / fps;

  // Validate videoUrl
  if (!videoUrl || videoUrl.trim() === "") {
    console.error("SegmentClip: videoUrl is empty", {
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
      />
    </AbsoluteFill>
  );
}

export const CaptionedVideo: React.FC<CaptionedVideoProps> = ({
  videoUrl,
  segments,
  captions,
  captionSettings,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

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

  console.log("CaptionedVideo rendering with:", {
    videoUrlLength: videoUrl.length,
    videoUrlPrefix: videoUrl.substring(0, 50),
    segmentsCount: segments.length,
    captionsCount: captions.length,
  });

  // No segments = render full video
  if (segments.length === 0) {
    const currentTime = frame / fps;
    return (
      <AbsoluteFill style={{ backgroundColor: "black" }}>
        <OffthreadVideo src={videoUrl} />
        <CaptionDisplay
          captions={captions}
          settings={captionSettings}
          currentTime={currentTime}
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
      {sequences.map(({ segment, startFrame, duration }) => (
        <Sequence
          key={segment.id}
          from={startFrame}
          durationInFrames={duration}
        >
          <SegmentClip
            videoUrl={videoUrl}
            startTime={segment.startTime}
            endTime={segment.endTime}
            captions={captions}
            captionSettings={captionSettings}
          />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
