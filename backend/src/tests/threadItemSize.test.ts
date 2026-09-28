/**
 * The agent thread row stays under DynamoDB's 400 KB item limit, and a run can
 * always end even when it doesn't.
 *
 * Reproduces the incident shape: a 58-segment cut with 115 unverified edges and
 * a history carrying several 60 KB finish refusals. The fake table rejects an
 * update the way DynamoDB did in production — by counting the stored item plus
 * the incoming values — so a full rewrite of a big row fails even when the
 * result would fit.
 *
 * Run: npx tsx src/tests/threadItemSize.test.ts
 */
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type {
  AgentSegment,
  RunState,
  StoredTurn,
  ToolLedgerEntry,
} from "../services/iq-agent/types";

let checks = 0;
let failures = 0;

function assert(condition: boolean, message: string): void {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}

process.env.AGENT_THREADS_TABLE = "agent-threads";

const LIMIT = 400 * 1024;
const PROJECT = "project-1";
const RUN = "run-1";

const bytes = (v: unknown) =>
  Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v), "utf8");

function itemSize(item: Record<string, unknown>): number {
  return Object.entries(item).reduce((sum, [k, v]) => sum + bytes(k) + bytes(v), 0);
}

type Command = { constructor: { name: string }; input: Record<string, any> };
let item: Record<string, any>;
let updates: Array<{ ok: boolean; turns?: number; values: number }> = [];
/** Reject every update that writes turnsJson or segmentsJson (for the release test). */
let rejectStateWrites = false;

function tooLarge(): Error {
  const error = new Error("Item size to update has exceeded the maximum allowed size");
  error.name = "ValidationException";
  return error;
}

