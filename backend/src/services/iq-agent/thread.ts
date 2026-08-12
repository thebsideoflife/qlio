/**
 * Thread persistence: rehydrate, persist, lock, heartbeat, reap.
 *
 * The worker is stateless (12-factor #6) — every turn rehydrates from here, so
 * a run can be paused, resumed, or continued in a fresh Lambda. Business state
 * (segments) and execution state (run status, cursor, retry counts) are kept
 * separate on purpose (12-factor #7).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { DEAD_RUN_MS, THREAD_TTL_DAYS } from "./config";
import { emptyCostMeter } from "./types";
import type {
  AgentSegment,
  Brief,
  CostMeter,
  FramingMirror,
  Interval,
  Ledger,
  PendingMessage,
  PromptOverrides,
  RunState,
  StoredTurn,
  ThreadState,
  ToolLedgerEntry,
} from "./types";

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const THREADS_TABLE = process.env.AGENT_THREADS_TABLE!;

/**
 * Conversation history is bounded so the item can never approach the 400 KB
 * DynamoDB ceiling. Full fidelity always survives in the event log.
 */
const MAX_TURNS_JSON_BYTES = 200_000;
const MAX_TOOL_LEDGER_ENTRIES = 120;
const MAX_IDEMPOTENCY_KEYS = 60;

function ttl(): number {
  return Math.floor(Date.now() / 1000) + THREAD_TTL_DAYS * 86400;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Reads are strongly consistent by default. The API handler enqueues a message,
 * takes the lock, and invokes the worker within milliseconds — an eventually
 * consistent read there sees neither write, and the run strands until the
 * reaper notices. Readers that only paint a UI can opt out.
 */
export async function getThread(
  projectId: string,
  opts: { consistent?: boolean } = {},
): Promise<ThreadState | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: THREADS_TABLE,
      Key: { projectId },
      ConsistentRead: opts.consistent !== false,
    }),
  );
  if (!result.Item) return null;

  const item = result.Item;
  return {
    projectId,
    assetId: String(item.assetId ?? ""),
    activeRunId: item.activeRunId ? String(item.activeRunId) : undefined,
    runCounter: Number(item.runCounter ?? 0),
    eventSeq: Number(item.eventSeq ?? 0),
    brief: item.brief as Brief | undefined,
    turns: parseJson<StoredTurn[]>(item.turnsJson, []),
    summary: item.summary ? String(item.summary) : undefined,
    toolLedger: parseJson<ToolLedgerEntry[]>(item.toolLedgerJson, []),
    segments: parseJson<AgentSegment[]>(item.segmentsJson, []),
    ledger: parseJson<Ledger | undefined>(item.ledgerJson, undefined),
    // Spread over the empty meter: a row written before a counter existed would
    // otherwise hand back `undefined` and turn every later increment into NaN.
    cost: { ...emptyCostMeter(), ...((item.cost as Partial<CostMeter>) ?? {}) },
    examined: parseJson<Interval[]>(item.examinedJson, []),
    pendingMessages: (item.pendingMessages as PendingMessage[] | undefined) ?? [],
    promptVersion: item.promptVersion ? String(item.promptVersion) : undefined,
    promptOverrides: item.promptOverrides as PromptOverrides | undefined,
    run: item.run as RunState | undefined,
    lastRun: item.lastRun as RunState | undefined,
    framing: item.framing as FramingMirror | undefined,
    openQuestionId: item.openQuestionId ? String(item.openQuestionId) : undefined,
    idempotencyKeys: item.idempotencyKeys as Record<string, number> | undefined,
    updatedAt: item.updatedAt ? String(item.updatedAt) : undefined,
    expiresAt: item.expiresAt ? Number(item.expiresAt) : undefined,
  };
}

