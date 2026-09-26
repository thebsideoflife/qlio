/**
 * caption-grouping.ts must stay byte-identical to the editor's copy, and the
 * server's caption selection must honour speechEndTime (the hold).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { groupWordsIntoCaptions, captionGroupingOptions } from "./caption-grouping";
import {
  captionsFromParsedTranscript,
  captionsOverlappingRange,
  shiftCaptionsBy,
} from "./transcript-format";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const here = resolve(__dirname);
const backendCopy = readFileSync(resolve(here, "caption-grouping.ts"), "utf8");
const frontendCopy = readFileSync(
  resolve(here, "../../../zeevee/src/remotion/captionGrouping.ts"),
  "utf8",
);
assert(
  backendCopy === frontendCopy,
  "backend/src/utils/caption-grouping.ts must be byte-identical to zeevee/src/remotion/captionGrouping.ts (copy it over)",
);

const w = (value: string, start: number) => ({ start, end: start + 0.2, value });
const captions = groupWordsIntoCaptions([w("a", 0), w("b", 0.3), w("c", 2.0), w("d", 20)]);
assert(captions.length === 3, "three captions");
assert(captions[0].endTime === 2.0 && captions[0].speechEndTime === 0.5, "held until the next caption");

// A segment starting after the speech but inside the hold must not include it.
assert(captionsOverlappingRange(captions, 1.0, 1.9).length === 0, "hold does not pull a caption into a later segment");
assert(captionsOverlappingRange(captions, 0.4, 1.9).length === 1, "a caption still speaking at the segment start is included");
const shifted = shiftCaptionsBy(captionsOverlappingRange(captions, 0.4, 1.9), -0.4);
assert(Math.abs(shifted[0].speechEndTime! - 0.1) < 1e-9 && Math.abs(shifted[0].endTime - 1.6) < 1e-9, "shift keeps speechEndTime");

// Translation lines get the hold too; originals use the style-derived fit.
const translated = captionsFromParsedTranscript({
  kind: "translation",
  language: "es",
  sourceLanguage: "en",
  lines: [
    { id: "l0", startTime: 0, endTime: 1, text: "Hola" },
    { id: "l1", startTime: 10, endTime: 11, text: "Adiós" },
  ],
} as any);
assert(translated[0].endTime === 4.5 && translated[0].speechEndTime === 1, "translation line held 3.5s");

const longWords = "extraordinary photographs demonstrate sophisticated cinematography during celebrations".split(" ").map((value, i) => w(value, i * 0.3));
const original = { kind: "original", language: "en", words: longWords } as any;
const wide = captionsFromParsedTranscript(original, undefined, captionGroupingOptions({ fontSize: 3, maxWidth: 95 }, "16:9"));
const narrow = captionsFromParsedTranscript(original, undefined, captionGroupingOptions({ fontSize: 4, maxWidth: 95 }, "9:16"));
assert(narrow.length > wide.length, `portrait L font makes more captions (${narrow.length} vs ${wide.length})`);

// Legacy line-break edits are treated as plain word text.
const edited = captionsFromParsedTranscript(original, { "0.3-0.5": "quick\n" });
assert(edited[0].text.startsWith("extraordinary quick demonstrate"), `legacy marker ignored: ${JSON.stringify(edited[0].text)}`);

console.log("caption-grouping tests passed");
