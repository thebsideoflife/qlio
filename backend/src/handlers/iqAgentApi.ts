/**
 * IQ Agent HTTP surface. Thin on purpose: it validates, appends to the log,
 * takes the run lock, and kicks the worker. It never reasons.
 *
 *   POST   /projects/{projectId}/agent/messages
 *   GET    /projects/{projectId}/agent/events?after=<seq>
 *   POST   /projects/{projectId}/agent/cancel
 *   GET    /projects/{projectId}/agent/prompts
 *   PUT    /projects/{projectId}/agent/prompts
 */

import { randomUUID } from "crypto";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { checkAuth } from "../utils/auth";
import {
  EVENTS_PAGE_LIMIT,
  FRAMING_MIRROR_MAX_MS,
} from "../services/iq-agent/config";
import { appendEvents, queryEvents } from "../services/iq-agent/events";
import { computeLedger } from "../services/iq-agent/ledger";
import {
  getDefaultPrompt,
  PROMPT_SPECS,
  PROMPT_VERSION,
  type PromptKey,
} from "../services/iq-agent/prompts";
import {
  loadProjectContext,
  ProjectContextError,
  readProjectSegmentsAndFraming,
} from "../services/iq-agent/project";
import {
  acquireRun,
  claimIdempotencyKey,
  enqueuePendingMessage,
  ensureThread,
  getThread,
  isRunDead,
  pruneIdempotencyKeys,
  reapDeadRun,
  requestCancel,
  saveBrief,
  savePromptOverrides,
  setFramingMirror,
} from "../services/iq-agent/thread";
import { emptyCostMeter } from "../services/iq-agent/types";
import type {
  AgentEventBody,
  Brief,
  PromptOverrides,
  RunState,
  ThreadState,
} from "../services/iq-agent/types";

const lambdaClient = new LambdaClient({});
const WORKER_FUNCTION_NAME = process.env.AGENT_WORKER_FUNCTION_NAME;

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,x-api-password",
  "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
};

