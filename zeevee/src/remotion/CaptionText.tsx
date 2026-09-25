import { useEffect, useState } from "react";
import type { CaptionLine, CaptionStyle } from "./types";
import { resolveCaptionContent } from "./captionContent";
import { captionWordText, hasCaptionLineBreak } from "./captionGrouping";
import { isCaptionFontReady, loadCaptionFont } from "./loadCaptionFonts";

interface CaptionTextProps {
  caption: CaptionLine;
  style: CaptionStyle;
  currentTime: number;
  /** Height of the rendering context in px. fontSize is treated as % of this. */
  containerHeight: number;
}

/**
 * One text implementation for the editor and Remotion.
 * Whisper originals retain word timing; translations remain phrase text.
 */
export function CaptionText({
  caption,
  style,
  currentTime,
  containerHeight,
}: CaptionTextProps) {
  const font = loadCaptionFont(style.fontFamily);
  const [readyFamily, setReadyFamily] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    font.waitUntilDone()
      .then(() => {
        if (active) setReadyFamily(font.fontFamily);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [font]);

  const content = resolveCaptionContent(caption);
  const visibleWords = content.mode === "words" ? content.words : [];
  const displayText = content.mode === "text" ? content.text : null;

  const activeWordIndex = visibleWords.findIndex(
    (word) => currentTime >= word.start && currentTime < word.end,
  );

  const highlightColor = style.highlightColor || "#fbbf24";
  const showAnimation = highlightColor !== "none" && visibleWords.length > 0;

  if (content.mode === "empty" || (
    readyFamily !== font.fontFamily && !isCaptionFontReady(font.fontFamily)
  )) return null;

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
          fontFamily: font.fontFamily,
          fontSize: `${(style.fontSize / 100) * containerHeight}px`,
          fontWeight: style.fontWeight ?? "600",
          lineHeight: 1.25,
          color: style.color,
          textShadow: "0 1px 2px rgba(0,0,0,0.8)",
          display: "block",
          textAlign: "center",
          whiteSpace: "pre-line",
        }}
      >
        {displayText ? (
          <span>{displayText}</span>
        ) : (
          visibleWords.map((word, index) => (
            <span
              key={`${word.start}-${index}`}
              style={{
                color:
                  showAnimation && index === activeWordIndex
                    ? highlightColor
                    : style.color,
              }}
            >
              {captionWordText(word.value)}
              {index < visibleWords.length - 1
                ? hasCaptionLineBreak(word.value)
                  ? "\n"
                  : " "
                : ""}
            </span>
          ))
        )}
      </span>
    </div>
  );
}
