import type { CaptionLine, CaptionSettings } from "../../remotion/types";
import { CaptionText } from "./CaptionText";

interface CaptionDisplayProps {
  captions: CaptionLine[];
  settings: CaptionSettings;
  currentTime: number;
  containerHeight: number;
  children?: React.ReactNode; // overlay controls (drag handles, etc.)
}

/**
 * Shared caption renderer used by both:
 * - CaptionedVideo (Remotion composition — server-side render)
 * - CaptionOverlay (editor preview — browser)
 *
 * Positions the active caption and renders CaptionText.
 * Pass containerHeight from useVideoConfig().height (Remotion)
 * or the overlay div's offsetHeight (editor).
 */
export function CaptionDisplay({
  captions,
  settings,
  currentTime,
  containerHeight,
  children,
}: CaptionDisplayProps) {
  if (!settings.enabled) return null;

  const { style } = settings;

  const activeCaption = captions.find(
    (c) => currentTime >= c.startTime && currentTime < c.endTime,
  );

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
