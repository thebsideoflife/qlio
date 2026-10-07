import {
  groupLinesForTranscript,
  groupWordsForTranscript,
  isOriginalCaptionLanguage,
  orderedOriginalTranscriptUrls,
  parseTranscriptPayload,
  wordsOverlappingSegments,
} from "./transcript";
import type { CaptionLine, CaptionWord } from "../remotion/types";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function words(values: Array<[number, number, string]>): CaptionWord[] {
  return values.map(([start, end, value]) => ({ start, end, value }));
}

const punctuated = groupWordsForTranscript(
  words([
    [0, 1, "First"],
    [1, 2, "sentence."],
    [2, 3, "Second"],
    [3, 4, "sentence!"],
    [11, 12, "Third"],
    [12, 13, "sentence?"],
  ]),
);
assert(punctuated.length === 2, "packs complete sentences near ten seconds");
assert(
  punctuated[0].words.map((word) => word.value).join(" ") ===
    "First sentence. Second sentence!",
  "does not split at a duration boundary inside a sentence",
);

const longSentence = groupWordsForTranscript(
  words([
    [0, 4, "One"],
    [4, 8, "very"],
    [8, 12, "long"],
    [12, 16, "sentence."],
    [16, 17, "Next."],
  ]),
);
assert(longSentence.length === 2, "a long completed sentence remains one card");
assert(longSentence[0].endTime === 16, "long sentence timing is preserved");

const noPunctuation = groupWordsForTranscript(
  words([
    [0, 1, "one"],
    [1, 2, "two"],
    [2, 3, "three"],
    [6, 7, "four"],
    [7, 8, "five"],
  ]),
  { longPause: 2 },
);
assert(noPunctuation.length === 2, "long pause splits punctuation-free speech");
assert(noPunctuation[1].startTime === 6, "fallback card starts at the real word");

const sizeFallback = groupWordsForTranscript(
  words([
    [0, 1, "one"],
    [1, 2, "two"],
    [2, 3, "three"],
    [3, 4, "four"],
  ]),
  { fallbackMaxItems: 2, targetDuration: 100 },
);
assert(sizeFallback.length === 2, "size fallback handles punctuation-free speech");

const translatedLines: CaptionLine[] = [
  {
    id: "es-0",
    startTime: 2,
    endTime: 4,
    text: "Una frase",
    words: [],
  },
  {
    id: "es-1",
    startTime: 4,
    endTime: 6,
    text: "completa.",
    words: [],
  },
  {
    id: "es-2",
    startTime: 15,
    endTime: 17,
    text: "Otra frase.",
    words: [],
  },
];
const translatedCards = groupLinesForTranscript(translatedLines);
assert(translatedCards.length === 2, "translated sentences pack into cards");
assert(
  translatedCards[0].lines[0] === translatedLines[0] &&
    translatedCards[0].lines[1] === translatedLines[1],
  "translated grouping preserves the underlying line objects",
);
assert(
  translatedCards[0].startTime === 2 && translatedCards[0].endTime === 6,
  "translated grouping preserves line timing",
);

const legacy = parseTranscriptPayload([
  { start: 0, end: 0.5, value: "Legacy" },
]);
assert(legacy.language === "en", "bare legacy word arrays infer English");
assert(legacy.words.length === 1, "legacy words still parse");

assert(
  isOriginalCaptionLanguage("es", "Spanish"),
  "es and Spanish count as the original language",
);
assert(
  !isOriginalCaptionLanguage("es", "en"),
  "Spanish is not original when the source is English",
);

assert(
  orderedOriginalTranscriptUrls({
    transcriptionCandidates: [
      "https://cdn.test/versioned-original.json",
      "https://cdn.test/en.json",
    ],
    transcriptionUrl: "https://cdn.test/en.json",
  }).join(",") ===
    [
      "https://cdn.test/versioned-original.json",
      "https://cdn.test/en.json",
    ].join(","),
  "editor preserves canonical Whisper fallback order without duplicates",
);

console.log("transcript.test: ok");

// --- words in the cut: overlap, not containment
{
  // Real case: "We" (233.82-234.18) starts 0.04s before the segment (233.8626).
  const cut = wordsOverlappingSegments(
    words([[233.42, 233.64, "x"], [233.82, 234.18, "We"], [234.2, 234.4, "got"], [329.4, 329.7, "end"], [329.5, 330, "after"]]),
    [{ startTime: 233.8626, endTime: 329.5 }],
  );
  const values = cut.map((w) => w.value).join(" ");
  assert(values === "We got end", `a word cut by a segment edge stays (got "${values}")`);
  assert(wordsOverlappingSegments(words([[1, 2, "touch"]]), [{ startTime: 2, endTime: 3 }]).length === 0, "a word ending exactly at the segment start is outside");
}
