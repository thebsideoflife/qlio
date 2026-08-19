import { resolveCaptionContent } from "./captionContent";
import { activeCaptionAt } from "./captionTiming";
import type { CaptionLine } from "./types";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const translation = resolveCaptionContent({
  text: "Mira, así es como quería que se viera el",
  words: [],
});
assert(translation.mode === "text", "empty words still show translation text");
assert(
  translation.mode === "text" &&
    translation.text === "Mira, así es como quería que se viera el",
  "translation text is used as-is",
);

const missingWords = resolveCaptionContent({
  text: "Hola mundo",
});
assert(
  missingWords.mode === "text" && missingWords.text === "Hola mundo",
  "omitted words array still shows the line text",
);

const original = resolveCaptionContent({
  text: "Look this is how",
  words: [
    { start: 19.28, end: 19.5, value: "Look" },
    { start: 19.5, end: 19.8, value: "this" },
  ],
});
assert(original.mode === "words", "word-timed originals keep karaoke words");
assert(
  original.mode === "words" && original.words.length === 2,
  "original words are not collapsed into line text",
);

const deleted = resolveCaptionContent({
  text: "",
  words: [{ start: 1, end: 2, value: "" }],
});
assert(deleted.mode === "empty", "deleted words with no line text stay empty");

const timedLines: CaptionLine[] = [
  {
    id: "first",
    startTime: 10,
    endTime: 12,
    text: "First",
    words: [{ start: 10, end: 12, value: "First" }],
  },
  {
    id: "translation",
    startTime: 12,
    endTime: 14,
    text: "Segunda frase",
    words: [],
  },
];
assert(
  activeCaptionAt(timedLines, 11.999)?.id === "first",
  "shared renderer keeps a caption active until its exclusive end",
);
assert(
  activeCaptionAt(timedLines, 12)?.id === "translation",
  "editor and Remotion share the same exact boundary transition",
);
assert(
  activeCaptionAt(timedLines, 14) === undefined,
  "shared renderer hides captions at their exclusive end",
);

console.log("captionContent.test: ok");