export async function ensureThread(
  projectId: string,
  assetId: string,
): Promise<ThreadState> {
  await docClient.send(
    new UpdateCommand({
      TableName: THREADS_TABLE,
      Key: { projectId },
      // idempotencyKeys is seeded here so claims can always use a nested path.
      UpdateExpression:
        "SET assetId = :assetId, runCounter = if_not_exists(runCounter, :zero), eventSeq = if_not_exists(eventSeq, :zero), idempotencyKeys = if_not_exists(idempotencyKeys, :emptyMap), updatedAt = :now, expiresAt = :ttl",
      ExpressionAttributeValues: {
        ":assetId": assetId,
        ":zero": 0,
        ":emptyMap": {},
        ":now": new Date().toISOString(),
        ":ttl": ttl(),
      },
    }),
  );
  const thread = await getThread(projectId);
  if (!thread) throw new Error("Thread creation failed");
  return thread;
}

/**
 * The lock. Exactly one run per project can be active; a conditional write is
 * what makes ten rapid sends produce one run instead of ten.
 */
export async function acquireRun(
  projectId: string,
  run: RunState,
): Promise<{ acquired: boolean; runNumber: number }> {
  try {
    const result = await docClient.send(
      new UpdateCommand({
        TableName: THREADS_TABLE,
        Key: { projectId },
        UpdateExpression:
          "SET activeRunId = :runId, #run = :run, runCounter = if_not_exists(runCounter, :zero) + :one, updatedAt = :now, expiresAt = :ttl REMOVE lastRun, framing",
        ConditionExpression: "attribute_not_exists(activeRunId)",
        ExpressionAttributeNames: { "#run": "run" },
        ExpressionAttributeValues: {
          ":runId": run.runId,
          ":run": run,
          ":zero": 0,
          ":one": 1,
          ":now": new Date().toISOString(),
          ":ttl": ttl(),
        },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return {
      acquired: true,
      runNumber: Number(result.Attributes?.runCounter ?? 1),
    };
  } catch (err) {
    if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
      return { acquired: false, runNumber: 0 };
    }
    throw err;
  }
}

/**
 * Thrown when a conditional write fails because this worker no longer owns the
 * run — the lock moved on, or a duplicate invocation claimed a later epoch.
 * The loser exits quietly; the winner is still working and owns the outcome.
 */
export class LockLostError extends Error {
  constructor(message = "This worker no longer owns the run.") {
    super(message);
    this.name = "LockLostError";
  }
}

function isConditionalFailure(err: unknown): boolean {
  return (err as { name?: string })?.name === "ConditionalCheckFailedException";
}

/**
 * Claim the run for this invocation. Returns the epoch this worker owns, or
 * null when the run is no longer active. Every later write by this worker is
 * conditioned on the epoch, so a duplicate delivery fences the older worker out
 * instead of the two of them interleaving tool calls and segment commits.
 */
export async function claimRunEpoch(
  projectId: string,
  runId: string,
): Promise<number | null> {
  try {
    const result = await docClient.send(
      new UpdateCommand({
        TableName: THREADS_TABLE,
        Key: { projectId },
        UpdateExpression:
          "SET #run.#epoch = if_not_exists(#run.#epoch, :zero) + :one, #run.lastHeartbeatAt = :now, updatedAt = :now",
        ConditionExpression: "activeRunId = :runId",
        ExpressionAttributeNames: { "#run": "run", "#epoch": "epoch" },
        ExpressionAttributeValues: {
          ":zero": 0,
          ":one": 1,
          ":now": new Date().toISOString(),
          ":runId": runId,
        },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    const run = result.Attributes?.run as { epoch?: number } | undefined;
    return Number(run?.epoch ?? 1);
  } catch (err) {
    if (isConditionalFailure(err)) return null;
    throw err;
  }
}

export async function heartbeat(
  projectId: string,
  runId: string,
  epoch?: number,
): Promise<void> {
  const values: Record<string, unknown> = {
    ":now": new Date().toISOString(),
    ":runId": runId,
  };
  let condition = "activeRunId = :runId";
  const names: Record<string, string> = { "#run": "run" };
  if (epoch !== undefined) {
    condition += " AND #run.#epoch = :epoch";
    names["#epoch"] = "epoch";
    values[":epoch"] = epoch;
  }

  await docClient
    .send(
      new UpdateCommand({
        TableName: THREADS_TABLE,
        Key: { projectId },
        UpdateExpression: "SET #run.lastHeartbeatAt = :now",
        ConditionExpression: condition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    )
    .catch((err) => {
      if (!isConditionalFailure(err)) {
        console.warn("[IQAgent] heartbeat failed:", err);
      }
    });
}

/**
 * Fields on `run` the worker is allowed to write mid-run. `lastHeartbeatAt` and
 * `cancelRequested` are deliberately absent: the heartbeat timer and the cancel
 * endpoint own those, and a wholesale write of the run map would roll both back
 * — reaping a live run and losing the cancel the producer just asked for.
 */
const WORKER_OWNED_RUN_FIELDS = [
  "stage",
  "iterations",
  "askCount",
  "finishRefusals",
  "reframeIds",
  // Written as `null` to clear it, which is why the loop below tests for
  // `undefined` rather than for falsiness.
  "pendingFinish",
] as const;

export interface PersistPayload {
  turns?: StoredTurn[];
  summary?: string;
  toolLedger?: ToolLedgerEntry[];
  segments?: AgentSegment[];
  ledger?: Ledger;
  cost?: CostMeter;
  examined?: Interval[];
  run?: RunState;
  openQuestionId?: string | null;
}

/**
 * Persist agent state mid-run. Requires the caller to still hold the lock, and
 * the epoch it claimed — a write from a superseded worker raises `LockLostError`
 * rather than trampling the live one.
 */
export async function persistRunState(
  projectId: string,
  runId: string,
  payload: PersistPayload,
  epoch?: number,
): Promise<void> {
  const sets: string[] = ["updatedAt = :now", "expiresAt = :ttl"];
  const removes: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {
    ":now": new Date().toISOString(),
    ":ttl": ttl(),
    ":runId": runId,
  };

  if (payload.turns) {
    sets.push("turnsJson = :turns");
    values[":turns"] = boundTurns(payload.turns);
  }
  if (payload.summary !== undefined) {
    sets.push("summary = :summary");
    values[":summary"] = payload.summary;
  }
  if (payload.toolLedger) {
    sets.push("toolLedgerJson = :toolLedger");
    values[":toolLedger"] = JSON.stringify(
      payload.toolLedger.slice(-MAX_TOOL_LEDGER_ENTRIES),
    );
  }
  if (payload.segments) {
    sets.push("segmentsJson = :segments");
    values[":segments"] = JSON.stringify(payload.segments);
  }
  if (payload.ledger) {
    sets.push("ledgerJson = :ledger");
    values[":ledger"] = JSON.stringify(payload.ledger);
  }
  if (payload.cost) {
    sets.push("cost = :cost");
    values[":cost"] = payload.cost;
  }
  if (payload.examined) {
    sets.push("examinedJson = :examined");
    values[":examined"] = JSON.stringify(payload.examined);
  }
  // Panel inputs are project.metadata. Do not write a duplicate `brief` here.
  if (payload.run) {
    names["#run"] = "run";
    const run = payload.run as unknown as Record<string, unknown>;
    WORKER_OWNED_RUN_FIELDS.forEach((field, i) => {
      if (run[field] === undefined) return;
      names[`#rf${i}`] = field;
      sets.push(`#run.#rf${i} = :rf${i}`);
      values[`:rf${i}`] = run[field];
    });
  }
  if (payload.openQuestionId === null) {
    removes.push("openQuestionId");
  } else if (payload.openQuestionId) {
    sets.push("openQuestionId = :openQuestionId");
    values[":openQuestionId"] = payload.openQuestionId;
  }

  let condition = "activeRunId = :runId";
  if (epoch !== undefined) {
    names["#run"] = "run";
    names["#epoch"] = "epoch";
    condition += " AND #run.#epoch = :epoch";
    values[":epoch"] = epoch;
  }

  const expression =
    `SET ${sets.join(", ")}` + (removes.length ? ` REMOVE ${removes.join(", ")}` : "");

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: THREADS_TABLE,
        Key: { projectId },
        UpdateExpression: expression,
        ConditionExpression: condition,
        ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
        ExpressionAttributeValues: values,
      }),
    );
  } catch (err) {
    if (isConditionalFailure(err)) throw new LockLostError();
    throw err;
  }
}

function boundTurns(turns: StoredTurn[]): string {
  let kept = turns;
  let json = JSON.stringify(kept);
  while (json.length > MAX_TURNS_JSON_BYTES && kept.length > 2) {
    kept = kept.slice(Math.max(1, Math.floor(kept.length / 4)));
    // A conversation must never start with a dangling tool result.
    while (kept.length > 0 && startsWithToolResult(kept[0])) kept = kept.slice(1);
    json = JSON.stringify(kept);
  }
  if (json.length <= MAX_TURNS_JSON_BYTES) return json;

  // A couple of enormous turns (a transcript dump, a wall of search hits) can
  // still blow the item limit on their own. Losing the whole write here would
  // strand the run, so shrink the text in place instead and say so.
  kept = kept.map((turn) => ({
    ...turn,
    content: shrinkBlocks(turn.content, TRUNCATED_TURN_CHARS),
  }));
  json = JSON.stringify(kept);
  return json.length <= MAX_TURNS_JSON_BYTES
    ? json
    : JSON.stringify(kept.slice(-2));
}

const TRUNCATED_TURN_CHARS = 4000;

function shrinkBlocks(content: StoredTurn["content"], max: number) {
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    const b = block as { type?: string; text?: string; content?: unknown };
    if (typeof b.text === "string" && b.text.length > max) {
      return {
        ...b,
        text: `${b.text.slice(0, max)}\n\n[Trimmed to fit the stored history. Re-run the tool if you need the rest.]`,
      };
    }
    if (typeof b.content === "string" && b.content.length > max) {
      return {
        ...b,
        content: `${b.content.slice(0, max)}\n\n[Trimmed to fit the stored history. Re-run the tool if you need the rest.]`,
      };
    }
    return block;
  }) as StoredTurn["content"];
}

function startsWithToolResult(turn: StoredTurn): boolean {
  if (turn.role !== "user") return false;
  if (!Array.isArray(turn.content)) return false;
  // Any tool_result in the leading turn is dangling once its tool_use is gone.
  return turn.content.some(
    (block) => (block as { type?: string })?.type === "tool_result",
  );
}

/** Release the lock and record the terminal run state. */
export async function releaseRun(
  projectId: string,
  runId: string,
  finalRun: RunState,
  extra: PersistPayload = {},
  epoch?: number,
): Promise<void> {
  const sets: string[] = [
    "lastRun = :run",
    "updatedAt = :now",
    "expiresAt = :ttl",
  ];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {
    ":run": finalRun,
    ":now": new Date().toISOString(),
    ":ttl": ttl(),
    ":runId": runId,
  };

  if (extra.turns) {
    sets.push("turnsJson = :turns");
    values[":turns"] = boundTurns(extra.turns);
  }
  if (extra.summary !== undefined) {
    sets.push("summary = :summary");
    values[":summary"] = extra.summary;
  }
  if (extra.toolLedger) {
    sets.push("toolLedgerJson = :toolLedger");
    values[":toolLedger"] = JSON.stringify(
      extra.toolLedger.slice(-MAX_TOOL_LEDGER_ENTRIES),
    );
  }
  if (extra.segments) {
    sets.push("segmentsJson = :segments");
    values[":segments"] = JSON.stringify(extra.segments);
  }
  if (extra.ledger) {
    sets.push("ledgerJson = :ledger");
    values[":ledger"] = JSON.stringify(extra.ledger);
  }
  if (extra.cost) {
    sets.push("cost = :cost");
    values[":cost"] = extra.cost;
  }
  if (extra.examined) {
    sets.push("examinedJson = :examined");
    values[":examined"] = JSON.stringify(extra.examined);
  }

  const removes = ["activeRunId", "#run"];
  names["#run"] = "run";
  if (extra.openQuestionId === null) removes.push("openQuestionId");
  if (extra.openQuestionId) {
    sets.push("openQuestionId = :openQuestionId");
    values[":openQuestionId"] = extra.openQuestionId;
  }

  let condition = "activeRunId = :runId";
  if (epoch !== undefined) {
    names["#epoch"] = "epoch";
    condition += " AND #run.#epoch = :epoch";
    values[":epoch"] = epoch;
  }

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: THREADS_TABLE,
        Key: { projectId },
        UpdateExpression: `SET ${sets.join(", ")} REMOVE ${removes.join(", ")}`,
        ConditionExpression: condition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  } catch (err) {
    if (epoch !== undefined && isConditionalFailure(err)) {
      throw new LockLostError();
    }
    throw err;
  }
}

