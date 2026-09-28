/**
 * The agent loop — an explicit state machine, no framework (12-factor #5).
 *
 *   rehydrate → assemble context → call Claude
 *     → emit prose blocks
 *     → for each tool_use: emit started, execute, emit finished
 *     → commit mutations and emit state.updated
 *     → heartbeat
 *     → loop, suspend on ask_user, complete on finish_turn,
 *       or persist and self-invoke a continuation before the Lambda expires
 *
 * The worker holds nothing across invocations. Every entry point rehydrates
 * from DynamoDB, so a run survives a Lambda timeout, a cancel, or a crash.
 */

import { randomUUID } from "crypto";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  CONTINUATION_RESERVE_MS,
  FINALIZE_RESERVE_MS,
  HEARTBEAT_MS,
  MAX_ITERATIONS,
  MAX_OUTPUT_TOKENS,
  MODEL_TEMPERATURE,
} from "./config";
import { callClaude, classifyModelError, errorText } from "./claude";
import {
  assembleMessages,
  buildSystemBlocks,
  compactHistory,
  describeBounds,
  describeTarget,
  renderLiveState,
} from "./context";
import { appendEvent, appendEvents } from "./events";
import { executeTool, type ExecContext, type ExecControl } from "./executor";
import { computeLedger, fmt } from "./ledger";
import { finalizeDeliveryMetadata } from "./metadata";
import { FORMAT_GUIDES, getPrompt, renderTemplate, PROMPT_VERSION } from "./prompts";
import {
  commitSegments,
  saveProjectTitle,
  getTwelveLabsClient,
  isFramingJobActive,
  loadProjectContext,
  ProjectContextError,
  readProjectSegmentsAndFraming,
  saveGenerationInputs,
  unframedSegmentIds,
} from "./project";
import { loadTranscriptWords } from "./tools/transcript";
import {
  claimRunEpoch,
  clearPendingMessages,
  getThread,
  heartbeat,
  LockLostError,
  isItemTooLargeError,
  persistRunState,
  releaseRun,
  setFramingMirror,
} from "./thread";
import { TOOL_SCHEMAS, toolLabel } from "./tools";
import { TOOL_NAMES } from "./types";
import type {
  AgentEventBody,
  AgentSegment,
  Brief,
  Ledger,
  PendingMessage,
  RunStage,
  RunState,
  StoredTurn,
  ToolName,
  ToolResult,
} from "./types";
import type { ClaudeContentBlock, ClaudeMessage } from "./claude";

const lambdaClient = new LambdaClient({});
const SELF_FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME;
const ANALYZE_FRAMING_FUNCTION_NAME = process.env.ANALYZE_FRAMING_FUNCTION_NAME;
const BUCKET_NAME = process.env.BUCKET_NAME;
const PROJECTS_TABLE = process.env.PROJECTS_TABLE;

/** How many recent turns keep their images in context. */
const IMAGE_RETENTION_TURNS = 2;

/** Nudges allowed when the model stops without calling finish_turn. */
const MAX_NO_TOOL_NUDGES = 1;

export interface RunTurnParams {
  projectId: string;
  runId: string;
  getRemainingTimeMs: () => number;
}

