/**
 * How expensive is the coverage gate to clear?
 *
 * A hard gate is only reasonable if satisfying it is cheap. This walks a real
 * transcript (and synthetic ones at other lengths) the way the agent would —
 * repeated read_transcript calls from wherever the last one stopped — and
 * reports how many calls it takes to leave no blind spots.
 *
 *   npx tsx src/scripts/check-coverage-cost.ts [path-to-transcript.json]
 */

import { readFileSync } from "node:fs";
import { blindSpotFloor, findBlindSpots, recordExamined } from "../services/iq-agent/examined";
import { fmt } from "../services/iq-agent/ledger";
import { runReadTranscript, type TranscriptWord } from "../services/iq-agent/tools/transcript";
import type { Interval } from "../services/iq-agent/types";

function sweep(words: TranscriptWord[], duration: number): { calls: number; cleared: boolean } {
  let examined: Interval[] = [];
  let cursor = 0;
  let calls = 0;

  // The obvious strategy: ask for everything from here to the end, and let
  // truncation tell you where you actually got to.
  while (calls < 100) {
    const result = runReadTranscript({
      words,
      start: cursor,
      end: duration,
      granularity: "sentences",
      videoDuration: duration,
    });
    calls += 1;
    if (!result.ok) break;

    const digest = result.digest as { start: number; coveredEnd?: number };
    const reached = digest.coveredEnd ?? duration;
    examined = recordExamined(examined, digest.start, reached, duration);
    if (reached <= cursor + 0.5) break;
    cursor = reached;
    if (cursor >= duration - 0.5) break;
  }

  const spots = findBlindSpots({
    examined,
    segments: [],
    videoDuration: duration,
    floorSec: blindSpotFloor(duration, true),
  });
  return { calls, cleared: spots.length === 0 };
}

function synthetic(duration: number, wordsPerSecond: number): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  const step = 1 / wordsPerSecond;
  for (let t = 0; t < duration; t += step) {
    words.push({ start: t, end: t + step * 0.8, value: "conversation" });
  }
  return words;
}

const path = process.argv[2];
const rows: Array<[string, number, TranscriptWord[]]> = [];

if (path) {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const list = (Array.isArray(raw) ? raw : (raw as { data?: unknown[] }).data ?? []) as Array<{
    start: number;
    end: number;
    value: string;
  }>;
  const duration = Math.max(...list.map((w) => w.end));
  rows.push([`real transcript (${fmt(duration)})`, duration, list]);
}

const density = 2.14; // words per second, measured off the real episode
for (const minutes of [10, 22, 42, 90, 180]) {
  const duration = minutes * 60;
  rows.push([`synthetic ${minutes}m`, duration, synthetic(duration, density)]);
}

console.log("source                        floor    reads to clear   cleared");
console.log("-".repeat(70));
for (const [label, duration, words] of rows) {
  const { calls, cleared } = sweep(words, duration);
  console.log(
    `${label.padEnd(28)}  ${fmt(blindSpotFloor(duration, true)).padStart(6)}   ${String(calls).padStart(12)}   ${
      cleared ? "yes" : "NO"
    }`,
  );
}
console.log(
  "\nWithout a transcript the floor is much looser, since every look costs a Pegasus call:",
);
for (const minutes of [42, 180]) {
  const duration = minutes * 60;
  console.log(
    `  ${minutes}m source → largest permitted unexamined stretch ${fmt(
      blindSpotFloor(duration, false),
    )}`,
  );
}