export async function requestCancel(
  projectId: string,
  runId: string,
): Promise<boolean> {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: THREADS_TABLE,
        Key: { projectId },
        UpdateExpression: "SET #run.cancelRequested = :true",
        ConditionExpression: "activeRunId = :runId",
        ExpressionAttributeNames: { "#run": "run" },
        ExpressionAttributeValues: { ":true": true, ":runId": runId },
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
      return false;
    }
    throw err;
  }
}

/**
 * Is the agent holding this project right now?
 *
 * Deliberately narrow and deliberately cheap: services outside the agent (the
 * export-metadata Lambda, the job-status poll) need this answer without reading
 * a row that carries the whole conversation. Returns null when nothing owns the
 * project — including when the owning run has stopped writing heartbeats, since
 * a dead run must not block export forever.
 */
export async function getActiveAgentRun(
  projectId: string,
): Promise<RunState | null> {
  if (!THREADS_TABLE) return null;
  const result = await docClient.send(
    new GetCommand({
      TableName: THREADS_TABLE,
      Key: { projectId },
      ProjectionExpression: "activeRunId, #run",
      ExpressionAttributeNames: { "#run": "run" },
      ConsistentRead: true,
    }),
  );
  const item = result.Item;
  if (!item?.activeRunId || !item.run) return null;
  const run = item.run as RunState;
  if (isRunDead(run)) return null;
  return run;
}