export async function runAgentTurn(params: RunTurnParams): Promise<void> {
  const { projectId, runId } = params;

  const thread = await getThread(projectId);
  if (!thread || thread.activeRunId !== runId || !thread.run) {
    console.log(
      `[IQAgent] run ${runId} is no longer the active run on ${projectId}; nothing to do.`,
    );
    return;
  }

  // Async Lambda invokes are at-least-once. Claiming an epoch means a duplicate
  // delivery of the same runId fences this invocation out on its next write
  // instead of the two of them interleaving tool calls and segment commits.
  const claimed = await claimRunEpoch(projectId, runId);
  if (claimed === null) {
    console.log(`[IQAgent] run ${runId} was released before this worker started.`);
    return;
  }
  const epoch: number = claimed;

  const run: RunState = { ...thread.run, epoch };
  let stage: RunStage = run.stage;

  const emit = async (...bodies: AgentEventBody[]) => {
    if (bodies.length > 0) await appendEvents(projectId, runId, bodies);
  };

  const setStage = async (next: RunStage, note?: string) => {
    if (next === stage) return;
    stage = next;
    run.stage = next;
    await emit({ type: "stage.changed", stage: next, note });
  };

  const beat = setInterval(() => {
    void heartbeat(projectId, runId, epoch);
  }, HEARTBEAT_MS);

  // Hoisted so the crash handler can still persist whatever the run got done
  // before it fell over — otherwise a mid-iteration failure throws away every
  // tool call since the last checkpoint and "pick up where it stopped" resumes
  // from stale history.
  let turns: StoredTurn[] = thread.turns.map((t) => ({ ...t }));
  let summary = thread.summary;
  const toolLedger = [...thread.toolLedger];
  let ctxRef: ExecContext | null = null;
  const pendingChangedIds = new Set<string>(run.reframeIds ?? []);

  /**
   * Claude rejects two messages with the same role in a row. Draining a queued
   * message right after a tool-result turn, or draining two at once, would
   * produce exactly that, so same-role content is folded into one turn.
   */
  const pushTurn = (turn: StoredTurn) => {
    const last = turns[turns.length - 1];
    if (last && last.role === turn.role) {
      turns[turns.length - 1] = {
        role: last.role,
        content: [...last.content, ...turn.content],
      };
      return;
    }
    turns.push(turn);
  };

  try {
    const project = await loadProjectContext(projectId).catch((err) => {
      throw err instanceof ProjectContextError
        ? err
        : new ProjectContextError("project_load_failed", errorText(err));
    });

    // Explicit undefined in a later layer must not erase an earlier value.
    // Panel inputs live on project.metadata. Absorb legacy thread.brief once
    // when the project row still lacks a real panel brief (format).
    if (thread.brief?.format && !project.savedBrief.format) {
      await saveGenerationInputs(projectId, thread.brief);
      project.savedBrief = { ...project.savedBrief, ...thread.brief };
    }
    let brief: Brief = mergeBrief(
      { format: "compact_video" },
      project.savedBrief,
    );

    if (project.assetIssue) {
      await emit({
        type: "notice",
        level: "warn",
        message: project.assetIssue,
      });
    }

    const client = await getTwelveLabsClient();
    if (!client) {
      await emit({
        type: "notice",
        level: "warn",
        message:
          "The TwelveLabs API key is not configured, so semantic search and clip watching are unavailable this run.",
      });
    }

    // The project row is the source of truth for segments: it picks up any
    // manual edits the producer made between runs.
    const ctx: ExecContext = {
      client,
      facts: project.facts,
      cacheBucket: BUCKET_NAME,
      brief,
      segments: project.segments,
      projectTitle: project.projectTitle,
      cost: { ...thread.cost },
      watchHistory: [],
      transcriptWords: null,
      // Carried forward across runs: a follow-up should not have to re-read the
      // timeline to prove it already knows what is on it.
      examined: thread.examined ?? [],
      examinedVisual: [],
      askCount: run.askCount ?? 0,
      finishRefusals: run.finishRefusals ?? 0,
      searchMisses: 0,
      searchSeen: [],
      blindSpotRefusals: 0,
      promptOverrides: thread.promptOverrides,
      onProgress: async () => undefined,
      deadlineAt: Date.now() + params.getRemainingTimeMs(),
    };
    ctxRef = ctx;

    let ledger: Ledger = computeLedger(ctx.segments, brief, project.facts.duration, {
      examined: ctx.examined,
      visualExamined: ctx.examinedVisual,
      hasTranscript: Boolean(project.facts.transcriptS3Uri),
    });
    let noToolNudges = 0;
    // A run that was already told to finish, but ran out of clock before it
    // could write delivery metadata, resumes here rather than re-entering the
    // loop and asking the model to decide all over again.
    let finishOutcome: { summary: string; concerns: string[] } | null =
      run.pendingFinish ?? null;
    // Cleared if the resumed finish gets abandoned below, so that a *new* finish
    // decided later in this same invocation still gets a full clock of its own.
    let resumedPendingFinish = finishOutcome !== null;
    let askOutcome: { question: string; suggestions: string[]; questionId: string } | null =
      null;
    let cancelled = false;

    // ---- Drain anything the producer queued before or during this run -------
    const drain = async (): Promise<boolean> => {
      const current = await getThread(projectId);
      const pending = current?.pendingMessages ?? [];
      if (pending.length === 0) return false;
      // Consume exactly what we read; anything that lands while we work stays
      // queued for the next drain rather than disappearing.
      await clearPendingMessages(projectId, pending.length);

      let briefChanged = false;
      const maybeRefreshBrief = (candidate: Partial<Brief> | undefined) => {
        if (!candidate) return;
        const keys = Object.keys(candidate) as Array<keyof Brief>;
        for (const key of keys) {
          if (candidate[key] !== undefined && candidate[key] !== (brief as unknown as Record<string, unknown>)[key as string]) {
            briefChanged = true;
            break;
          }
        }
        if (briefChanged) {
          brief = mergeBrief(brief, candidate);
          // Tools read ctx.brief (ledger, bounds, userPrompt) — keep the
          // executor's view in sync or the model sees two targets.
          ctx.brief = brief;
        }
      };

      for (const message of pending) {
        if (message.brief) {
          maybeRefreshBrief(message.brief);
        }
        const rendered = renderPending(message, brief, project, ctx.promptOverrides);
        await emit({
          type: "message.user",
          text: rendered.display,
          brief: message.brief,
          isBrief: message.isBrief,
        });
        pushTurn({
          role: "user",
          content: [{ type: "text", text: rendered.forModel }],
        });
      }

      if (briefChanged) {
        ledger = computeLedger(ctx.segments, brief, project.facts.duration, {
          examined: ctx.examined,
          visualExamined: ctx.examinedVisual,
          hasTranscript: Boolean(project.facts.transcriptS3Uri),
        });
        await emit({
          type: "notice",
          level: "info",
          message: `Inputs updated: ${describeTarget(brief, project.facts.duration)} · ${describeBounds(brief)}`,
        });
        // Persist inputs on the project (SoT) and checkpoint the run.
        await saveGenerationInputs(projectId, brief);
        await persistLoopState();
      }

      return true;
    };

    const drainedOnEntry = await drain();

    // The producer typed while we were wrapping up. Their message is worth more
    // than the finish we were holding, so drop it and go back to work.
    if (drainedOnEntry && finishOutcome) {
      finishOutcome = null;
      resumedPendingFinish = false;
      run.pendingFinish = null;
      ctx.finishRefusals = 0;
      run.finishRefusals = 0;
      // Persisted now rather than at the end of the first iteration: if this
      // invocation dies in between, the next one must not resume a finish the
      // producer has already overtaken.
      await persistLoopState();
    }

    if (turns.length === 0) {
      throw new ProjectContextError(
        "nothing_to_do",
        "The run started with no message to act on.",
      );
    }

    // ---- Main loop ---------------------------------------------------------
    while (true) {
      const live = await getThread(projectId);
      if (!live || live.activeRunId !== runId) {
        console.log(`[IQAgent] run ${runId} lost the lock; stopping.`);
        return;
      }
      if ((live.run?.epoch ?? epoch) !== epoch) {
        console.log(
          `[IQAgent] run ${runId} was picked up by a newer invocation; standing down.`,
        );
        return;
      }
      if (live.run?.cancelRequested) {
        cancelled = true;
        break;
      }

      // A resumed finish comes in already decided. Everything above still has to
      // run first — the lock, the epoch fence and a cancel all outrank it — but
      // there is no work left to do below.
      if (finishOutcome) break;

      if (run.iterations >= MAX_ITERATIONS) {
        finishOutcome = {
          summary:
            "I hit this run's step limit before I was finished. The cut below is where I got to — send me a message and I'll pick it back up.",
          concerns: [`Stopped after ${MAX_ITERATIONS} tool steps.`],
        };
        break;
      }

      if (params.getRemainingTimeMs() < CONTINUATION_RESERVE_MS) {
        await persistLoopState();
        await continueInNewInvocation(projectId, runId);
        return;
      }

      // Everything downstream races the same clock. Handing the model and the
      // tools a hard deadline stops a single slow vendor call from running past
      // the Lambda ceiling, which would kill the run mid-iteration and lose the
      // work instead of checkpointing and continuing.
      ctx.deadlineAt = Date.now() + params.getRemainingTimeMs() - CONTINUATION_RESERVE_MS;

      const compaction = await compactHistory({
        turns,
        summary,
        overrides: ctx.promptOverrides,
      });
      if (compaction.compacted) {
        turns = compaction.turns;
        summary = compaction.summary;
        if (compaction.note) {
          console.log(`[IQAgent] ${compaction.note}`);
        }
      }

      stripOldImages(turns, IMAGE_RETENTION_TURNS);

      await setStage("thinking");

      const messages = assembleMessages({
        turns,
        summary,
        toolLedger,
        liveState: renderLiveState({
          projectTitle: ctx.projectTitle,
          segments: ctx.segments,
          ledger,
          cost: ctx.cost,
          iterations: run.iterations,
        }),
      });

      let response;
      try {
        response = await callClaude({
          system: buildSystemBlocks({
            facts: project.facts,
            brief,
            overrides: ctx.promptOverrides,
          }),
          messages,
          tools: TOOL_SCHEMAS,
          maxTokens: MAX_OUTPUT_TOKENS,
          temperature: MODEL_TEMPERATURE,
          deadlineAt: ctx.deadlineAt,
        });
      } catch (err) {
        const classified = classifyModelError(err);
        if (classified.code === "model_deadline") {
          // Out of time rather than out of luck: check in and let a fresh
          // invocation retry the same call with a full clock.
          await persistLoopState();
          await continueInNewInvocation(projectId, runId);
          return;
        }
        await finalizeFailure(
          classified.code,
          classified.message,
          errorText(err),
          classified.retryable,
        );
        return;
      }

      run.iterations += 1;
      ctx.cost.tokensIn += response.usage.inputTokens;
      ctx.cost.tokensOut += response.usage.outputTokens;
      ctx.cost.cacheReadTokens += response.usage.cacheReadTokens;
      ctx.cost.cacheWriteTokens += response.usage.cacheCreationTokens;

      const proseBlocks = response.blocks.filter(
        (b) => (b as { type?: string }).type === "text",
      ) as Array<{ text?: string }>;
      const toolUses = response.blocks.filter(
        (b) => (b as { type?: string }).type === "tool_use",
      ) as Array<{ id: string; name: string; input: Record<string, unknown> }>;

      for (const block of proseBlocks) {
        const text = String(block.text ?? "").trim();
        if (text.length > 0) {
          await emit({ type: "message.assistant", text });
        }
      }

      pushTurn({ role: "assistant", content: response.blocks });

      if (toolUses.length === 0) {
        if (noToolNudges < MAX_NO_TOOL_NUDGES) {
          noToolNudges += 1;
          pushTurn({
            role: "user",
            content: [
              {
                type: "text",
                text: "You stopped without using a tool. If you are done, call finish_turn with a summary. If something is blocking you, call finish_turn and say what it is. Otherwise, keep working.",
              },
            ],
          });
          continue;
        }
        finishOutcome = {
          summary:
            proseBlocks
              .map((b) => String(b.text ?? "").trim())
              .filter(Boolean)
              .join("\n\n") || "Turn ended.",
          concerns: ["The editor ended the turn without calling finish_turn."],
        };
        break;
      }

      const toolResultBlocks: ClaudeContentBlock[] = [];
      let control: ExecControl | undefined;

      for (const use of toolUses) {
        const name = normalizeToolName(use.name);
        const callId = use.id;
        const label = name ? toolLabel(name, use.input) : `Unknown tool ${use.name}`;

        await setStage(stageForTool(name));
        await emit({
          type: "tool.started",
          callId,
          name: name ?? "unknown",
          input: use.input,
          label,
        });

        const startedAt = Date.now();
        // Progress notes are cosmetic. A failed write must never take the tool
        // call down with it, and callers fire these without awaiting.
        ctx.onProgress = async (note: string) => {
          try {
            await emit({ type: "tool.progress", callId, note });
          } catch (err) {
            console.warn("[IQAgent] progress note dropped:", errorText(err));
          }
        };

        let outcome;
        if (!name) {
          outcome = {
            result: {
              ok: false as const,
              code: "unknown_tool",
              message: `There is no tool called "${use.name}".`,
              hint: "Use one of the tools you were given.",
              summary: `Unknown tool "${use.name}"`,
            },
          };
        } else {
          outcome = await executeTool(name, use.input ?? {}, ctx);
        }

        const ms = Date.now() - startedAt;
        const result = outcome.result;

        if (outcome.ledger) ledger = outcome.ledger;

        if (outcome.segmentsChanged) {
          for (const id of outcome.changedIds ?? []) pendingChangedIds.add(id);
          await commitSegments({
            projectId,
            segments: ctx.segments,
            changedIds: outcome.changedIds,
            brief,
          });
        }

        if (outcome.projectTitle) {
          await saveProjectTitle(projectId, outcome.projectTitle);
          await emit({ type: "project.renamed", title: outcome.projectTitle });
        }

        await emit({
          type: "tool.finished",
          callId,
          name: name ?? "unknown",
          ok: result.ok,
          summary: result.summary,
          digest: result.ok ? result.digest : undefined,
          // What the model was actually told. A watch_clip answer otherwise
          // survives only in the model's context and the S3 cache, which makes
          // it impossible to audit later why a boundary was chosen.
          output: result.ok ? truncateOutput(result.text) : undefined,
          warnings: result.ok ? result.warnings : undefined,
          error: result.ok
            ? undefined
            : {
                code: result.code,
                message: result.message,
                hint: result.hint,
                detail: result.detail,
              },
          ms,
        });

        if (outcome.segmentsChanged) {
          await emit({
            type: "state.updated",
            segments: ctx.segments,
            ledger,
            cost: ctx.cost,
          });
        }

        toolLedger.push({
          name: name ?? "unknown",
          line: `${label} → ${result.summary}`,
          ok: result.ok,
        });

        toolResultBlocks.push(buildToolResultBlock(callId, result));

        // First signal wins. A finish_turn issued in the same block as an
        // ask_user must not bury the question the producer needs to answer.
        if (outcome.control && !control) control = outcome.control;
      }

      pushTurn({ role: "user", content: toolResultBlocks });
      run.askCount = ctx.askCount;
      run.finishRefusals = ctx.finishRefusals;

      if (control?.kind === "ask_user") {
        askOutcome = {
          question: control.question,
          suggestions: control.suggestions,
          questionId: randomUUID(),
        };
        break;
      }

      if (control?.kind === "finish") {
        const drained = await drain();
        if (drained) {
          // The producer typed while we were working — keep going instead of
          // ending the run and making them wait for a fresh one.
          ctx.finishRefusals = 0;
          run.finishRefusals = 0;
          continue;
        }
        finishOutcome = { summary: control.summary, concerns: control.concerns };
        break;
      }

      await persistLoopState();
    }

    // ---- Terminal handling -------------------------------------------------
    // The heartbeat keeps running through framing and the final release: those
    // can take minutes, and a silent run gets reaped out from under us.

    if (cancelled) {
      await setStage("finished");
      await emit({
        type: "run.cancelled",
        note:
          pendingChangedIds.size > 0
            ? "Stopped. Edits already applied to the cut were kept."
            : "Stopped before any changes were made.",
      });
      await finish({
        status: "cancelled",
        runState: { ...run, status: "cancelled", stage: "finished" },
      });
      return;
    }

    if (askOutcome) {
      await setStage("waiting_on_you");
      await emit(
        {
          type: "question.asked",
          questionId: askOutcome.questionId,
          text: askOutcome.question,
          suggestions:
            askOutcome.suggestions.length > 0 ? askOutcome.suggestions : undefined,
        },
        { type: "run.awaiting_input" },
      );
      await finish({
        status: "awaiting_input",
        runState: { ...run, status: "awaiting_input", stage: "waiting_on_you" },
        openQuestionId: askOutcome.questionId,
        skipFraming: true,
      });
      return;
    }

    if (finishOutcome) {
      // Delivery metadata is minutes of model calls and FFmpeg work. Rather
      // than start it on a clock that cannot finish it — and be killed halfway
      // through, leaving the run holding the lock — hand the whole wrap-up to a
      // fresh invocation. Only ever once: `resumedPendingFinish` is already
      // true on the continuation, so this cannot become a loop.
      if (
        !resumedPendingFinish &&
        params.getRemainingTimeMs() < FINALIZE_RESERVE_MS
      ) {
        run.pendingFinish = finishOutcome;
        await persistLoopState();
        await continueInNewInvocation(projectId, runId);
        return;
      }

      await emit({
        type: "state.updated",
        segments: ctx.segments,
        ledger,
        cost: ctx.cost,
      });

      // Not "finished" yet: the run still holds the lock through this, and
      // anything polling the thread needs to see that.
      await setStage("reviewing");
      await writeDeliveryMetadata();

      // Wrapping up now takes minutes, and a message sent during it is queued
      // behind a run that is seconds from releasing the lock and never reading
      // the queue again. Fold it into history and hand it to a fresh worker
      // with a full clock, rather than restarting work on whatever is left of
      // this one. This cannot ping-pong: the drain consumes what it reads, so a
      // continuation only happens again if the producer types again.
      if (await drain()) {
        finishOutcome = null;
        run.pendingFinish = null;
        ctx.finishRefusals = 0;
        run.finishRefusals = 0;
        await persistLoopState();
        await continueInNewInvocation(projectId, runId);
        return;
      }

      // Again, because the metadata pass spends tokens and the panel would
      // otherwise show a cost that quietly understates the run.
      await emit({
        type: "state.updated",
        segments: ctx.segments,
        ledger,
        cost: ctx.cost,
      });

      await setStage("finished");
      await emit({
        type: "run.completed",
        summary: finishOutcome.summary,
        concerns:
          finishOutcome.concerns.length > 0 ? finishOutcome.concerns : undefined,
      });
      await finish({
        status: "completed",
        runState: {
          ...run,
          status: "completed",
          stage: "finished",
          pendingFinish: null,
        },
      });
      return;
    }

    // ---- Helpers that close over loop state --------------------------------
    async function persistLoopState(): Promise<void> {
      await persistRunState(
        projectId,
        runId,
        {
          turns: persistableTurns(turns),
          summary,
          toolLedger,
          segments: ctx.segments,
          ledger,
          cost: ctx.cost,
          examined: ctx.examined,
          run: { ...run, reframeIds: Array.from(pendingChangedIds) },
        },
        epoch,
      );
    }

    /**
     * Describe the finished cut while the run still knows what is in it.
     *
     * Wrapped so that nothing in here can stop the run completing: a producer
     * whose cut is done must not be told the run failed because a tag was
     * missing. Anything not written stays detectably incomplete, and the
     * Export pipeline fills it in on the old path.
     */
    async function writeDeliveryMetadata(): Promise<void> {
      try {
        // The metadata pass reads the dialogue for every segment it describes.
        // A run that only searched and watched never loaded it.
        if (ctx.transcriptWords === null && project.facts.transcriptS3Uri) {
          ctx.transcriptWords = await loadTranscriptWords(
            project.facts.transcriptS3Uri,
          ).catch((err) => {
            console.warn(
              `[IQAgent] metadata: transcript unavailable: ${errorText(err)}`,
            );
            return [];
          });
        }

        const result = await finalizeDeliveryMetadata({
          projectId,
          facts: project.facts,
          brief,
          segments: ctx.segments,
          transcriptWords: ctx.transcriptWords,
          bucketName: BUCKET_NAME,
          projectsTable: PROJECTS_TABLE,
          // Leave the release itself room to land even if this runs long.
          deadlineAt:
            Date.now() +
            Math.max(0, params.getRemainingTimeMs() - CONTINUATION_RESERVE_MS),
          onProgress: (note) => {
            void emit({ type: "notice", level: "info", message: note }).catch(
              () => undefined,
            );
          },
          onUsage: (usage) => {
            ctx.cost.tokensIn += usage.inputTokens;
            ctx.cost.tokensOut += usage.outputTokens;
            ctx.cost.cacheReadTokens += usage.cacheReadTokens;
            ctx.cost.cacheWriteTokens += usage.cacheCreationTokens;
          },
        });

        if (result.targeted > 0) {
          await emit({
            type: "notice",
            level: result.incomplete > 0 ? "warn" : "info",
            message: result.note,
          });
        }
      } catch (err) {
        console.error(`[IQAgent] run ${runId}: delivery metadata failed:`, err);
        await emit({
          type: "notice",
          level: "warn",
          message:
            "Your cut is saved, but the delivery metadata could not be written this run. Open Export and it will be generated there.",
          detail: errorText(err),
        }).catch(() => undefined);
      }
    }

    async function finalizeFailure(
      code: string,
      message: string,
      detail: string,
      retryable: boolean,
    ): Promise<void> {
      console.error(`[IQAgent] run ${runId} failed (${code}): ${detail}`);
      await emit({ type: "run.failed", code, message, detail, retryable });
      await finish({
        status: "failed",
        runState: {
          ...run,
          status: "failed",
          stage: "finished",
          error: { code, message, detail },
        },
        skipFraming: true,
      });
    }

    /**
     * Auto-framing is segment-state-driven: on a completed run, frame every
     * segment that still lacks framing. Edits from an earlier ask_user run
     * count — we do not rely on changedIds from this run alone.
     */
    async function autoFrame(): Promise<void> {
      const { segments: latestSegments, framingJob } =
        await readProjectSegmentsAndFraming(projectId);
      const toFrame = unframedSegmentIds(latestSegments);
      if (toFrame.length === 0) return;

      if (isFramingJobActive(framingJob)) {
        console.log(
          `[IQAgent] run ${runId}: framing job already active, skipping auto-framing`,
        );
        await emit({ type: "notice", level: "info", message: FRAMING_BUSY_NOTICE });
        return;
      }

      console.log(
        `[IQAgent] run ${runId}: auto-framing ${toFrame.length} unframed segment(s)`,
      );
      await startFraming({
        projectId,
        runId,
        segments: latestSegments,
        changedIds: toFrame,
        aspectRatio: brief.targetAspectRatio ?? "9:16",
        emit,
      });
    }

    async function finish(opts: {
      status: RunState["status"];
      runState: RunState;
      openQuestionId?: string;
      skipFraming?: boolean;
    }): Promise<void> {
      const changed = Array.from(pendingChangedIds);
      const finalRun: RunState = {
        ...opts.runState,
        endedAt: new Date().toISOString(),
        reframeIds: changed,
      };

      if (
        !opts.skipFraming &&
        opts.status === "completed" &&
        brief.autoFrame !== false
      ) {
        // Framing must never cost the run its release: run.completed is already
        // in the log, and the outer catch would rewrite the run as failed.
        try {
          await autoFrame();
        } catch (err) {
          console.error(`[IQAgent] run ${runId}: auto-framing gate failed:`, err);
          await emit({
            type: "notice",
            level: "warn",
            message:
              "Your cut is saved, but auto-framing could not be started this run. Re-run framing from the framing panel if you need it.",
            detail: errorText(err),
          }).catch(() => undefined);
        }
      }

      await releaseRun(
        projectId,
        runId,
        finalRun,
        {
          turns: persistableTurns(turns),
          summary,
          toolLedger,
          segments: ctx.segments,
          ledger,
          cost: ctx.cost,
          examined: ctx.examined,
          openQuestionId: opts.openQuestionId ?? null,
        },
        epoch,
      );
    }
  } catch (err) {
    if (err instanceof LockLostError) {
      console.log(`[IQAgent] run ${runId}: ${err.message} Leaving it to the owner.`);
      return;
    }
    // A size refusal is not worth retrying as-is, but the writes below fall back
    // to a trimmed history, so the next message starts from a row that fits.
    const tooLarge = isItemTooLargeError(err);
    const code =
      err instanceof ProjectContextError
        ? err.code
        : tooLarge
          ? "thread_too_large"
          : "worker_error";
    const message =
      err instanceof ProjectContextError
        ? err.message
        : tooLarge
          ? "This conversation grew too large to save. Older history is trimmed on the next message so it fits, and anything already applied to the cut was kept — send a message to continue."
          : `The agent hit an unexpected error: ${errorText(err)}`;
    console.error(`[IQAgent] run ${runId} crashed:`, err);
    await appendEvent(projectId, runId, {
      type: "run.failed",
      code,
      message,
      detail: errorText(err),
      retryable: !(err instanceof ProjectContextError) && !tooLarge,
    }).catch(() => undefined);
    // Keep whatever the run managed to do. Without this, a crash three tool
    // calls into an iteration resumes from the last checkpoint and repeats all
    // of them — including the expensive ones.
    await releaseRun(
      projectId,
      runId,
      {
        ...run,
        status: "failed",
        stage: "finished",
        endedAt: new Date().toISOString(),
        reframeIds: Array.from(pendingChangedIds),
        error: { code, message, detail: errorText(err) },
      },
      {
        turns: persistableTurns(turns),
        summary,
        toolLedger,
        segments: ctxRef?.segments,
        cost: ctxRef?.cost,
        examined: ctxRef?.examined,
      },
      epoch,
    ).catch((e) => {
      console.error(`[IQAgent] run ${runId}: could not record the failure:`, e);
    });
  } finally {
    clearInterval(beat);
  }
}

