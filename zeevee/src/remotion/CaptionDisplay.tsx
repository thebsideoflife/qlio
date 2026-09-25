import type { CaptionLine, CaptionSettings } from "./types";
import { CaptionText } from "./CaptionText";
import { activeCaptionAt } from "./captionTiming";

interface CaptionDisplayProps {
  captions: CaptionLine[];
  settings: CaptionSettings;
  currentTime: number;
  containerHeight: number;
  /** Start of the segment being played; held captions from before it are hidden. */
  segmentStart?: number;
  children?: React.ReactNode;
}

/**
 * The only timed caption renderer. Both the browser editor and Remotion use
 * this component, so source selection and clock behavior cannot drift by UI.
 */
export function CaptionDisplay({
  captions,
  settings,
  currentTime,
  containerHeight,
  segmentStart,
  children,
}: CaptionDisplayProps) {
  if (!settings.enabled) return null;

  const { style } = settings;
  const activeCaption = activeCaptionAt(captions, currentTime, segmentStart);
  if (!activeCaption) return null;

  return (
    <div
      style={{
        position: "absolute",
        left: `${style.position.x}%`,
        top: `${style.position.y}%`,
        transform: "translate(-50%, -50%)",
        width: `${style.maxWidth}%`,
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div style={{ position: "relative" }}>
        <CaptionText
          caption={activeCaption}
          style={style}
          currentTime={currentTime}
          containerHeight={containerHeight}
        />
        {children}
      </div>
    </div>
  );
}
