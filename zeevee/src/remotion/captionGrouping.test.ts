import {
  CAPTION_HOLD_SECONDS,
  captionCharsPerLine,
  captionGroupingOptions,
  captionLineCount,
  captionTextFromWords,
  captionWordText,
  groupWordsIntoCaptions,
  hasCaptionLineBreak,
  holdCaptions,
  isDeletedCaptionWord,
  outputFrameForAspect,
  withCaptionLineBreak,
} from "./captionGrouping";
import { activeCaptionAt } from "./captionTiming";
import { resolveCaptionContent } from "./captionContent";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}
function close(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

// --- line-break marker helpers
assert(captionWordText("tonight\n") === "tonight", "marker stripped from text");
assert(captionWordText("  hi \n") === "hi", "text is trimmed");
assert(hasCaptionLineBreak("tonight\n"), "trailing newline is a break");
assert(!hasCaptionLineBreak("tonight"), "plain word has no break");
assert(withCaptionLineBreak("tonight", true) === "tonight\n", "adds marker");
assert(withCaptionLineBreak("tonight\n", false) === "tonight", "removes marker");
assert(withCaptionLineBreak("", true) === "", "a deleted word keeps no marker");
assert(isDeletedCaptionWord("") && isDeletedCaptionWord("\n") && isDeletedCaptionWord("  "), "empty text is deleted");
assert(!isDeletedCaptionWord("a"), "non-empty is kept");

// --- fit budget
assert(outputFrameForAspect("9:16").height === 1920, "portrait frame");
assert(outputFrameForAspect("1:1").width === 1080 && outputFrameForAspect("1:1").height === 1080, "square frame");
assert(outputFrameForAspect(undefined).width === 1920, "default landscape frame");
const portraitChars = captionCharsPerLine({ fontSize: 3, maxWidth: 95 }, outputFrameForAspect("9:16"));
const landscapeChars = captionCharsPerLine({ fontSize: 3, maxWidth: 95 }, outputFrameForAspect("16:9"));
const bigPortraitChars = captionCharsPerLine({ fontSize: 4, maxWidth: 95 }, outputFrameForAspect("9:16"));
assert(portraitChars >= 25 && portraitChars <= 35, `portrait M budget is ~30 chars (${portraitChars})`);
assert(landscapeChars > 90, `landscape budget is wide (${landscapeChars})`);
assert(bigPortraitChars < portraitChars, "larger font fits fewer chars");
assert(captionGroupingOptions(undefined, "9:16").maxCharsPerLine === undefined, "no style, no limit");
assert(captionGroupingOptions({ fontSize: 3, maxWidth: 95 }, "9:16").maxCharsPerLine === portraitChars, "options use the budget");

// --- line counting
const w = (value: string, start = 0) => ({ start, end: start + 0.2, value });
assert(captionLineCount([w("aaaa"), w("bbbb")], 9) === 1, "9 chars fit one line");
assert(captionLineCount([w("aaaa"), w("bbbb")], 8) === 2, "space counts, wraps to 2");
assert(captionLineCount([w("aaaa\n"), w("bbbb")], 100) === 2, "manual break makes 2 lines");
assert(captionLineCount([w("aaaa\n")], 100) === 1, "trailing break adds no empty line");
assert(captionLineCount([w("aaaa"), w(""), w("bbbb")], 9) === 1, "deleted words take no space");
assert(captionTextFromWords([w("a\n"), w(""), w("b"), w("c")]) === "a\nb c", "text uses newline at breaks and drops deleted");

// --- grouping: fit to two lines
const sentence = "the quick brown fox jumps over the lazy dog again and again".split(" ");
const words = sentence.map((value, i) => ({ start: i * 0.3, end: i * 0.3 + 0.25, value }));
const unlimited = groupWordsIntoCaptions(words);
assert(unlimited.length === 2 && unlimited[0].words!.length === 8, "default: 8 words per caption");
const fitted = groupWordsIntoCaptions(words, { maxCharsPerLine: 12, maxLines: 2, holdSeconds: 0 });
for (const c of fitted) {
  assert(captionLineCount(c.words!, 12) <= 2, `caption "${c.text}" fits in 2 lines of 12`);
}
assert(fitted.length > unlimited.length, "narrow box makes more captions");
assert(fitted.map((c) => c.text.replace(/\n/g, " ")).join(" ") === sentence.join(" "), "no words lost or reordered");

// a manual break that would need a third line starts a new caption
const broken = groupWordsIntoCaptions(
  [w("aaaa", 0), w("bbbb\n", 0.3), w("cccc", 0.6), w("dddd\n", 0.9), w("eeee", 1.2)],
  { maxCharsPerLine: 9, holdSeconds: 0 },
);
assert(broken.length === 2, `manual breaks: 2 captions (${broken.length})`);
assert(broken[0].text === "aaaa bbbb\ncccc dddd", `first caption keeps the break: ${JSON.stringify(broken[0].text)}`);
assert(broken[1].text === "eeee", "third line starts a new caption");

// deleted words are dropped and do not count
const withDeleted = groupWordsIntoCaptions(
  [w("a", 0), w("", 0.3), w("", 0.6), w("b", 0.9)],
  { maxWords: 2, minPauseBetweenLines: Number.POSITIVE_INFINITY, holdSeconds: 0 },
);
assert(withDeleted.length === 1 && withDeleted[0].words!.length === 2, "deleted words dropped, not counted");
assert(withDeleted[0].text === "a b", "deleted words leave no gap in text");
assert(groupWordsIntoCaptions([w("", 0)]).length === 0, "all-deleted yields no caption");
assert(groupWordsIntoCaptions([]).length === 0, "no words, no captions");

// original rules still hold
const paused = groupWordsIntoCaptions([w("a", 0), w("b", 0.2), w("c", 1.0)]);
assert(paused.length === 2, "0.6s pause splits a line");
const long = groupWordsIntoCaptions([w("a", 0), w("b", 1), w("c", 2), w("d", 3.5)], { minPauseBetweenLines: Number.POSITIVE_INFINITY });
assert(long.length === 2, "3s max duration splits");

// --- hold: 5s after the last word, or until the next caption starts
const held = groupWordsIntoCaptions([w("a", 0), w("b", 0.3), w("c", 2.0), w("d", 20)]);
assert(held.length === 3, "three captions");
assert(close(held[0].speechEndTime!, 0.5) && close(held[0].endTime, 2.0), "held until next caption starts");
assert(close(held[1].speechEndTime!, 2.2) && close(held[1].endTime, 2.2 + CAPTION_HOLD_SECONDS), "held 5s when the gap is long");
assert(close(held[2].endTime, 20.2 + CAPTION_HOLD_SECONDS), "last caption holds 5s");
assert(activeCaptionAt(held, 1.9)?.id === held[0].id, "caption stays visible during the hold");
assert(activeCaptionAt(held, 6.0)?.id === held[1].id, "still visible 3.8s after speech");
assert(activeCaptionAt(held, 7.3) === undefined, "gone after 5s");
assert(activeCaptionAt(held, 1.9, 1.0) === undefined, "a held caption never carries into a segment that starts after its speech");
assert(activeCaptionAt(held, 0.4, 0.2)?.id === held[0].id, "a caption still speaking at the segment start shows");
const twice = holdCaptions(holdCaptions([{ id: "t", startTime: 1, endTime: 2, text: "x" }]));
assert(close(twice[0].endTime, 2 + CAPTION_HOLD_SECONDS) && close(twice[0].speechEndTime!, 2), "hold is idempotent on translation lines");

// --- renderer content: deleted-by-marker words hidden, break words kept
const content = resolveCaptionContent({ text: "", words: [w("a\n"), w("\n"), w("b")] });
assert(content.mode === "words" && content.words.length === 2, "break-only word is a deletion");

console.log("captionGrouping tests passed");
