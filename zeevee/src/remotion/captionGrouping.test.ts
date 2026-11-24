import {
  addedWords,
  applyWordEdits,
  separateTypedWords,
  CAPTION_BRIDGE_GAP,
  CAPTION_HOLD_SECONDS,
  CAPTION_MIN_DISPLAY,
  CAPTION_READING_CPS,
  captionCharsPerLine,
  captionReadingTime,
  checkCaptions,
  chooseLineBreak,
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

// --- hold: a short linger, reading time, no flicker, never into the next caption
const held = groupWordsIntoCaptions([w("a", 0), w("b", 0.3), w("c", 2.0), w("d", 20)]);
assert(held.length === 3, "three captions");
assert(close(held[0].speechEndTime!, 0.5) && close(held[0].endTime, 1.0), `held 0.5s past speech (${held[0].endTime})`);
assert(close(held[1].speechEndTime!, 2.2) && close(held[1].endTime, 2.0 + CAPTION_MIN_DISPLAY), "a short caption is held to its minimum display time");
assert(close(held[2].endTime, 20.0 + CAPTION_MIN_DISPLAY), "a one-word caption still stays up its minimum time");
assert(activeCaptionAt(held, 0.9)?.id === held[0].id, "caption stays visible during the hold");
assert(activeCaptionAt(held, 1.5) === undefined, "gone soon after speech ends");
assert(activeWordIndexAt(held[1].words!, 2.1, held[1].endTime) === 0, "last word highlighted while spoken");
assert(activeWordIndexAt(held[1].words!, 2.7, held[1].endTime) === 0, "last word stays highlighted through the hold");
assert(activeWordIndexAt(held[1].words!, 2.9, held[1].endTime) === -1, "no highlight once the hold ends");
assert(activeCaptionAt(held, 0.9, 0.7) === undefined, "a held caption never carries into a segment that starts after its speech");
assert(activeCaptionAt(held, 0.4, 0.2)?.id === held[0].id, "a caption still speaking at the segment start shows");
const twice = holdCaptions(holdCaptions([{ id: "t", startTime: 1, endTime: 2, text: "x" }]));
assert(close(twice[0].endTime, 2 + CAPTION_HOLD_SECONDS) && close(twice[0].speechEndTime!, 2), "hold is idempotent on translation lines");
// A short gap is bridged so captions don't flicker off and on
const bridged = holdCaptions([
  { id: "p", startTime: 0, endTime: 1, text: "one two" },
  { id: "q", startTime: 1.9, endTime: 3, text: "three" },
]);
assert(close(bridged[0].endTime, 1.9), `gap under ${CAPTION_BRIDGE_GAP}s is closed (${bridged[0].endTime})`);
// Long text earns reading time, but never covers the next caption
const reading = holdCaptions([
  { id: "r", startTime: 0, endTime: 0.5, text: "a".repeat(51) },
  { id: "s", startTime: 10, endTime: 11, text: "b" },
]);
assert(close(reading[0].endTime, 51 / CAPTION_READING_CPS), "51 characters get 3 s to read");
const squeezed = holdCaptions([
  { id: "r", startTime: 0, endTime: 0.5, text: "a".repeat(51) },
  { id: "s", startTime: 1.2, endTime: 2, text: "b" },
]);
assert(close(squeezed[0].endTime, 1.2), "reading time stops at the next caption");
assert(close(captionReadingTime("hi"), CAPTION_MIN_DISPLAY), "minimum display time");

// --- line breaks at phrase boundaries (runbook step 4)
const words2 = (text: string) => text.split(" ").map((value, i) => w(value, i * 0.3));
const lineBreak = (text: string, max: number) => {
  const ws = words2(text);
  const k = chooseLineBreak(ws, max);
  return k == null ? null : `${ws.slice(0, k).map((x) => x.value).join(" ")} / ${ws.slice(k).map((x) => x.value).join(" ")}`;
};
// The runbook's "avoid" breaks are never chosen
for (const [text, max, avoid] of [
  ["I went to the store yesterday.", 23, "I went to the / store yesterday."],
  ["This is the biggest problem we've had.", 28, "This is the biggest / problem we've had."],
  ["I can't believe you actually did that.", 26, "I can't believe you / actually did that."],
  ["I don't know what you're talking about.", 32, "I don't know what you're talking / about."],
  ["I don't know what you're talking about.", 26, "I don't know what you're / talking about."],
] as const) {
  const got = lineBreak(text, max);
  assert(got !== null && got !== avoid, `"${text}" avoids "${avoid}" (got "${got}")`);
  const lastOfTop = got!.split(" / ")[0].split(" ").pop()!.toLowerCase();
  assert(!["the", "a", "to", "you", "is", "and"].includes(lastOfTop), `"${got}" doesn't end a line on "${lastOfTop}"`);
}
assert(lineBreak("I don't know what you're talking about.", 26) === "I don't know / what you're talking about.", `${lineBreak("I don't know what you're talking about.", 26)}`);
assert(lineBreak("Well, I can't believe you actually did that.", 30)!.startsWith("Well, I can't believe /"), `${lineBreak("Well, I can't believe you actually did that.", 30)}`);
assert(lineBreak("He told me John Smith was here", 22) !== "He told me John / Smith was here", "first and last names stay together");
assert(lineBreak("short line", 30) === null, "fits on one line: no break");
const grouped = groupWordsIntoCaptions(words2("I don't know what you're talking about."), { maxCharsPerLine: 26 });
assert(grouped.length === 1 && grouped[0].lineBreakBefore === grouped[0].words![3].start, "grouping records the chosen break");
assert(groupWordsIntoCaptions(words2("all on one line"), { maxCharsPerLine: 40 })[0].lineBreakBefore === undefined, "one-line captions carry no break");

// --- reveals: a sentence-ending word after a beat gets its own caption
const reveal = [
  { start: 0, end: 0.2, value: "And" },
  { start: 0.25, end: 0.45, value: "the" },
  { start: 0.5, end: 0.8, value: "killer" },
  { start: 0.85, end: 1.0, value: "was" },
  { start: 1.25, end: 1.7, value: "Michael." },
];
const revealed = groupWordsIntoCaptions(reveal);
assert(revealed.map((c) => c.text).join(" | ") === "And the killer was | Michael.", `reveal held back: ${revealed.map((c) => c.text).join(" | ")}`);
const noBeat = groupWordsIntoCaptions(reveal.map((x, i) => i === 4 ? { ...x, start: 1.05 } : x));
assert(noBeat.length === 1, "without a beat the sentence stays together");

// --- automatic checks (runbook step 8)
const checked = checkCaptions([
  { id: "ok", startTime: 0, endTime: 2, text: "a fine caption", words: words2("a fine caption") },
  { id: "fast", startTime: 0, endTime: 1, text: "x".repeat(30) },
  { id: "brief", startTime: 0, endTime: 0.5, text: "hi" },
  { id: "strand", startTime: 0, endTime: 5, text: "So what are you doing", words: words2("So what are you doing"), lineBreakBefore: 0.3 },
]);
assert(!checked.some((c) => c.id === "ok"), "a good caption passes");
assert(checked.find((c) => c.id === "fast")!.issues.includes("too_fast"), "30 chars in 1s is too fast");
assert(checked.find((c) => c.id === "brief")!.issues.includes("too_brief"), "0.5s is too brief");
assert(checked.find((c) => c.id === "strand")!.issues.includes("stranded_word"), "one word on a line is flagged");

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
  assert(JSON.stringify(separated["99.2-100.1"]) === JSON.stringify({ value: "songwriter,", start: 97.5, end: 97.8, estimated: true }), "first word keeps the key");
  assert(JSON.stringify(separated["+99.2-100.1.1"]) === JSON.stringify({ value: "Waddy", start: 97.8, end: 98.1, estimated: true }), "second word is added");
  assert(JSON.stringify(separated["+99.2-100.1.2"]) === JSON.stringify({ value: "White.", start: 98.1, end: 98.4, estimated: true }), "third word is added");
  assert(JSON.stringify(separated["24.18-24.3"]) === JSON.stringify({ value: "Daddy!", start: 24.18, end: 24.24, estimated: true }), "string edit uses the key's timing");
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