(DynamoDBDocumentClient.prototype as unknown as { send: unknown }).send = async (
  command: Command,
) => {
  if (command.constructor.name === "GetCommand") return { Item: { ...item } };
  if (command.constructor.name !== "UpdateCommand") throw new Error("unexpected command");

  const { UpdateExpression: expr, ExpressionAttributeValues: values = {} } = command.input;
  const names: Record<string, string> = command.input.ExpressionAttributeNames ?? {};
  const turns = values[":turns"] ? JSON.parse(values[":turns"]).length : undefined;
  const valueBytes = itemSize(values);

  if (item.activeRunId !== values[":runId"]) {
    const error = new Error("The conditional request failed");
    error.name = "ConditionalCheckFailedException";
    throw error;
  }
  const writesState = ":turns" in values || ":segments" in values;
  if (itemSize(item) + valueBytes > LIMIT || (rejectStateWrites && writesState)) {
    updates.push({ ok: false, turns, values: valueBytes });
    throw tooLarge();
  }
  updates.push({ ok: true, turns, values: valueBytes });

  const [setPart, removePart] = expr.replace(/^SET /, "").split(" REMOVE ");
  for (const clause of setPart.split(", ")) {
    const m = clause.match(/^([\w#.]+) = (:\w+)$/);
    if (!m) continue;
    const path = m[1].split(".").map((p: string) => names[p] ?? p);
    if (path.length === 1) item[path[0]] = values[m[2]];
    else item[path[0]] = { ...(item[path[0]] ?? {}), [path[1]]: values[m[2]] };
  }
  for (const name of removePart?.split(", ") ?? []) delete item[names[name] ?? name];
  return {};
};

async function main(): Promise<void> {
  const { persistRunState, releaseRun, isItemTooLargeError } = await import(
    "../services/iq-agent/thread"
  );
  const { computeLedger, renderLedger, ledgerForStorage } = await import(
    "../services/iq-agent/ledger"
  );

  // ---- A 58-segment EDL: 115 unverified edges, 9 under the per-segment min.
  const videoDuration = 3600;
  const segments: AgentSegment[] = Array.from({ length: 58 }, (_, i) => {
    const startTime = i * 62;
    const duration = i < 9 ? 54 : 61;
    return {
      id: `seg-${i + 1}`,
      startTime,
      endTime: startTime + duration,
      title: `A Fairly Long Scene Title Number ${i + 1} Here`,
      description: "A description of what happens in this part of the episode.",
      characters: ["Davis", "Mara"],
      sceneTags: ["dialogue", "tension"],
      keyDialogue: "Someone set me up — I never played a musical instrument in my life.",
      confidence: 0.8,
    };
  });
  const ledger = computeLedger(
    segments,
    { format: "highlights", minSegmentDuration: 60 } as never,
    videoDuration,
    { examined: [{ start: 0, end: videoDuration }], visualExamined: [], hasTranscript: true },
  );
  assert(ledger.unverifiedEdges.length === 115, `115 unverified edges (${ledger.unverifiedEdges.length})`);
  assert(ledger.perSegment.violations.length === 9, "9 bound violations");
  assert(ledger.blocking.length === 124, `124 blocking lines (${ledger.blocking.length})`);

  // ---- What the model sees is bounded.
  const rendered = renderLedger(ledger);
  assert(bytes(rendered) < 8_000, `rendered ledger stays small (${bytes(rendered)} B)`);
  assert(/109 more blocking items/.test(rendered), "rendered ledger says how many are hidden");

  // ---- The stored ledger keeps counts and the first entries only.
  const stored = ledgerForStorage(ledger);
  assert(stored.unverifiedEdges.length === 20, "stored ledger keeps 20 edges");
  assert(stored.counts?.unverifiedEdges === 115, "stored ledger keeps the edge count");
  assert(stored.counts?.blocking === 124, "stored ledger keeps the blocking count");
  assert(bytes(stored) < 12_000, `stored ledger is small (${bytes(stored)} B)`);
  assert(ledgerForStorage(computeLedger(segments.slice(0, 3), undefined, videoDuration)).counts === undefined,
    "a small ledger is stored untouched");

  // ---- A big history: normal turns plus several 60 KB finish refusals.
  const refusal = "- " + ledger.blocking.join("\n- ");
  const history: StoredTurn[] = [];
  for (let i = 0; i < 12; i++) {
    history.push({
      role: "assistant",
      content: [
        { type: "text", text: `Working on it — pass ${i}. ` + "x".repeat(1500) },
        { type: "tool_use", id: `t${i}`, name: "finish_turn", input: { summary: "done" } },
      ],
    });
    history.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: `t${i}`,
          is_error: true,
          content: [{ type: "text", text: `ERROR: ${refusal}\n\n${refusal}` }],
        },
      ],
    });
  }
  assert(bytes(history) > LIMIT, `the history alone is over the item limit (${bytes(history)} B)`);

  const payload = {
    turns: history,
    summary: "s".repeat(6_000),
    toolLedger: Array.from({ length: 120 }, (_, i): ToolLedgerEntry => ({
      name: "view_frames",
      line: `Viewed frames at ${i} → looked fine`,
      ok: true,
    })),
    segments,
    ledger,
    cost: {} as never,
    examined: [{ start: 0, end: videoDuration }],
    run: { stage: "thinking", iterations: 3 } as unknown as RunState,
  };

  // ---- Fresh row: one write, full history budget, well under the limit.
  item = { projectId: PROJECT, activeRunId: RUN, run: { epoch: 1 } };
  updates = [];
  await persistRunState(PROJECT, RUN, payload, 1);
  assert(updates.length === 1 && updates[0].ok, "a fresh row takes one write");
  assert(updates[0].values <= 200_000, `a state write stays under half the limit (${updates[0].values} B)`);
  assert(itemSize(item) < LIMIT, `stored item under 400 KB (${itemSize(item)} B)`);
  assert((updates[0].turns ?? 0) > 2, `keeps more than the fallback history (${updates[0].turns} turns)`);
  assert(JSON.parse(item.ledgerJson).unverifiedEdges.length === 20, "the row stores the bounded ledger");

  // ---- Steady state: rewriting a full row never trips old + new.
  updates = [];
  await persistRunState(PROJECT, RUN, payload, 1);
  assert(updates.length === 1 && updates[0].ok, "rewriting a full row takes one write");

  // ---- A row at the old 200 K history cap (written before the budget) heals itself.
  item = {
    projectId: PROJECT,
    activeRunId: RUN,
    run: { epoch: 1 },
    turnsJson: "t".repeat(200_000), // the old cap
    ledgerJson: "l".repeat(44_000),
    segmentsJson: "g".repeat(14_000),
    summary: "s".repeat(6_000),
    toolLedgerJson: "o".repeat(5_000),
  };
  updates = [];
  await persistRunState(PROJECT, RUN, payload, 1);
  assert(updates.length === 2 && !updates[0].ok && updates[1].ok, "retries once after a size refusal");
  assert(updates[1].turns != null && updates[1].turns <= 2, "the retry keeps only the last turns");
  assert(itemSize(item) < LIMIT, "the healed row is under 400 KB");
  updates = [];
  await persistRunState(PROJECT, RUN, payload, 1);
  assert(updates.length === 1 && (updates[0].turns ?? 0) > 2, "the next write stores full history again");

  // ---- A run can always end, even when every state write is refused.
  rejectStateWrites = true;
  updates = [];
  await releaseRun(
    PROJECT,
    RUN,
    { runId: RUN, status: "failed", stage: "finished" } as RunState,
    { ...payload, openQuestionId: null },
    1,
  );
  rejectStateWrites = false;
  assert(updates.length === 3 && updates[2].ok, "release falls back to a bare write");
  assert(item.activeRunId === undefined, "the lock is released");
  assert(item.lastRun?.status === "failed", "the terminal state is recorded");

  // ---- The error classifier.
  assert(isItemTooLargeError(tooLarge()), "recognizes the item-size refusal");
  const other = new Error("One or more parameter values were invalid");
  other.name = "ValidationException";
  assert(!isItemTooLargeError(other), "ignores other validation errors");
}

main()
  .then(() => {
    console.log(`threadItemSize: ${checks - failures}/${checks} checks passed`);
    if (failures > 0) process.exit(1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