export function isRunDead(run: RunState | undefined): boolean {
  if (!run || run.status !== "running") return false;
  const last = Date.parse(run.lastHeartbeatAt);
  if (!Number.isFinite(last)) return true;
  return Date.now() - last > DEAD_RUN_MS;
}

/**
 * Reap a run whose worker stopped writing heartbeats. Any reader can do this;
 * it happens inside the events endpoint, which the client is already calling.
 */
export async function reapDeadRun(
  projectId: string,
  run: RunState,
): Promise<boolean> {
  const finalRun: RunState = {
    ...run,
    status: "failed",
    stage: "finished",
    endedAt: new Date().toISOString(),
    error: {
      code: "worker_died",
      message:
        "The agent process stopped responding and the run was ended. Nothing already applied to the cut was lost.",
    },
  };
  try {
    await releaseRun(projectId, run.runId, finalRun);
    return true;
  } catch (err) {
    if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
      return false;
    }
    throw err;
  }
}

export async function enqueuePendingMessage(
  projectId: string,
  message: PendingMessage,
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: THREADS_TABLE,
      Key: { projectId },
      UpdateExpression:
        "SET pendingMessages = list_append(if_not_exists(pendingMessages, :empty), :msg), updatedAt = :now",
      ExpressionAttributeValues: {
        ":empty": [],
        ":msg": [message],
        ":now": new Date().toISOString(),
      },
    }),
  );
}

