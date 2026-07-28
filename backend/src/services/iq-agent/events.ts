/**
 * The event log — append-only, seq-ordered, the single source of truth for the
 * UI. The worker writes; the client polls `(projectId, seq > cursor)`.
 *
 * The log is keyed by project, not by run, so the panel keeps a continuous
 * transcript across runs and refreshes. Runs are demarcated by `run.started`
 * and the terminal `run.*` events. Because it is append-only and ordered,
 * resume is not a special case — it is the normal read path with a cursor.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { EVENT_TTL_DAYS } from "./config";
import type { AgentEvent, AgentEventBody } from "./types";

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const EVENTS_TABLE = process.env.AGENT_EVENTS_TABLE!;
const THREADS_TABLE = process.env.AGENT_THREADS_TABLE!;

/** DynamoDB item ceiling is 400 KB; keep a wide margin for the event envelope. */
const MAX_EVENT_BYTES = 300_000;

/** How long a missing sequence number is assumed to be a write still in flight. */
const GAP_WAIT_MS = 5_000;

/**
 * Reserve `count` sequence numbers. Atomic, so the API handler appending a user
 * message and the worker appending tool events can never collide.
 */
export async function allocateSeq(
  projectId: string,
  count: number,
): Promise<number> {
  const result = await docClient.send(
    new UpdateCommand({
      TableName: THREADS_TABLE,
      Key: { projectId },
      UpdateExpression:
        "SET eventSeq = if_not_exists(eventSeq, :zero) + :count",
      ExpressionAttributeValues: { ":zero": 0, ":count": count },
      ReturnValues: "UPDATED_NEW",
    }),
  );
  const next = Number(result.Attributes?.eventSeq ?? count);
  return next - count + 1;
}

export async function appendEvents(
  projectId: string,
  runId: string,
  bodies: AgentEventBody[],
): Promise<AgentEvent[]> {
  if (bodies.length === 0) return [];

  const firstSeq = await allocateSeq(projectId, bodies.length);
  const ts = new Date().toISOString();
  const expiresAt = Math.floor(Date.now() / 1000) + EVENT_TTL_DAYS * 86400;

  const events: AgentEvent[] = bodies.map((body, i) => ({
    ...body,
    runId,
    seq: firstSeq + i,
    ts,
  }));

  const items = events.map((event) => ({
    projectId,
    seq: event.seq,
    runId: event.runId,
    createdAt: event.ts,
    eventType: event.type,
    data: serializeEvent(event),
    expiresAt,
  }));

  // BatchWrite caps at 25 items per request.
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    let unprocessed = {
      [EVENTS_TABLE]: chunk.map((Item) => ({ PutRequest: { Item } })),
    };
    let remaining: unknown[] | undefined;
    for (let attempt = 0; attempt < 6; attempt++) {
      const result = await docClient.send(
        new BatchWriteCommand({ RequestItems: unprocessed }),
      );
      remaining = result.UnprocessedItems?.[EVENTS_TABLE];
      if (!remaining || remaining.length === 0) break;
      unprocessed = { [EVENTS_TABLE]: remaining } as typeof unprocessed;
      await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
    }
    // Silently dropping here would leave a permanent hole in the sequence, and
    // the reader stops at the first gap — the transcript would freeze with no
    // explanation. Surfacing it lets the caller report a real failure.
    if (remaining && remaining.length > 0) {
      throw new Error(
        `Could not write ${remaining.length} agent event(s) after repeated retries.`,
      );
    }
  }

  return events;
}

function serializeEvent(event: AgentEvent): string {
  const json = JSON.stringify(event);
  if (json.length <= MAX_EVENT_BYTES) return json;

  // Trim the long strings but keep the event's shape. Rewriting it as a notice
  // would strip the type the UI reducer dispatches on, so an oversized
  // `state.updated` would silently stop updating the timeline.
  for (const cap of [8000, 2000, 500, 100]) {
    const shrunk = JSON.stringify(truncateStrings(event, cap));
    if (shrunk.length <= MAX_EVENT_BYTES) return shrunk;
  }

  return JSON.stringify({
    type: "notice",
    level: "warn",
    message: `An event of type "${event.type}" was too large to store and could not be shown.`,
    runId: event.runId,
    seq: event.seq,
    ts: event.ts,
  });
}

function truncateStrings(value: unknown, cap: number): unknown {
  if (typeof value === "string") {
    return value.length > cap ? `${value.slice(0, cap)}… [truncated]` : value;
  }
  if (Array.isArray(value)) return value.map((v) => truncateStrings(v, cap));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = truncateStrings(v, cap);
    }
    return out;
  }
  return value;
}

export async function appendEvent(
  projectId: string,
  runId: string,
  body: AgentEventBody,
): Promise<AgentEvent> {
  const [event] = await appendEvents(projectId, runId, [body]);
  return event;
}

export async function queryEvents(
  projectId: string,
  afterSeq: number,
  limit: number,
): Promise<{ events: AgentEvent[]; hasMore: boolean }> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: EVENTS_TABLE,
      KeyConditionExpression: "projectId = :projectId AND seq > :afterSeq",
      ExpressionAttributeValues: { ":projectId": projectId, ":afterSeq": afterSeq },
      Limit: limit + 1,
      ScanIndexForward: true,
    }),
  );

  const items = result.Items ?? [];
  // A single Query page is capped at 1 MB, so a run of large events can come
  // back short of `Limit` with more still waiting. Trusting the count alone
  // would tell the client it is caught up when it is not.
  const more = items.length > limit || !!result.LastEvaluatedKey;
  const window = more ? items.slice(0, limit) : items;

  // Sequence numbers are allocated atomically but written independently, so a
  // later event can land first. Handing the client a page that jumps over a
  // seq would advance its cursor past an event that is still in flight, and it
  // would never see it. Stop at the gap and let the next poll pick it up —
  // unless the straggler is old enough that it is clearly never coming.
  const page: typeof window = [];
  let expected = afterSeq + 1;
  let stoppedAtGap = false;
  for (const item of window) {
    const seq = Number(item.seq);
    if (seq > expected) {
      const writtenAt = Date.parse(String(item.createdAt ?? ""));
      const age = Number.isFinite(writtenAt) ? Date.now() - writtenAt : Infinity;
      if (age < GAP_WAIT_MS) {
        stoppedAtGap = true;
        break;
      }
    }
    page.push(item);
    expected = seq + 1;
  }

  const hasMore = stoppedAtGap ? false : more;

  const events: AgentEvent[] = [];
  for (const item of page) {
    try {
      events.push(JSON.parse(String(item.data)) as AgentEvent);
    } catch {
      // A corrupt row must never break the whole transcript.
      events.push({
        type: "notice",
        level: "warn",
        message: "An event row could not be read and was skipped.",
        runId: String(item.runId ?? ""),
        seq: Number(item.seq),
        ts: String(item.createdAt ?? new Date().toISOString()),
      } as AgentEvent);
    }
  }

  return { events, hasMore };
}

/** The tail of the transcript, used when the client has no cursor yet. */
export async function queryRecentEvents(
  projectId: string,
  limit: number,
): Promise<AgentEvent[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: EVENTS_TABLE,
      KeyConditionExpression: "projectId = :projectId",
      ExpressionAttributeValues: { ":projectId": projectId },
      Limit: limit,
      ScanIndexForward: false,
    }),
  );

  const events: AgentEvent[] = [];
  for (const item of (result.Items ?? []).reverse()) {
    try {
      events.push(JSON.parse(String(item.data)) as AgentEvent);
    } catch {
      /* skip */
    }
  }
  return events;
}
