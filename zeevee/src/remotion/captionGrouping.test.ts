import {
  addedWords,
  applyWordEdits,
  separateTypedWords,
  CAPTION_HOLD_SECONDS,
  captionCharsPerLine,
  captionGroupingOptions,
  captionLineCount,
  captionTextFromWords,
  captionWordText,
  groupWordsIntoCaptions,
  holdCaptions,
  isDeletedCaptionWord,
  outputFrameForAspect,
} from "./captionGrouping";
import { activeCaptionAt, activeWordIndexAt } from "./captionTiming";
import { resolveCaptionContent } from "./captionContent";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}
function close(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

// --- word editing and legacy markers
assert(captionWordText("tonight\n") === "tonight", "legacy marker stripped from text");
assert(captionWordText("  hi \n") === "hi", "text is trimmed");
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
assert(captionLineCount([w("aaaa\n"), w("bbbb")], 100) === 1, "legacy break marker no longer forces a line");
assert(captionLineCount([w("aaaa"), w(""), w("bbbb")], 9) === 1, "deleted words take no space");
assert(captionTextFromWords([w("a\n"), w(""), w("b"), w("c")]) === "a b c", "legacy breaks are ignored and deleted words dropped");

// --- grouping: fit to two lines
const sentence = "the quick brown fox jumps over the lazy dog again and again".split(" ");
const words = sentence.map((value, i) => ({ start: i * 0.3, end: i * 0.3 + 0.25, value }));
const unlimited = groupWordsIntoCaptions(words);
assert(unlimited.length === 2 && unlimited.every((c) => c.words!.length <= 8), "default: at most 8 words per caption");
const fitted = groupWordsIntoCaptions(words, { maxCharsPerLine: 12, maxLines: 2, holdSeconds: 0 });
for (const c of fitted) {
  assert(captionLineCount(c.words!, 12) <= 2, `caption "${c.text}" fits in 2 lines of 12`);
}
assert(fitted.length > unlimited.length, "narrow box makes more captions");
assert(fitted.map((c) => c.text.replace(/\n/g, " ")).join(" ") === sentence.join(" "), "no words lost or reordered");

// Look ahead across the phrase so a 9-word thought does not become 8 + 1.
const nineWords = "we need to make caption chunks feel natural today".split(" ")
  .map((value, i) => w(value, i * 0.25));
const balanced = groupWordsIntoCaptions(nineWords, { holdSeconds: 0 });
assert(balanced.length === 2, "nine words use two captions");
assert(balanced.map((c) => c.words!.length).join(",") === "4,5", `balanced 4 + 5 split: ${balanced.map((c) => c.words!.length)}`);
assert(balanced.map((c) => c.text).join(" ") === nineWords.map((word) => word.value).join(" "), "balanced groups preserve all words");

// Sentence punctuation is the preferred boundary when it does not strand a word.
const sentences = "We can fix this. Then ship it today.".split(" ")
  .map((value, i) => w(value, i * 0.25));
const ideas = groupWordsIntoCaptions(sentences, { holdSeconds: 0 });
assert(ideas.map((c) => c.text).join(" | ") === "We can fix this. | Then ship it today.", "sentence boundary wins");
const strandedSentence = "We can fix this quickly and today. Tomorrow".split(" ")
  .map((value, i) => w(value, i * 0.25));
const noStrandedSentence = groupWordsIntoCaptions(strandedSentence, { holdSeconds: 0 });
assert(noStrandedSentence.every((c) => c.words!.length > 1), "a sentence boundary cannot strand a single word");

// deleted words are dropped and do not count
const withDeleted = groupWordsIntoCaptions(
  [w("a", 0), w("", 0.3), w("", 0.6), w("b", 0.9)],
  { maxWords: 2, minPauseBetweenLines: Number.POSITIVE_INFINITY, holdSeconds: 0 },
);
assert(withDeleted.length === 1 && withDeleted[0].words!.length === 2, "deleted words dropped, not counted");
assert(withDeleted[0].text === "a b", "deleted words leave no gap in text");
assert(groupWordsIntoCaptions([w("", 0)]).length === 0, "all-deleted yields no caption");
assert(groupWordsIntoCaptions([]).length === 0, "no words, no captions");

// Timing and fit limits still hold
const paused = groupWordsIntoCaptions([w("a", 0), w("b", 0.2), w("c", 1.0)]);
assert(paused.length === 2, "0.6s pause splits a line");
const long = groupWordsIntoCaptions([w("a", 0), w("b", 1), w("c", 2), w("d", 3.5)], { minPauseBetweenLines: Number.POSITIVE_INFINITY });
assert(long.length === 2, "3s max duration splits");

// --- hold: 3.5s after the last word, or until the next caption starts
const held = groupWordsIntoCaptions([w("a", 0), w("b", 0.3), w("c", 2.0), w("d", 20)]);
assert(held.length === 3, "three captions");
assert(close(held[0].speechEndTime!, 0.5) && close(held[0].endTime, 2.0), "held until next caption starts");
assert(close(held[1].speechEndTime!, 2.2) && close(held[1].endTime, 2.2 + CAPTION_HOLD_SECONDS), "held 3.5s when the gap is long");
assert(close(held[2].endTime, 20.2 + CAPTION_HOLD_SECONDS), "last caption holds 3.5s");
assert(activeCaptionAt(held, 1.9)?.id === held[0].id, "caption stays visible during the hold");
assert(activeCaptionAt(held, 5.6)?.id === held[1].id, "still visible 3.4s after speech");
assert(activeCaptionAt(held, 5.8) === undefined, "gone after 3.5s");
assert(activeWordIndexAt(held[1].words!, 2.1, held[1].endTime) === 0, "last word highlighted while spoken");
assert(activeWordIndexAt(held[1].words!, 5.6, held[1].endTime) === 0, "last word stays highlighted through the hold");
assert(activeWordIndexAt(held[1].words!, 5.8, held[1].endTime) === -1, "no highlight once the hold ends");
assert(activeWordIndexAt(held[0].words!, 1.9, held[0].endTime) === 1, "last word highlighted until the next caption starts");
assert(activeCaptionAt(held, 1.9, 1.0) === undefined, "a held caption never carries into a segment that starts after its speech");
assert(activeCaptionAt(held, 0.4, 0.2)?.id === held[0].id, "a caption still speaking at the segment start shows");
const twice = holdCaptions(holdCaptions([{ id: "t", startTime: 1, endTime: 2, text: "x" }]));
assert(close(twice[0].endTime, 2 + CAPTION_HOLD_SECONDS) && close(twice[0].speechEndTime!, 2), "hold is idempotent on translation lines");

// --- renderer content: deleted words hidden, legacy markers ignored
const content = resolveCaptionContent({ text: "", words: [w("a\n"), w("\n"), w("b")] });
assert(content.mode === "words" && content.words.length === 2, "legacy marker-only word is a deletion");

// --- word edits: text, timing, and typed-in missing words
const source = [
  { start: 1, end: 1.5, value: "hello" },
  { start: 2, end: 2.4, value: "wurld" },
  { start: 3, end: 3.6, value: "the" },
];
const applied = applyWordEdits(source, {
  "1-1.5": { value: "hello", start: 2.5, end: 2.9 },
  "2-2.4": "world",
  "3-3.6": "the big",
});
assert(applied.map((x) => x.value).join(" ") === "world hello the big", "timing edit reorders by start");
assert(applied[1].start === 2.5 && applied[1].end === 2.9, "timing edit moves the word");
assert(applied[0].start === 2 && applied[0].end === 2.4, "text edit keeps the original timing");
assert(close(applied[2].end, 3.3) && close(applied[3].start, 3.3) && applied[3].end === 3.6, "typed-in words split the time evenly");
assert(applyWordEdits(source, { "2-2.4": "" })[1].value === "", "empty edit still deletes");
assert(applyWordEdits(source, null).length === 3, "no edits leaves the words alone");
// Editing one word never touches any other word's text or timing.
{
  const many = Array.from({ length: 6 }, (_, i) => ({ start: i, end: i + 0.5, value: `w${i}` }));
  const before = applyWordEdits(many, null);
  const after = applyWordEdits(many, { "2-2.5": { value: "w2", start: 2.3, end: 3.4 } });
  for (const word of before.filter((x) => x.value !== "w2")) {
    const same = after.find((x) => x.value === word.value)!;
    assert(same.start === word.start && same.end === word.end, `${word.value} keeps its timing`);
  }
  assert(after.length === before.length, "no words added or lost");
}

// --- typed-in words become separate, individually timed words
{
  const separated = separateTypedWords({
    "99.2-100.1": { value: "songwriter, Waddy White.", start: 97.5, end: 98.4 },
    "24.18-24.3": "Daddy! Help",
    "5-6": "fine",
  });
  assert(JSON.stringify(separated["99.2-100.1"]) === JSON.stringify({ value: "songwriter,", start: 97.5, end: 97.8 }), "first word keeps the key");
  assert(JSON.stringify(separated["+99.2-100.1.1"]) === JSON.stringify({ value: "Waddy", start: 97.8, end: 98.1 }), "second word is added");
  assert(JSON.stringify(separated["+99.2-100.1.2"]) === JSON.stringify({ value: "White.", start: 98.1, end: 98.4 }), "third word is added");
  assert(JSON.stringify(separated["24.18-24.3"]) === JSON.stringify({ value: "Daddy!", start: 24.18, end: 24.24 }), "string edit uses the key's timing");
  assert(separated["5-6"] === "fine", "single words untouched");
  assert(addedWords(separated).length === 3, "three added words");
  const plain = { "5-6": "fine" };
  assert(separateTypedWords(plain) === plain, "nothing to separate returns the same object");
  // Separating never changes what the captions show.
  const words = [{ start: 24.18, end: 24.3, value: "x" }, { start: 99.2, end: 100.1, value: "y" }];
  const legacy = { "99.2-100.1": { value: "songwriter, Waddy White.", start: 97.5, end: 98.4 }, "24.18-24.3": "Daddy! Help" };
  const show = (e: Record<string, unknown>) =>
    applyWordEdits(words, e as never).map((x) => `${x.value}@${x.start.toFixed(3)}-${x.end.toFixed(3)}`).join(" ");
  assert(show(legacy) === show(separateTypedWords(legacy)), `same captions (${show(legacy)} vs ${show(separateTypedWords(legacy))})`);
  // A second split of an added word picks a free key.
  const again = separateTypedWords({ ...separated, "+99.2-100.1.1": { value: "Waddy Waddy", start: 97.8, end: 98.1 } });
  assert(
    (again["+99.2-100.1.1.1"] as { value: string }).value === "Waddy" && Object.keys(again).length === 7,
    `splitting an added word adds one more (${Object.keys(again).join(", ")})`,
  );
}

console.log("captionGrouping tests passed");