/** Layered brief merge where a later `undefined` never erases an earlier value. */
function mergeBrief(...layers: Array<Partial<Brief> | undefined>): Brief {
  const out: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) out[key] = value;
    }
  }
  return out as unknown as Brief;
}

// ============================================================================
// Autoframing — a deterministic post-run step, never a tool the model can skip
// ============================================================================

const FRAMING_BUSY_NOTICE =
  "Auto-framing is already running for this project, so the segments still missing framing were left for the next run.";

async function startFraming(params: {
  projectId: string;
  runId: string;
  segments: AgentSegment[];
  changedIds: string[];
  aspectRatio: string;
  emit: (...bodies: AgentEventBody[]) => Promise<void>;
}): Promise<void> {
  if (!ANALYZE_FRAMING_FUNCTION_NAME) {
    await params.emit({
      type: "notice",
      level: "warn",
      message:
        "Auto-framing is switched on but the framing service is not configured, so it was skipped.",
    });
    return;
  }

  const changed = new Set(params.changedIds);
  const batch = params.segments
    .filter((s) => changed.has(s.id))
    .map((s) => ({ id: s.id, startTime: s.startTime, endTime: s.endTime }));

  if (batch.length === 0) return;

  try {
    const response = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: ANALYZE_FRAMING_FUNCTION_NAME,
        InvocationType: "RequestResponse",
        Payload: JSON.stringify({
          isDirectBatchStart: true,
          projectId: params.projectId,
          segments: batch,
          targetAspectRatio: params.aspectRatio,
        }),
      }),
    );

    if (response.FunctionError) {
      throw new Error(`framing lambda error: ${response.FunctionError}`);
    }

    const payload = response.Payload
      ? (JSON.parse(Buffer.from(response.Payload).toString()) as {
          statusCode?: number;
          body?: string;
        })
      : null;

    const statusCode = payload?.statusCode ?? 200;
    if (statusCode === 409) {
      console.log(
        `[IQAgent] auto-framing skipped for ${params.projectId}: job already running`,
      );
      await params.emit({
        type: "notice",
        level: "info",
        message: FRAMING_BUSY_NOTICE,
      });
      return;
    }
    if (statusCode >= 400) {
      throw new Error(payload?.body ?? `status ${statusCode}`);
    }

    const jobId = parseJobId(payload?.body);
    // Announce framing only once the job is really ours. An announced-but-never-
    // finished job leaves the panel spinning forever: nothing emits
    // `framing.completed` without a mirror to poll, and `framingActive` also
    // gates the editor's own framing poller.
    await params.emit({ type: "framing.started", total: batch.length });
    await setFramingMirror(params.projectId, {
      jobId: jobId ?? "unknown",
      status: "running",
      total: batch.length,
      lastCompleted: 0,
      runId: params.runId,
      startedAt: new Date().toISOString(),
    });
  } catch (err) {
    await params.emit({
      type: "framing.completed",
      completed: 0,
      total: batch.length,
      failed: batch.length,
      error: `Auto-framing could not be started: ${errorText(err)}`,
    });
  }
}

