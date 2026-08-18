import type { CaptionLine, CaptionStyle } from "../../remotion/types";

interface CaptionTextProps {
  caption: CaptionLine;
  style: CaptionStyle;
  currentTime: number;
  /** Height of the rendering context in px. fontSize is treated as % of this. */
  containerHeight: number;
}

/**
 * Shared caption text renderer used by both:
 * - CaptionOverlay (editor preview with drag/resize)
 * - CaptionDisplay in Remotion (final video render)
 */
export function CaptionText({
  caption,
  style,
  currentTime,
  containerHeight,
}: CaptionTextProps) {
  // Filter out empty (deleted) words
  const visibleWords = caption.words.filter((word) => word.value !== "");

  const activeWordIndex = visibleWords.findIndex(
    (w) => currentTime >= w.start && currentTime < w.end,
  );

  const highlightColor = style.highlightColor || "#fbbf24";
  const showAnimation = highlightColor !== "none" && visibleWords.length > 0;
  const displayText =
    visibleWords.length > 0
      ? null
      : caption.text.trim();

  // Don't render anything if all words are deleted and there is no line text
  if (visibleWords.length === 0 && !displayText) return null;

  return (
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
          fontSize: `${(style.fontSize / 100) * containerHeight}px`,
          fontWeight: style.fontWeight ?? "600",
          lineHeight: 1.25,
          color: style.color,
          textShadow: "0 1px 2px rgba(0,0,0,0.8)",
          display: "block",
          textAlign: "center",
        }}
      >
        {displayText ? (
          <span>{displayText}</span>
        ) : (
          visibleWords.map((word, idx) => (
            <span
              key={`${word.start}-${idx}`}
              style={{
                color:
                  showAnimation && idx === activeWordIndex
                    ? highlightColor
                    : style.color,
              }}
            >
              {word.value}
              {idx < visibleWords.length - 1 ? " " : ""}
            </span>
          ))
        )}
      </span>
    </div>
  );
}
