/**
 * Unit tests for Jockey timeline coverage helpers (no API keys required).
 */
import {
  assertAcceptanceCriteria,
  backfillQuartileCoverage,
  checkTimelineCoverage,
  narrowRecapBeatWindows,
} from "../services/storyiq/jockey/coverage";
import { normalizeWindowRowTimes } from "../services/storyiq/jockey/window-planner";
import { Purpose } from "../services/storyiq/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// Baseline failure pattern from Philadelphia Pegasus eval (latter-half bias)
const latterHalfBias = [
  { startTime: 928, endTime: 1046, title: "A", reasoning: "", expectedContent: "" },
  { startTime: 1476, endTime: 1647, title: "B", reasoning: "", expectedContent: "" },
  { startTime: 2383, endTime: 2558, title: "C", reasoning: "", expectedContent: "" },
];

const duration = 3527;

const biasCheck = checkTimelineCoverage(
  latterHalfBias,
  duration,
  Purpose.COMPACT_VIDEO,
);
assert(!biasCheck.passed, "expected latter-half bias to fail coverage");
assert(
  biasCheck.issues.some((i) => i.includes("first quartile")),
  "expected first quartile issue",
);

// Even spread should pass
const evenSpread = [
  { startTime: 100, endTime: 200, title: "Q1", reasoning: "", expectedContent: "" },
  { startTime: 1000, endTime: 1100, title: "Q2", reasoning: "", expectedContent: "" },
  { startTime: 2000, endTime: 2100, title: "Q3", reasoning: "", expectedContent: "" },
  { startTime: 3000, endTime: 3100, title: "Q4", reasoning: "", expectedContent: "" },
];
const evenCheck = checkTimelineCoverage(
  evenSpread,
  duration,
  Purpose.COMPACT_VIDEO,
);
assert(evenCheck.passed, `expected even spread to pass: ${evenCheck.issues.join("; ")}`);

// Backfill adds Q1 candidate when keep filter dropped it
const candidates = [
  { startTime: 50, endTime: 150, title: "Early", reasoning: "", expectedContent: "" },
  { startTime: 2000, endTime: 2100, title: "Late", reasoning: "", expectedContent: "" },
];
const kept = [candidates[1]];
const backfilled = backfillQuartileCoverage(candidates, kept, duration);
assert(backfilled.length === 2, "backfill should add early quartile segment");
assert(
  backfilled.some((s) => s.title === "Early"),
  "backfill should include Early segment",
);

// Window-relative timestamps on a late window → global timeline
const lateWindow = {
  videoId: "v1",
  localStartSec: 3240,
  localEndSec: 3527,
  physicalOffsetSec: 0,
  chunkIndex: 6,
  arcNames: [],
};
const normalized = normalizeWindowRowTimes(
  { start_time: 0, end_time: 287, metadata: {} },
  lateWindow,
  3527,
);
assert(
  normalized.start_time >= 3230 && normalized.end_time <= 3527,
  `expected late window normalized to global timeline, got ${normalized.start_time}-${normalized.end_time}`,
);

// Recap window narrowing keeps beat count while fitting duration
const sixWideBeats = Array.from({ length: 6 }, (_, i) => ({
  startTime: i * 500,
  endTime: i * 500 + 24,
  title: `beat-${i}`,
  reasoning: "",
  expectedContent: "",
}));
const narrowed = narrowRecapBeatWindows(sixWideBeats, 75, 3000);
assert(narrowed.length === 6, "narrowing must not drop beats");
const narrowedTotal = narrowed.reduce(
  (sum, s) => sum + (s.endTime - s.startTime),
  0,
);
assert(
  narrowedTotal >= 60 && narrowedTotal <= 90,
  `expected ~60–90s after narrow, got ${narrowedTotal}s`,
);

// Recap acceptance
const recapOk = [
  { startTime: 10, endTime: 25, title: "1", reasoning: "", expectedContent: "" },
  { startTime: 100, endTime: 115, title: "2", reasoning: "", expectedContent: "" },
  { startTime: 200, endTime: 215, title: "3", reasoning: "", expectedContent: "" },
  { startTime: 300, endTime: 315, title: "4", reasoning: "", expectedContent: "" },
];
const recapResult = assertAcceptanceCriteria(
  recapOk,
  3600,
  Purpose.EPISODE_RECAP,
);
assert(recapResult.passed, `recap should pass: ${recapResult.issues.join("; ")}`);

console.log("[test-jockey-coverage] All checks passed.");
