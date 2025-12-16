import type { CaptionLine, CaptionStyle } from "@/remotion/types";

interface CaptionTextProps {
  caption: CaptionLine;
  style: CaptionStyle;
  currentTime: number;
}

/**
 * Shared caption text renderer used by both:
 * - CaptionOverlay (editor preview with drag/resize)
 * - CaptionDisplay in Remotion (final video render)
 */
export function CaptionText({ caption, style, currentTime }: CaptionTextProps) {
  const activeWordIndex = caption.words.findIndex(
    (w) => currentTime >= w.start && currentTime < w.end
  );

  const highlightColor = style.highlightColor || "#fbbf24";
  const showAnimation = highlightColor !== "none";

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
          fontSize: `${style.fontSize}vh`,
          lineHeight: 1.25,
          color: style.color,
          textShadow: "0 1px 2px rgba(0,0,0,0.8)",
          display: "block",
          textAlign: "center",
        }}
      >
        {caption.words.map((word, idx) => (
          <span
            key={idx}
            style={{
              color:
                showAnimation && idx === activeWordIndex
                  ? highlightColor
                  : style.color,
            }}
          >
            {word.value}
            {idx < caption.words.length - 1 ? " " : ""}
          </span>
        ))}
      </span>
    </div>
  );
}