function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const method =
    (event as unknown as { requestContext?: { http?: { method?: string } } })
      .requestContext?.http?.method ?? event.httpMethod;

  if (method === "OPTIONS") return json(200, {});

  const authError = await checkAuth(event);
  if (authError) return authError;

  const projectId = event.pathParameters?.projectId;
  if (!projectId) return json(400, { error: "projectId is required" });

  const path = (event as unknown as { rawPath?: string }).rawPath ?? event.path ?? "";

  try {
    if (path.endsWith("/messages") && method === "POST") {
      return await postMessage(projectId, event);
    }
    if (path.endsWith("/events") && method === "GET") {
      return await getEvents(projectId, event);
    }
    if (path.endsWith("/cancel") && method === "POST") {
      return await postCancel(projectId);
    }
    if (path.endsWith("/prompts") && method === "GET") {
      return await getPrompts(projectId);
    }
    if (path.endsWith("/prompts") && (method === "PUT" || method === "POST")) {
      return await putPrompts(projectId, event);
    }
    return json(404, { error: `No agent route for ${method} ${path}` });
  } catch (err) {
    if (err instanceof ProjectContextError) {
      return json(400, { error: err.message, code: err.code });
    }
    console.error("[IQAgentApi] unhandled error:", err);
    return json(500, {
      error: "The agent service hit an unexpected error.",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
};

// ============================================================================
// POST /messages
// ============================================================================

interface MessageBody {
  text?: string;
  brief?: Brief;
  answerTo?: string;
  idempotencyKey?: string;
  isBrief?: boolean;
}

async function postMessage(
  projectId: string,
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const body = parseBody<MessageBody>(event);
  const text = (body.text ?? "").trim();
  const isBrief = body.isBrief === true;

  if (!isBrief && text.length === 0) {
    return json(400, { error: "A message needs some text." });
  }
  if (text.length > 8000) {
    return json(400, { error: "That message is too long — keep it under 8000 characters." });
  }

  const project = await loadProjectContext(projectId);
  const thread = await ensureThread(projectId, project.assetId);

  const idempotencyKey = body.idempotencyKey?.slice(0, 64);
  if (idempotencyKey) {
    const claimed = await claimIdempotencyKey(projectId, idempotencyKey);
    if (!claimed) {
      const current = await getThread(projectId);
      return json(200, {
        duplicate: true,
        runId: current?.activeRunId ?? current?.lastRun?.runId ?? null,
        queued: Boolean(current?.activeRunId),
      });
    }
    void pruneIdempotencyKeys(projectId, thread.idempotencyKeys);
  }

  if (body.brief) {
    await saveBrief(projectId, sanitizeBrief(body.brief));
  }

  await enqueuePendingMessage(projectId, {
    id: randomUUID(),
    text,
    brief: body.brief ? sanitizeBrief(body.brief) : undefined,
    answerTo: body.answerTo,
    receivedAt: new Date().toISOString(),
    isBrief,
  });

  const started = await tryStartRun(projectId, {
    trigger: isBrief ? "initial" : body.answerTo ? "answer" : "message",
    hasBlockingIssue: project.assetIssue,
  });

  if (started.kind === "started") {
    return json(202, { runId: started.runId, started: true, queued: false });
  }
  return json(202, {
    runId: started.runId,
    started: false,
    queued: true,
    note: "The agent is already working — your message goes in as soon as it finishes what it's doing.",
  });
}

async function tryStartRun(
  projectId: string,
  opts: { trigger: RunState["trigger"]; hasBlockingIssue?: string },
): Promise<{ kind: "started" | "queued"; runId: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const runId = randomUUID();
    const now = new Date().toISOString();
    const run: RunState = {
      runId,
      status: "running",
      stage: "thinking",
      startedAt: now,
      lastHeartbeatAt: now,
      iterations: 0,
      askCount: 0,
      finishRefusals: 0,
      trigger: opts.trigger,
    };

    const { acquired } = await acquireRun(projectId, run);
    if (acquired) {
      const events: AgentEventBody[] = [
        { type: "run.started", trigger: opts.trigger, promptVersion: PROMPT_VERSION },
      ];
      await appendEvents(projectId, runId, events);
      await invokeWorker(projectId, runId);
      return { kind: "started", runId };
    }

    const thread = await getThread(projectId);
    if (thread?.run && isRunDead(thread.run)) {
      const reaped = await reapDeadRun(projectId, thread.run);
      if (reaped) {
        await appendEvents(projectId, thread.run.runId, [
          {
            type: "run.failed",
            code: "worker_died",
            message:
              "The previous run stopped responding and was ended. Starting a fresh one.",
            retryable: true,
          },
        ]);
        continue;
      }
    }

    return {
      kind: "queued",
      runId: thread?.activeRunId ?? "",
    };
  }

  const thread = await getThread(projectId);
  return { kind: "queued", runId: thread?.activeRunId ?? "" };
}

async function invokeWorker(projectId: string, runId: string): Promise<void> {
  if (!WORKER_FUNCTION_NAME) {
    throw new Error("AGENT_WORKER_FUNCTION_NAME is not configured.");
  }
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: WORKER_FUNCTION_NAME,
      InvocationType: "Event",
      Payload: JSON.stringify({ projectId, runId }),
    }),
  );
}

// ============================================================================
// GET /events
// ============================================================================