function parseJobId(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { jobId?: string };
    return parsed.jobId;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Continuation
// ============================================================================

async function continueInNewInvocation(
  projectId: string,
  runId: string,
): Promise<void> {
  if (!SELF_FUNCTION_NAME) {
    throw new Error("Cannot continue: AWS_LAMBDA_FUNCTION_NAME is not set.");
  }
  console.log(`[IQAgent] continuing run ${runId} in a fresh invocation`);
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: SELF_FUNCTION_NAME,
      InvocationType: "Event",
      Payload: JSON.stringify({ projectId, runId, isContinuation: true }),
    }),
  );
}

// ============================================================================
// Helpers
// ============================================================================

function normalizeToolName(name: string): ToolName | null {
  return (TOOL_NAMES as string[]).includes(name) ? (name as ToolName) : null;
}

/**
 * Event rows are capped, and a transcript read can be 60 KB on its own. Keep
 * enough to reconstruct a decision without letting one read crowd the log.
 */
const MAX_EVENT_OUTPUT_CHARS = 6000;

function truncateOutput(text: string): string {
  return text.length > MAX_EVENT_OUTPUT_CHARS
    ? `${text.slice(0, MAX_EVENT_OUTPUT_CHARS)}\n… (${text.length - MAX_EVENT_OUTPUT_CHARS} more characters)`
    : text;
}