/**
 * Drop exactly the messages the worker consumed. Clearing the whole list would
 * silently swallow anything the producer appended between the read and this
 * write; removing the leading `count` entries by index leaves later arrivals in
 * place for the next iteration.
 */
export async function clearPendingMessages(
  projectId: string,
  count: number,
): Promise<void> {
  if (count <= 0) return;
  const indexes = Array.from({ length: count }, (_, i) => `pendingMessages[${i}]`);
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: THREADS_TABLE,
        Key: { projectId },
        UpdateExpression: `REMOVE ${indexes.join(", ")}`,
        ExpressionAttributeValues: { ":n": count },
        ConditionExpression: "size(pendingMessages) >= :n",
      }),
    );
  } catch (err) {
    if (!isConditionalFailure(err)) throw err;
    console.warn(
      `[IQAgent] pending queue shrank under a drain of ${count}; leaving it alone.`,
    );
  }
}

/** Returns the previously recorded result for a duplicate send, if any. */
export async function claimIdempotencyKey(
  projectId: string,
  key: string,
  retried = false,
): Promise<boolean> {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: THREADS_TABLE,
        Key: { projectId },
        UpdateExpression: "SET idempotencyKeys.#key = :now",
        ConditionExpression: "attribute_not_exists(idempotencyKeys.#key)",
        ExpressionAttributeNames: { "#key": key },
        ExpressionAttributeValues: { ":now": Date.now() },
      }),
    );
    return true;
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "ConditionalCheckFailedException") return false;
    if (name === "ValidationException" && !retried) {
      // The parent map is missing on threads created before it was seeded.
      // Create it without clobbering a concurrent writer, then retry the claim.
      await docClient.send(
        new UpdateCommand({
          TableName: THREADS_TABLE,
          Key: { projectId },
          UpdateExpression: "SET idempotencyKeys = :map",
          ConditionExpression: "attribute_not_exists(idempotencyKeys)",
          ExpressionAttributeValues: { ":map": {} },
        }),
      ).catch((e) => {
        if (!isConditionalFailure(e)) throw e;
      });
      return claimIdempotencyKey(projectId, key, true);
    }
    throw err;
  }
}

