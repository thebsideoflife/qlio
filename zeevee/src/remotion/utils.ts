import type { CaptionLine, CaptionWord } from "./types";

/**
 * Groups word-level transcript data into caption lines.
 * Each caption line contains max `maxWords` words or spans max `maxDuration` seconds.
 */
export function groupWordsIntoCaptions(
  words: CaptionWord[],
  options: {
    maxWords?: number;
    maxDuration?: number;
    minPauseBetweenLines?: number;
  } = {}
): CaptionLine[] {
  const { maxWords = 8, maxDuration = 3, minPauseBetweenLines = 0.3 } = options;

  if (words.length === 0) return [];

  const captions: CaptionLine[] = [];
  let currentWords: CaptionWord[] = [];
  let lineStartTime = words[0].start;

  const flushCurrentLine = () => {
    if (currentWords.length > 0) {
      captions.push({
        id: `caption-${captions.length}`,
        startTime: lineStartTime,
        endTime: currentWords[currentWords.length - 1].end,
        text: currentWords.map((w) => w.value).join(" "),
        words: [...currentWords],
      });
      currentWords = [];
    }
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const prevWord = i > 0 ? words[i - 1] : null;

    // Check if we should start a new line
    const shouldBreak =
      // Exceeded max words
      currentWords.length >= maxWords ||
      // Exceeded max duration
      (currentWords.length > 0 && word.end - lineStartTime > maxDuration) ||
      // Natural pause detected (gap between words)
      (prevWord && word.start - prevWord.end > minPauseBetweenLines);

    if (shouldBreak && currentWords.length > 0) {
      flushCurrentLine();
      lineStartTime = word.start;
    }

    currentWords.push(word);
  }

  // Flush remaining words
  flushCurrentLine();

  return captions;
}
