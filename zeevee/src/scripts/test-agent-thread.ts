/**
 * Thread derivation tests.
 *
 * The panel is a pure function of the event log, so everything the producer
 * sees — including whether a failure is visible — is decided here.
 *
 * Run: npm run test:agent-thread
 */

import { buildThreadItems } from "../components/editor/iq-agent/threadItems";
import type { AgentEvent, AgentEventBody } from "../services/agentTypes";

let checks = 0;
let failures = 0;

function assert(condition: boolean, message: string): void {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

/** Builds a log with sequential seqs so tests read as a transcript. */
function log(...bodies: AgentEventBody[]): AgentEvent[] {
  return bodies.map((body, index) => ({
    ...body,
    runId: "run-1",
    seq: index + 1,
    ts: new Date(1700000000000 + index * 1000).toISOString(),
  }));
}

// ============================================================================

section("Messages and turn dividers");
{
  const items = buildThreadItems(
    log(
      { type: "run.started", trigger: "initial" },
      { type: "message.user", text: "Cut me a recap.", isBrief: true },
      { type: "message.assistant", text: "On it." },
      { type: "run.completed", summary: "Done." },
      { type: "run.started", trigger: "message" },
      { type: "message.user", text: "Tighten the open." },
    ),
  );

  assert(items[0]?.kind === "user", "the first run does not open with a divider");
  assert(
    items[0]?.kind === "user" && items[0].isBrief,
    "the opening message is flagged as the brief",
  );
  assert(
    items.filter((i) => i.kind === "runStart").length === 1,
    "only the second run gets a turn divider",
  );
  assert(
    items.findIndex((i) => i.kind === "runStart") === 3,
    "the divider lands between the two turns",
  );
  assert(
    new Set(items.map((i) => i.key)).size === items.length,
    "every row has a unique React key",
  );
}

section("Stages");
{
  const items = buildThreadItems(
    log(
      { type: "run.started", trigger: "initial" },
      { type: "stage.changed", stage: "thinking" },
      { type: "stage.changed", stage: "researching" },
      { type: "stage.changed", stage: "thinking" },
      { type: "stage.changed", stage: "researching" },
      { type: "stage.changed", stage: "cutting", note: "12 segments so far" },
    ),
  );
  const stages = items.filter((i) => i.kind === "stage");

  assert(
    stages.every((s) => s.kind === "stage" && s.label !== "Thinking"),
    "thinking is left to the spinner rather than shown as a stage",
  );
  assert(
    stages.map((s) => (s.kind === "stage" ? s.label : "")).join(" > ") ===
      "Studying the footage > Building the cut",
    "stages are labelled for humans and a thinking gap does not reprint one",
  );
  assert(
    stages.some((s) => s.kind === "stage" && s.note === "12 segments so far"),
    "the stage note survives",
  );
}

section("Tool calls fold into one row and carry their outcome");
{
  const items = buildThreadItems(
    log(
      { type: "run.started", trigger: "initial" },
      {
        type: "tool.started",
        callId: "c1",
        name: "watch_clip",
        input: {},
        label: "Watching 04:10–06:00",
      },
      { type: "tool.progress", callId: "c1", note: "Split across 2 chunks" },
      { type: "tool.progress", callId: "c1", note: "Chunk 1 of 2 back" },
      {
        type: "tool.finished",
        callId: "c1",
        name: "watch_clip",
        ok: true,
        summary: "Watched 110s",
        warnings: ["That window is long; expect it to be slow."],
        ms: 42_000,
      },
    ),
  );
  const tools = items.filter((i) => i.kind === "tool");

  assert(tools.length === 1, "a call and its result are one row, not two");
  const tool = tools[0];
  assert(
    tool.kind === "tool" && tool.done && tool.ok,
    "the row is marked finished and successful",
  );
  assert(
    tool.kind === "tool" && tool.progress.length === 2,
    "both progress notes are kept");
  assert(
    tool.kind === "tool" && tool.warnings?.length === 1,
    "warnings ride along with the result",
  );
  assert(tool.kind === "tool" && tool.ms === 42_000, "the duration is kept");
}

section("Tool failures stay visible with code, message and hint");
{
  const items = buildThreadItems(
    log(
      { type: "run.started", trigger: "initial" },
      {
        type: "tool.started",
        callId: "c1",
        name: "search_video",
        input: {},
        label: "Searching for 'the argument'",
      },
      {
        type: "tool.finished",
        callId: "c1",
        name: "search_video",
        ok: false,
        summary: "Search failed",
        error: {
          code: "index_not_ready",
          message: "This video is still being indexed.",
          hint: "Work from the transcript instead, or ask the user to wait.",
          detail: "TwelveLabs returned 409",
        },
        ms: 900,
      },
    ),
  );
  const tool = items.find((i) => i.kind === "tool");

  assert(
    tool?.kind === "tool" && tool.done && !tool.ok,
    "a failed call is marked failed rather than dropped",
  );
  assert(
    tool?.kind === "tool" && tool.error?.code === "index_not_ready",
    "the error code reaches the UI",
  );
  assert(
    tool?.kind === "tool" && tool.error?.hint.length > 0,
    "the hint the model was given reaches the UI too",
  );
  assert(
    tool?.kind === "tool" && tool.error?.detail === "TwelveLabs returned 409",
    "the underlying detail is not swallowed",
  );
}

section("A result with no matching start is not lost");
{
  // Can happen when a client joins mid-run from a cursor past the start event.
  const items = buildThreadItems(
    log({
      type: "tool.finished",
      callId: "orphan",
      name: "read_transcript",
      ok: false,
      summary: "Transcript unavailable",
      error: {
        code: "transcript_missing",
        message: "This asset has no transcript.",
        hint: "Search the video instead.",
      },
      ms: 300,
    }),
  );
  const tool = items.find((i) => i.kind === "tool");

  assert(tool !== undefined, "an orphaned result still gets a row");
  assert(
    tool?.kind === "tool" && tool.label === "Read the transcript",
    "and is labelled from the tool name",
  );
  assert(
    tool?.kind === "tool" && !tool.ok && tool.error?.code === "transcript_missing",
    "so its failure is not lost when a client joins mid-run",
  );
}

section("Framing progresses in place");
{
  const items = buildThreadItems(
    log(
      { type: "run.started", trigger: "initial" },
      { type: "framing.started", total: 10 },
      { type: "framing.progress", completed: 4, total: 10 },
      { type: "framing.progress", completed: 9, total: 10 },
      { type: "framing.completed", completed: 10, total: 10 },
    ),
  );
  const framing = items.filter((i) => i.kind === "framing");

  assert(framing.length === 1, "framing is one row that updates, not four");
  assert(
    framing[0].kind === "framing" && framing[0].completed === 10,
    "the row lands on the final count",
  );
  assert(framing[0].kind === "framing" && framing[0].done, "and is marked done");
}

section("Framing across two runs does not reuse the first run's row");
{
  const items = buildThreadItems(
    log(
      { type: "run.started", trigger: "initial" },
      { type: "framing.started", total: 3 },
      { type: "framing.completed", completed: 3, total: 3 },
      { type: "run.completed", summary: "First cut." },
      { type: "run.started", trigger: "message" },
      { type: "framing.started", total: 2 },
      { type: "framing.progress", completed: 1, total: 2 },
    ),
  );
  const framing = items.filter((i) => i.kind === "framing");

  assert(framing.length === 2, "each run gets its own framing row");
  assert(
    framing[0].kind === "framing" && framing[0].completed === 3 && framing[0].done,
    "the first run's row stays finished",
  );
  assert(
    framing[1].kind === "framing" && framing[1].completed === 1 && !framing[1].done,
    "the second run's row tracks its own progress",
  );
}

section("Framing failure surfaces its reason");
{
  const items = buildThreadItems(
    log(
      { type: "run.started", trigger: "initial" },
      { type: "framing.started", total: 5 },
      {
        type: "framing.completed",
        completed: 2,
        total: 5,
        failed: 3,
        error: "Auto-framing failed. Your cut is intact.",
      },
    ),
  );
  const framing = items.find((i) => i.kind === "framing");

  assert(
    framing?.kind === "framing" && framing.error?.includes("cut is intact"),
    "the framing error text reaches the UI",
  );
  assert(
    framing?.kind === "framing" && framing.completed === 2 && framing.total === 5,
    "and the partial count is honest about what landed",
  );
}

section("Framing that completes without a start still renders");
{
  // The poll endpoint can mirror a completion for a run the client never saw start.
  const items = buildThreadItems(
    log({ type: "framing.completed", completed: 0, total: 4, error: "Timed out." }),
  );
  const framing = items.find((i) => i.kind === "framing");
  assert(framing !== undefined, "a bare completion still produces a row");
  assert(
    framing?.kind === "framing" && framing.done && framing.error === "Timed out.",
    "with its error intact",
  );
}

section("Run outcomes");
{
  const items = buildThreadItems(
    log(
      { type: "run.started", trigger: "initial" },
      {
        type: "question.asked",
        questionId: "q1",
        text: "Keep the subplot?",
        suggestions: ["Keep it", "Drop it"],
      },
      { type: "run.awaiting_input" },
      { type: "message.user", text: "Drop it." },
      {
        type: "notice",
        level: "warn",
        message: "Scene cache is empty.",
        detail: "Falling back to the transcript.",
      },
      {
        type: "run.failed",
        code: "model_overloaded",
        message: "Claude was overloaded.",
        detail: "429 after 4 attempts",
        retryable: true,
      },
      { type: "run.cancelled", note: "Stopped by you." },
      { type: "run.completed", summary: "Cut 14 segments.", concerns: ["Two are short."] },
    ),
  );

  assert(
    items.some((i) => i.kind === "question" && i.text === "Keep the subplot?"),
    "the question is shown",
  );
  const notice = items.find((i) => i.kind === "notice");
  assert(
    notice?.kind === "notice" &&
      notice.level === "warn" &&
      notice.detail === "Falling back to the transcript.",
    "notices keep their level and detail",
  );
  const failed = items.find((i) => i.kind === "failed");
  assert(
    failed?.kind === "failed" &&
      failed.code === "model_overloaded" &&
      failed.detail === "429 after 4 attempts" &&
      failed.retryable,
    "a failure shows its code, detail and whether retrying is worth it",
  );
  assert(
    items.some((i) => i.kind === "cancelled" && i.note === "Stopped by you."),
    "cancellation is shown",
  );
  const completed = items.find((i) => i.kind === "completed");
  assert(
    completed?.kind === "completed" && completed.concerns.length === 1,
    "concerns raised at the end are not dropped",
  );
}

section("Unknown event types are ignored, not crashed on");
{
  const items = buildThreadItems([
    ...log({ type: "message.assistant", text: "Hello." }),
    {
      type: "something.new",
      runId: "run-1",
      seq: 99,
      ts: new Date().toISOString(),
    } as unknown as AgentEvent,
  ]);
  assert(items.length === 1, "a newer server can add events without breaking an old client");
}

section("Ordering follows the log");
{
  const items = buildThreadItems(
    log(
      { type: "message.user", text: "One." },
      { type: "message.assistant", text: "Two." },
      { type: "message.user", text: "Three." },
    ),
  );
  const seqs = items.map((i) => i.seq);
  assert(
    seqs.every((s, i) => i === 0 || s >= seqs[i - 1]),
    "rows come out in log order",
  );
}

console.log(
  failures === 0
    ? `\nPASS — ${checks}/${checks} checks passed\n`
    : `\nFAIL — ${failures} of ${checks} checks failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