async function getEvents(
  projectId: string,
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const after = Number(event.queryStringParameters?.after ?? "0");
  const cursor = Number.isFinite(after) && after >= 0 ? after : 0;
  const limit = Math.min(
    Number(event.queryStringParameters?.limit ?? EVENTS_PAGE_LIMIT) ||
      EVENTS_PAGE_LIMIT,
    200,
  );

  // The poll runs every second or two and only paints the UI; an eventually
  // consistent read here is half the cost and at most one poll behind.
  let thread = await getThread(projectId, { consistent: false });

  if (thread?.run && isRunDead(thread.run)) {
    const deadRun = thread.run;
    const reaped = await reapDeadRun(projectId, deadRun);
    if (reaped) {
      await appendEvents(projectId, deadRun.runId, [
        {
          type: "run.failed",
          code: "worker_died",
          message:
            "The agent stopped responding, so the run was ended. Anything already applied to the cut was kept — send a message to pick it back up.",
          retryable: true,
        },
      ]);
      thread = await getThread(projectId);
    }
  }

  if (thread) {
    await mirrorFraming(projectId, thread);
    if (thread.framing) {
      thread = (await getThread(projectId, { consistent: false })) ?? thread;
    }
  }

  const page = await queryEvents(projectId, cursor, limit);
  const nextCursor =
    page.events.length > 0 ? page.events[page.events.length - 1].seq : cursor;

  return json(200, {
    cursor: nextCursor,
    hasMore: page.hasMore,
    events: page.events,
    ...describeThread(thread),
  });
}

function describeThread(thread: ThreadState | null) {
  if (!thread) {
    return {
      run: null,
      lastRun: null,
      segments: [],
      ledger: null,
      cost: emptyCostMeter(),
      brief: null,
      openQuestionId: null,
      framing: null,
      promptVersion: PROMPT_VERSION,
    };
  }
  return {
    run: thread.run ?? null,
    lastRun: thread.lastRun ?? null,
    segments: thread.segments,
    ledger: thread.ledger ?? null,
    cost: thread.cost,
    brief: thread.brief ?? null,
    openQuestionId: thread.openQuestionId ?? null,
    framing: thread.framing ?? null,
    queuedMessages: thread.pendingMessages.length,
    promptVersion: PROMPT_VERSION,
  };
}

/**
 * Auto-framing runs in its own Lambda after the agent finishes. Rather than
 * hold the agent open waiting on it, the poll endpoint mirrors its progress
 * into the same event log so the panel shows one continuous timeline.
 */
async function mirrorFraming(
  projectId: string,
  thread: ThreadState,
): Promise<void> {
  const mirror = thread.framing;
  if (!mirror || mirror.status !== "running") return;

  const { segments, framingJob } = await readProjectSegmentsAndFraming(projectId);
  if (!framingJob) return;

  // Another framing job replaced ours (a manual reframe, say). Stop reporting on
  // it rather than attribute someone else's progress to this run.
  if (
    mirror.jobId !== "unknown" &&
    framingJob.jobId &&
    framingJob.jobId !== mirror.jobId
  ) {
    await setFramingMirror(projectId, null);
    return;
  }

  const total = framingJob.segmentCount ?? mirror.total;
  const completed = framingJob.completedCount ?? 0;
  const status = framingJob.status;

  if (status === "analyzing" || status === "pending") {
    if (mirrorHasExpired(mirror)) {
      await appendEvents(projectId, mirror.runId, [
        {
          type: "framing.completed",
          completed,
          total,
          failed: Math.max(0, total - completed),
          error:
            "Auto-framing has not reported back in over 20 minutes, so we stopped waiting on it. Your cut is intact — re-run framing from the framing panel if you still need it.",
        },
      ]);
      await setFramingMirror(projectId, null);
      return;
    }

    if (completed !== mirror.lastCompleted) {
      await appendEvents(projectId, mirror.runId, [
        { type: "framing.progress", completed, total },
      ]);
      await setFramingMirror(projectId, { ...mirror, lastCompleted: completed, total });
    }
    return;
  }

  const failed = Math.max(0, total - completed);
  // Framing never changes timings, so the existing ledger still holds.
  const ledger = thread.ledger ?? computeLedger(segments, thread.brief, 0);
  await appendEvents(projectId, mirror.runId, [
    {
      type: "framing.completed",
      completed,
      total,
      failed: failed > 0 ? failed : undefined,
      error:
        status === "failed"
          ? framingJob.error ??
            "Auto-framing failed. Your cut is intact — you can re-run framing from the framing panel."
          : undefined,
    },
    { type: "state.updated", segments, ledger, cost: thread.cost },
  ]);
  await setFramingMirror(projectId, null);
}