function stageForTool(name: ToolName | null): RunStage {
  switch (name) {
    case "edit_segments":
      return "cutting";
    case "check_budget":
    case "finish_turn":
      return "reviewing";
    case "ask_user":
      return "waiting_on_you";
    default:
      return "researching";
  }
}

function buildToolResultBlock(
  callId: string,
  result: ToolResult,
): ClaudeContentBlock {
  if (!result.ok) {
    return {
      type: "tool_result",
      tool_use_id: callId,
      is_error: true,
      content: [
        {
          type: "text",
          text: `ERROR (${result.code}): ${result.message}\nWhat to do: ${result.hint}`,
        },
      ],
    };
  }

  const content: ClaudeContentBlock[] = [];
  const warningText =
    result.warnings && result.warnings.length > 0
      ? `\n\nWarnings:\n${result.warnings.map((w) => `- ${w}`).join("\n")}`
      : "";
  content.push({ type: "text", text: `${result.text}${warningText}` });

  for (const image of result.images ?? []) {
    content.push({ type: "text", text: `Frame at ${image.label}:` });
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mediaType,
        data: image.base64,
      },
    });
  }

  return { type: "tool_result", tool_use_id: callId, content };
}

/** Replace image blocks with a placeholder in all but the most recent turns. */
export function stripOldImages(turns: StoredTurn[], keepLast: number): void {
  const cutoff = Math.max(0, turns.length - keepLast);
  for (let i = 0; i < cutoff; i++) {
    turns[i] = { ...turns[i], content: stripImagesFromContent(turns[i].content) };
  }
}

