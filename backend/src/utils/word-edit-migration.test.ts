import { migrateWordEdits, wordEditKey } from "./word-edit-migration";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const w = (start: number, end: number, value: string) => ({ start, end, value });

// Same word, shifted timing: text edit, deletion and emoji all follow the word.
const previous = [
  w(91.86, 92.08, "the"),
  w(96.32, 96.58, "leave"),
  w(110.66, 110.82, "Bella."),
  w(120.0, 120.3, "um"),
];
const next = [
  w(91.9, 92.1, "the"),
  w(96.3, 96.6, "leave"),
  w(110.7, 110.9, "Bella"),
  w(120.05, 120.3, "um,"),
];
const a = migrateWordEdits(previous, next, {
  [wordEditKey(previous[0])]: "",
  [wordEditKey(previous[1])]: "need",
  [wordEditKey(previous[2])]: "mouth.",
  [wordEditKey(previous[3])]: "❤️",
});
assert(a.migrated === 4 && a.dropped.length === 0, `all four follow their words (${a.migrated}, ${JSON.stringify(a.dropped)})`);
assert(a.wordEdits[wordEditKey(next[0])] === "", "deletion follows the same word");
assert(a.wordEdits[wordEditKey(next[1])] === "need", "text change follows");
assert(a.wordEdits[wordEditKey(next[2])] === "mouth.", "punctuation differences still match");
assert(a.wordEdits[wordEditKey(next[3])] === "❤️", "emoji edit follows");

// Different word at the same time: a text change moves by overlap, a deletion does not.
const b = migrateWordEdits(
  [w(10, 10.4, "Mayor"), w(11, 11.3, "hello")],
  [w(10.02, 10.4, "Mere"), w(11.0, 11.3, "yellow")],
  { [wordEditKey(w(10, 10.4, "Mayor"))]: "Mayor", [wordEditKey(w(11, 11.3, "hello"))]: "" },
);
assert(b.wordEdits["10.02-10.4"] === "Mayor", "text change placed on the overlapping word");
assert(!("11-11.3" in b.wordEdits), "a deletion never removes a different word");
assert(b.dropped.length === 1 && b.dropped[0].reason === "no-matching-word", "unplaced deletion is reported");

// Doubled words in the old transcript collapse to one: the closer edit wins.
const c = migrateWordEdits(
  [w(20, 20.2, "What"), w(20.2, 20.4, "What")],
  [w(20.05, 20.3, "What")],
  { "20-20.2": "What?", "20.2-20.4": "" },
);
assert(c.migrated === 1 && c.wordEdits["20.05-20.3"] === "What?", "closer edit keeps the word");
assert(c.dropped[0]?.reason === "taken-by-closer-edit", "the other is reported");

// Edits that no longer applied to the previous transcript are reported, not moved.
const d = migrateWordEdits([w(1, 2, "a")], [w(1, 2, "a")], { "5-6": "x" });
assert(d.migrated === 0 && d.dropped[0].reason === "not-in-previous-transcript", "stale edit reported");

// Far away words never match.
const e = migrateWordEdits([w(50, 50.2, "gun")], [w(52, 52.2, "gun")], { "50-50.2": "GUN" });
assert(e.migrated === 0, "no match outside the window");

console.log("word-edit-migration tests passed");