export async function pruneIdempotencyKeys(
  projectId: string,
  keys: Record<string, number> | undefined,
): Promise<void> {
  if (!keys) return;
  const entries = Object.entries(keys);
  if (entries.length <= MAX_IDEMPOTENCY_KEYS) return;

  // Remove only the stale keys. Rewriting the whole map would drop any claim
  // made between the read that produced `keys` and this write, which would let
  // a duplicate send through as a fresh message.
  const stale = entries
    .sort((a, b) => b[1] - a[1])
    .slice(MAX_IDEMPOTENCY_KEYS)
    .map(([key]) => key);

  for (let i = 0; i < stale.length; i += 50) {
    const batch = stale.slice(i, i + 50);
    const names: Record<string, string> = {};
    const paths = batch.map((key, j) => {
      names[`#k${j}`] = key;
      return `idempotencyKeys.#k${j}`;
    });
    await docClient.send(
      new UpdateCommand({
        TableName: THREADS_TABLE,
        Key: { projectId },
        UpdateExpression: `REMOVE ${paths.join(", ")}`,
        ExpressionAttributeNames: names,
      }),
    );
  }
}

export async function setFramingMirror(
  projectId: string,
  framing: FramingMirror | null,
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: THREADS_TABLE,
      Key: { projectId },
      UpdateExpression: framing
        ? "SET framing = :framing, updatedAt = :now"
        : "REMOVE framing SET updatedAt = :now",
      ExpressionAttributeValues: framing
        ? { ":framing": framing, ":now": new Date().toISOString() }
        : { ":now": new Date().toISOString() },
    }),
  );
}

export async function savePromptOverrides(
  projectId: string,
  overrides: PromptOverrides,
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: THREADS_TABLE,
      Key: { projectId },
      UpdateExpression:
        "SET promptOverrides = :overrides, updatedAt = :now, expiresAt = :ttl",
      ExpressionAttributeValues: {
        ":overrides": overrides,
        ":now": new Date().toISOString(),
        ":ttl": ttl(),
      },
    }),
  );
}