export function persistableTurns(turns: StoredTurn[]): StoredTurn[] {
  return turns.map((t) => ({
    role: t.role,
    content: stripImagesFromContent(t.content),
  }));
}

function stripImagesFromContent(content: unknown[]): unknown[] {
  let removed = 0;
  const mapped = content.map((raw) => {
    const block = raw as Record<string, unknown>;
    if (block.type === "image") {
      removed += 1;
      return { type: "text", text: "[frame image dropped from history]" };
    }
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      const inner = (block.content as unknown[]).map((c) => {
        const item = c as Record<string, unknown>;
        if (item.type === "image") {
          removed += 1;
          return { type: "text", text: "[frame image dropped from history]" };
        }
        return item;
      });
      return { ...block, content: inner };
    }
    return block;
  });
  return removed > 0 ? mapped : content;
}

function renderPending(
  message: PendingMessage,
  brief: Brief,
  project: { facts: { title: string; duration: number; chunks: unknown[] } },
  overrides: ExecContext["promptOverrides"],
): { display: string; forModel: string } {
  if (!message.isBrief) {
    const prefix = message.answerTo ? "Answering your question: " : "";
    return {
      display: message.text,
      forModel: `${prefix}${message.text}`,
    };
  }

  const { text: template } = getPrompt("brief", overrides);
  const chunkNote =
    project.facts.chunks.length > 1
      ? ` · indexed as ${project.facts.chunks.length} chunks (handled for you)`
      : "";
  const instructions = brief.userPrompt?.trim()
    ? `**The producer also says:** ${brief.userPrompt.trim()}\n\n`
    : "";

  const formatGuide = FORMAT_GUIDES[brief.format ?? ""];
  const formatGuideBlock = formatGuide
    ? `**What this format means:** ${formatGuide}\n\n`
    : "";

  const text = renderTemplate(template, {
    title: project.facts.title,
    durationHuman: fmt(project.facts.duration),
    durationSeconds: project.facts.duration.toFixed(0),
    chunkNote,
    format: brief.format ?? "compact_video",
    platform: brief.platform ?? "unspecified",
    assetType: brief.assetType ?? "unspecified",
    targetLine: describeTarget(brief, project.facts.duration),
    boundsLine: describeBounds(brief),
    formatGuideBlock,
    instructionsBlock: instructions,
  });

  return { display: text, forModel: text };
}

export { PROMPT_VERSION };
