/**
 * IQ Agent worker. Invoked asynchronously by the API handler, and by itself
 * when a turn needs more wall-clock time than one Lambda invocation allows.
 *
 * The worker owns no state. It rehydrates the thread, runs the loop, and either
 * finishes, suspends on a question, or hands off to a continuation.
 */

import type { Context } from "aws-lambda";
import { runAgentTurn } from "../services/iq-agent/loop";
import { appendEvent } from "../services/iq-agent/events";
import { getThread, releaseRun } from "../services/iq-agent/thread";

interface WorkerEvent {
  projectId?: string;
  runId?: string;
  isContinuation?: boolean;
}

export const handler = async (
  event: WorkerEvent,
  context: Context,
): Promise<void> => {
  const { projectId, runId } = event;

  if (!projectId || !runId) {
    console.error("[IQAgentWorker] invoked without projectId/runId:", event);
    return;
  }

  console.log(
    `[IQAgentWorker] project=${projectId} run=${runId}${event.isContinuation ? " (continuation)" : ""}`,
  );

  try {
    await runAgentTurn({
      projectId,
      runId,
      getRemainingTimeMs: () => context.getRemainingTimeInMillis(),
    });
  } catch (err) {
    // runAgentTurn handles its own failures; anything reaching here means the
    // failure path itself broke. Release the lock so the project is not wedged.
    console.error("[IQAgentWorker] fatal:", err);
    const message = err instanceof Error ? err.message : String(err);

    await appendEvent(projectId, runId, {
      type: "run.failed",
      code: "worker_fatal",
      message: `The agent worker crashed: ${message}`,
      detail: message,
      retryable: true,
    }).catch(() => undefined);

    const thread = await getThread(projectId).catch(() => null);
    if (thread?.activeRunId === runId && thread.run) {
      await releaseRun(projectId, runId, {
        ...thread.run,
        status: "failed",
        stage: "finished",
        endedAt: new Date().toISOString(),
        error: { code: "worker_fatal", message, detail: message },
      }).catch(() => undefined);
    }
  }
};
