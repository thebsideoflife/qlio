import type { CaptionLine, CaptionWord } from "./types";

export type CaptionContent =
  | { mode: "words"; words: CaptionWord[] }
  | { mode: "text"; text: string }
  | { mode: "empty" };

/**
 * Originals have word timings. Translations are line text only.
 * Remotion and the editor both render through this so a missing `words`
 * array still burns the translated line.
 */
export function resolveCaptionContent(
  caption: Pick<CaptionLine, "text" | "words">,
): CaptionContent {
  const words = (caption.words ?? []).filter((word) => word.value !== "");
  if (words.length > 0) return { mode: "words", words };
  const text = String(caption.text ?? "").trim();
  if (text) return { mode: "text", text };
  return { mode: "empty" };
}
