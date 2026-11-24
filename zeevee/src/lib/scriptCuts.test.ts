/**
 * Clip cut markers in the script.
 *
 * Run: npx tsx --tsconfig tsconfig.app.json src/lib/scriptCuts.test.ts
 */
import { clipFromWords, scriptClipMarks, wordsInAnyClip } from "./scriptCuts";

let checks = 0;
let failures = 0;
function assertEqual<T>(actual: T, expected: T, message: string): void {
  checks++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`  FAIL: ${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const words = [
  { key: "a", start: 9.0, end: 9.4 },
  { key: "b", start: 9.6, end: 10.2 },
  { key: "c", start: 10.5, end: 11.0 },
  { key: "d", start: 19.5, end: 19.9 },
  { key: "e", start: 19.95, end: 20.4 },
  { key: "f", start: 21.0, end: 21.5 },
];

const marks = scriptClipMarks(words, { startTime: 10, endTime: 20 }, 24);
assertEqual(marks.inKey, "b", "in marker on first word heard");
assertEqual(marks.outKey, "e", "out marker on last word heard");
assertEqual(marks.inSplitsWord, true, "cut at 10.0 splits 'b'");
assertEqual(marks.outSplitsWord, true, "cut at 20.0 splits 'e'");
assertEqual([...marks.inClip], ["b", "c", "d", "e"], "words in clip");

const clean = scriptClipMarks(words, { startTime: 9.6, endTime: 11.0 }, 24);
assertEqual([clean.inKey, clean.outKey, clean.inSplitsWord, clean.outSplitsWord], ["b", "c", false, false], "cuts on word edges");

const grazing = scriptClipMarks(words, { startTime: 10.19, endTime: 19.88 }, 24);
assertEqual([grazing.inKey, grazing.outKey], ["c", "d"], "a word barely touched at the start is not heard");

assertEqual(scriptClipMarks(words, null, 24).inKey, null, "no clip, no markers");
assertEqual(scriptClipMarks(words, { startTime: 30, endTime: 40 }, 24).inKey, null, "no words in clip");

assertEqual(
  [...wordsInAnyClip(words, [{ startTime: 9, endTime: 9.5 }, { startTime: 21, endTime: 22 }])],
  ["a", "f"],
  "words in any clip",
);

const c = clipFromWords(words[1], words[2], 24, 100);
assertEqual([c.start * 24, c.end * 24], [230, 264], "clip from words is frame aligned and keeps both words");
const tiny = clipFromWords({ start: 5, end: 5.01 }, { start: 5, end: 5.01 }, 24, 100);
assertEqual(Math.round((tiny.end - tiny.start) * 24), 3, "one short word still makes a legal clip");

if (failures) {
  console.error(`script-cuts: ${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`script-cuts: ${checks} checks passed`);