function mirrorHasExpired(mirror: { startedAt?: string }): boolean {
  const started = Date.parse(mirror.startedAt ?? "");
  if (!Number.isFinite(started)) return false;
  return Date.now() - started > FRAMING_MIRROR_MAX_MS;
}

// ============================================================================
// POST /cancel
// ============================================================================

async function postCancel(projectId: string): Promise<APIGatewayProxyResult> {
  const thread = await getThread(projectId);
  if (!thread?.activeRunId || !thread.run) {
    return json(200, { cancelled: false, note: "There is no run in progress." });
  }

  if (isRunDead(thread.run)) {
    await reapDeadRun(projectId, thread.run);
    return json(200, { cancelled: true, note: "That run had already stopped." });
  }

  const ok = await requestCancel(projectId, thread.activeRunId);
  if (ok) {
    await appendEvents(projectId, thread.activeRunId, [
      {
        type: "notice",
        level: "info",
        message: "Stopping after the current step…",
      },
    ]);
  }
  return json(200, { cancelled: ok, runId: thread.activeRunId });
}

// ============================================================================
// GET/PUT /prompts
// ============================================================================

async function getPrompts(projectId: string): Promise<APIGatewayProxyResult> {
  const thread = await getThread(projectId);
  const overrides = thread?.promptOverrides ?? {};
  return json(200, {
    version: PROMPT_VERSION,
    prompts: PROMPT_SPECS.map((spec) => ({
      key: spec.key,
      label: spec.label,
      description: spec.description,
      variables: spec.variables,
      default: spec.default,
      override: overrides[spec.key] ?? null,
    })),
  });
}

async function putPrompts(
  projectId: string,
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const body = parseBody<{ overrides?: Record<string, string | null> }>(event);
  const incoming = body.overrides ?? {};
  const overrides: PromptOverrides = {};
  const validKeys = new Set(PROMPT_SPECS.map((s) => s.key));

  for (const [key, value] of Object.entries(incoming)) {
    if (!validKeys.has(key as PromptKey)) {
      return json(400, { error: `"${key}" is not a prompt you can override.` });
    }
    if (typeof value !== "string" || value.trim().length === 0) continue;
    if (value.length > 40_000) {
      return json(400, { error: `The ${key} prompt is too long (40,000 character limit).` });
    }
    if (value.trim() === getDefaultPrompt(key as PromptKey).trim()) continue;
    overrides[key as PromptKey] = value;
  }

  const project = await loadProjectContext(projectId);
  await ensureThread(projectId, project.assetId);
  await savePromptOverrides(projectId, overrides);

  return json(200, {
    saved: true,
    overridden: Object.keys(overrides),
    version: PROMPT_VERSION,
  });
}

// ============================================================================
// Helpers
// ============================================================================

function parseBody<T>(event: APIGatewayProxyEvent): T {
  if (!event.body) return {} as T;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ProjectContextError("bad_json", "The request body was not valid JSON.");
  }
}

function sanitizeBrief(brief: Brief): Brief {
  const num = (value: unknown): number | undefined => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  return {
    format: brief.format,
    assetType: brief.assetType,
    platform: brief.platform,
    targetSeconds: num(brief.targetSeconds) ?? null,
    targetPercent: num(brief.targetPercent) ?? null,
    minSegmentDuration: num(brief.minSegmentDuration) ?? null,
    maxSegmentDuration: num(brief.maxSegmentDuration) ?? null,
    userPrompt:
      typeof brief.userPrompt === "string"
        ? brief.userPrompt.slice(0, 4000)
        : undefined,
    autoFrame: brief.autoFrame !== false,
    targetAspectRatio: brief.targetAspectRatio,
  };
}
