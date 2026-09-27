/**
 * Tool routing — a plain switch, no framework (12-factor #3).
 *
 * Every branch returns a structured result. Nothing in here throws at the loop:
 * a tool failure is information the model can act on, not a crashed turn
 * (12-factor #11).
 */

import type { TwelveLabs } from "twelvelabs-js";
import {
  FRAME_EXAMINE_PAD_SEC,
  MAX_ASKS_PER_RUN,
  MAX_BLIND_SPOT_REFUSALS,
  SEARCH_HIT_SAME_WINDOW_SEC,
  SEARCH_NOVELTY_FLOOR,
  SEARCH_UNPRODUCTIVE_STOP_AT,
  SEARCH_UNPRODUCTIVE_WARN_AT,
} from "./config";
import { recordExamined, totalSeconds } from "./examined";
import { buildVocabulary, findUngroundedNames } from "./grounding";
import {
  computeLedger,
  fmt,
  fmtTimecode,
  renderBlindSpots,
  renderLedger,
  renderSegmentTable,
  type CoverageInput,
} from "./ledger";
import { getPrompt, renderTemplate } from "./prompts";
import { applyEdits, renderEditOutcome, type EditOp } from "./tools/edit";
import { runViewFrames } from "./tools/frames";
import { errorMessage, runSearchVideo } from "./tools/search";
import {
  loadTranscriptWords,
  runReadTranscript,
  type TranscriptWord,
} from "./tools/transcript";
import { runWatchClip, type WatchHistoryEntry } from "./tools/watchClip";
import {
  toolError,
  type AgentSegment,
  type Brief,
  type CostMeter,
  type Interval,
  type Ledger,
  type PromptOverrides,
  type ToolName,
  type ToolResult,
  type VideoFacts,
} from "./types";

export interface ExecContext {
  client: TwelveLabs | null;
  facts: VideoFacts;
  cacheBucket?: string;
  brief?: Brief;
  segments: AgentSegment[];
  /** The project (microseries) name, as the producer sees it. */
  projectTitle: string;
  cost: CostMeter;
  watchHistory: WatchHistoryEntry[];
  transcriptWords: TranscriptWord[] | null;
  transcriptError?: string;
  /** Every stretch looked at, carried across runs on the thread. */
  examined: Interval[];
  /**
   * Stretches verified with a visual tool (watch_clip / view_frames) this run.
   * In-memory only: edge verification must be fresh in the run that cuts.
   */
  examinedVisual: Interval[];
  askCount: number;
  finishRefusals: number;
  /** Consecutive searches that surfaced no window an earlier query had not. */
  searchMisses: number;
  /** Start times already returned by some search this run. */
  searchSeen: number[];
  blindSpotRefusals: number;
  promptOverrides?: PromptOverrides;
  onProgress: (note: string) => Promise<void>;
  /**
   * Epoch-ms ceiling for this iteration's work. Tools that call slow vendors
   * shrink their own timeouts and retries to land inside it, so the Lambda
   * checkpoints and continues instead of being killed mid-call.
   */
  deadlineAt?: number;
}

export type ExecControl =
  | { kind: "ask_user"; question: string; suggestions: string[] }
  | { kind: "finish"; summary: string; concerns: string[] };

export interface ExecOutcome {
  result: ToolResult;
  control?: ExecControl;
  segmentsChanged?: boolean;
  changedIds?: string[];
  ledger?: Ledger;
  /** Set when set_project_title renamed the project; the loop saves it. */
  projectTitle?: string;
}

/**
 * The coverage inputs for the ledger, or `undefined` to switch the gate off.
 *
 * It goes off only when the run has no way to examine anything: no transcript
 * and no TwelveLabs client. Blocking a finish on looking at footage the run
 * cannot open would deadlock it rather than improve it.
 */
function coverageFor(ctx: ExecContext): CoverageInput | undefined {
  const transcriptLoadFailed = ctx.transcriptWords?.length === 0;
  const hasTranscript = Boolean(ctx.facts.transcriptS3Uri) && !transcriptLoadFailed;
  if (!hasTranscript && !ctx.client) return undefined;
  return { examined: ctx.examined, visualExamined: ctx.examinedVisual, hasTranscript };
}

function ledgerFor(ctx: ExecContext): Ledger {
  return computeLedger(ctx.segments, ctx.brief, ctx.facts.duration, coverageFor(ctx));
}

export function markExamined(ctx: ExecContext, start: number, end: number): void {
  const before = totalSeconds(ctx.examined);
  ctx.examined = recordExamined(ctx.examined, start, end, ctx.facts.duration);
  // Looking somewhere genuinely new re-arms the search breaker. Without this,
  // tripping it would disable search for the rest of the run: the counter only
  // clears on a productive search, and there can be no productive search while
  // it is tripped. "Stop searching and go look" has to mean you may search
  // again once you have looked. Re-reading known ground does not count.
  if (totalSeconds(ctx.examined) > before + 1) ctx.searchMisses = 0;
}

export async function executeTool(
  name: ToolName,
  input: Record<string, unknown>,
  ctx: ExecContext,
): Promise<ExecOutcome> {
  ctx.cost.toolCalls += 1;

  try {
    const outcome = await route(name, input, ctx);
    if (!outcome.result.ok) ctx.cost.toolErrors += 1;
    return outcome;
  } catch (err) {
    // A thrown exception here is a bug on our side, not the model's. Report it
    // as a structured result so the run can continue and the user can see it.
    ctx.cost.toolErrors += 1;
    const detail = errorMessage(err);
    console.error(`[IQAgent] tool ${name} threw:`, err);
    return {
      result: toolError(
        "tool_crashed",
        `${name} hit an unexpected internal error: ${detail}`,
        "Try a different approach or a different tool. If it keeps happening, finish the turn and report it.",
        { detail, retryable: true },
      ),
    };
  }
}

async function route(
  name: ToolName,
  input: Record<string, unknown>,
  ctx: ExecContext,
): Promise<ExecOutcome> {
  switch (name) {
    case "search_video":
      return { result: await execSearch(input, ctx) };
    case "read_transcript":
      return { result: await execTranscript(input, ctx) };
    case "watch_clip":
      return { result: await execWatch(input, ctx) };
    case "view_frames":
      return { result: await execFrames(input, ctx) };
    case "edit_segments":
      return execEdit(input, ctx);
    case "check_budget":
      return execCheckBudget(ctx);
    case "ask_user":
      return execAsk(input, ctx);
    case "set_project_title":
      return execSetProjectTitle(input, ctx);
    case "finish_turn":
      return execFinish(input, ctx);
    default:
      return {
        result: toolError(
          "unknown_tool",
          `There is no tool called "${String(name)}".`,
          "Use one of the tools you were given.",
        ),
      };
  }
}

async function execSearch(
  input: Record<string, unknown>,
  ctx: ExecContext,
): Promise<ToolResult> {
  if (!ctx.client) {
    return toolError(
      "twelvelabs_unavailable",
      "The TwelveLabs client is not configured for this run.",
      "Use read_transcript and view_frames to work without semantic search.",
    );
  }
  // Circuit breaker for search spinning. Marengo returns a full page of loosely
  // ranked hits for almost any phrasing, so a query that found nothing looks
  // exactly like one that found plenty and the agent has no way to tell it is
  // going in circles. The measure is whether a query surfaced any window an
  // earlier query did not — deliberately not whether the window has been
  // examined, because searching for a visual moment inside a stretch you have
  // only read the dialogue of is a perfectly good thing to do.
  if (ctx.searchMisses >= SEARCH_UNPRODUCTIVE_STOP_AT) {
    return toolError(
      "search_exhausted",
      `The last ${ctx.searchMisses} searches came back with the same windows earlier queries already returned. Rephrasing again is not going to surface anything new.`,
      "Read the timeline directly instead — read_transcript over a stretch you have not looked at will tell you what is actually there. The budget lists any stretch still unexamined.",
      { summary: `Search paused · ${ctx.searchMisses} repeats in a row` },
    );
  }

  const result = await runSearchVideo({
    client: ctx.client,
    facts: ctx.facts,
    query: String(input.query ?? ""),
    modalities: input.modalities,
    operator: input.operator,
    limit: input.limit,
    timeRange: input.timeRange as { start?: number; end?: number } | undefined,
  });

  if (!result.ok) return result;
  ctx.cost.searches += 1;

  const hits =
    (result.digest as { hits?: Array<{ start: number; end: number }> } | undefined)?.hits ?? [];
  const fresh = hits.filter(
    (h) => !ctx.searchSeen.some((seen) => Math.abs(seen - h.start) <= SEARCH_HIT_SAME_WINDOW_SEC),
  );
  for (const h of fresh) ctx.searchSeen.push(h.start);

  if (hits.length > 0 && fresh.length / hits.length < SEARCH_NOVELTY_FLOOR) {
    ctx.searchMisses += 1;
    if (ctx.searchMisses >= SEARCH_UNPRODUCTIVE_WARN_AT) {
      return {
        ...result,
        warnings: [
          ...(result.warnings ?? []),
          `That is ${ctx.searchMisses} queries in a row returning windows your earlier searches already found. Search has given you what it has; read_transcript across a stretch you have not looked at will tell you more.`,
        ],
      };
    }
  } else {
    ctx.searchMisses = 0;
  }

  return result;
}

async function execTranscript(
  input: Record<string, unknown>,
  ctx: ExecContext,
): Promise<ToolResult> {
  if (ctx.transcriptWords === null) {
    if (!ctx.facts.transcriptS3Uri) {
      ctx.transcriptWords = [];
      ctx.transcriptError = "This source has no transcript.";
    } else {
      try {
        ctx.transcriptWords = await loadTranscriptWords(ctx.facts.transcriptS3Uri);
      } catch (err) {
        ctx.transcriptWords = [];
        ctx.transcriptError = errorMessage(err);
      }
    }
  }

  if (ctx.transcriptWords.length === 0) {
    return toolError(
      "no_transcript",
      `No dialogue is available for this source. ${ctx.transcriptError ?? ""}`.trim(),
      "Use search_video with the 'audio' and 'visual' modalities, and watch_clip to hear what is said.",
      { detail: ctx.transcriptError },
    );
  }

  const result = runReadTranscript({
    words: ctx.transcriptWords,
    start: Number(input.start),
    end: Number(input.end),
    granularity: input.granularity === "words" ? "words" : "sentences",
    videoDuration: ctx.facts.duration,
  });
  if (result.ok) {
    ctx.cost.transcriptReads += 1;
    // Only as far as the output actually reached. A read that was truncated at
    // the character cap showed the agent the first half of the range and
    // nothing after it, and crediting the rest would be a coverage false pass.
    const digest = result.digest as { start?: number; coveredEnd?: number } | undefined;
    markExamined(
      ctx,
      digest?.start ?? Number(input.start),
      digest?.coveredEnd ?? Number(input.end),
    );
  }
  return result;
}

async function execWatch(
  input: Record<string, unknown>,
  ctx: ExecContext,
): Promise<ToolResult> {
  if (!ctx.client) {
    return toolError(
      "twelvelabs_unavailable",
      "The TwelveLabs client is not configured for this run.",
      "Use read_transcript and view_frames instead.",
    );
  }

  const outcome = await runWatchClip({
    client: ctx.client,
    facts: ctx.facts,
    cacheBucket: ctx.cacheBucket,
    start: Number(input.start),
    end: Number(input.end),
    question: String(input.question ?? ""),
    history: ctx.watchHistory,
    deadlineAt: ctx.deadlineAt,
    onProgress: (note) => {
      void ctx.onProgress(note).catch(() => undefined);
    },
  });

  if (outcome.result.ok) {
    if (outcome.cacheHit) {
      ctx.cost.pegasusCacheHits += 1;
    } else {
      ctx.cost.pegasusCalls += 1;
      ctx.cost.pegasusSeconds += outcome.videoSecondsWatched;
    }
  }
  // Credit the window Pegasus actually watched, which can differ from the one
  // that was asked for once it is widened to the 4s floor or clipped to the
  // indexed duration.
  if (outcome.recorded) {
    ctx.watchHistory.push(outcome.recorded);
    markExamined(ctx, outcome.recorded.start, outcome.recorded.end);
    ctx.examinedVisual = recordExamined(
      ctx.examinedVisual,
      outcome.recorded.start,
      outcome.recorded.end,
      ctx.facts.duration,
    );
  }

  return outcome.result;
}

async function execFrames(
  input: Record<string, unknown>,
  ctx: ExecContext,
): Promise<ToolResult> {
  const result = await runViewFrames({
    facts: ctx.facts,
    cacheBucket: ctx.cacheBucket,
    timestamps: input.timestamps,
    purpose: String(input.purpose ?? "visual check"),
  });
  if (result.ok && result.images) {
    ctx.cost.frames += result.images.length;
    const stamps = Array.isArray(input.timestamps) ? input.timestamps : [];
    for (const raw of stamps) {
      const t = Number(raw);
      if (Number.isFinite(t)) {
        markExamined(ctx, t - FRAME_EXAMINE_PAD_SEC, t + FRAME_EXAMINE_PAD_SEC);
        ctx.examinedVisual = recordExamined(
          ctx.examinedVisual,
          t - FRAME_EXAMINE_PAD_SEC,
          t + FRAME_EXAMINE_PAD_SEC,
          ctx.facts.duration,
        );
      }
    }
  }
  return result;
}

function execEdit(
  input: Record<string, unknown>,
  ctx: ExecContext,
): ExecOutcome {
  const rawOps = Array.isArray(input.ops) ? (input.ops as EditOp[]) : null;

  if (!rawOps || rawOps.length === 0) {
    return {
      result: toolError(
        "no_ops",
        "edit_segments was called with no operations.",
        "Pass ops as an array, e.g. [{op:'add', start: 412, end: 470, title:'Mara confronts her brother'}].",
      ),
    };
  }

  const bounds = {
    min: ctx.brief?.minSegmentDuration ?? null,
    max: ctx.brief?.maxSegmentDuration ?? null,
  };
  const outcome = applyEdits(ctx.segments, rawOps, ctx.facts.duration, bounds);
  ctx.segments = outcome.segments;

  const ledger = ledgerFor(ctx);
  const body = `${renderEditOutcome(outcome)}\n\nBUDGET AFTER THIS EDIT\n${renderLedger(ledger)}`;

  if (outcome.applied.length === 0) {
    return {
      result: toolError(
        "all_ops_rejected",
        `Every operation was rejected.\n${renderEditOutcome(outcome)}`,
        "Read the reasons above, fix the timestamps or ids, and try again. The current cut is unchanged.",
        { summary: `Rejected ${outcome.rejected.length} edit(s)` },
      ),
      ledger,
    };
  }

  const parts: string[] = [];
  const adds = outcome.applied.filter((a) => a.op === "add").length;
  const updates = outcome.applied.filter((a) => a.op === "update").length;
  const removes = outcome.applied.filter((a) => a.op === "remove").length;
  if (adds) parts.push(`added ${adds}`);
  if (updates) parts.push(`adjusted ${updates}`);
  if (removes) parts.push(`removed ${removes}`);
  if (outcome.rejected.length) parts.push(`${outcome.rejected.length} rejected`);

  const warnings: string[] = [];
  for (const applied of outcome.applied) {
    for (const note of applied.notes) {
      warnings.push(`${applied.segmentId}: ${note}`);
    }
  }
  for (const rejected of outcome.rejected) {
    warnings.push(`Rejected ${rejected.op}: ${rejected.reason}`);
  }
  warnings.push(...groundingWarnings(rawOps, ctx));

  return {
    result: {
      ok: true,
      text: body,
      summary: `${capitalize(parts.join(", "))} · ${ledger.segmentCount} segments, ${ledger.totalDuration.toFixed(0)}s total`,
      digest: {
        applied: outcome.applied.map((a) => `${a.op} ${a.segmentId}`),
        rejected: outcome.rejected.length,
        total: ledger.totalDuration,
      },
      warnings: warnings.length > 0 ? warnings : undefined,
    },
    segmentsChanged: true,
    changedIds: outcome.changedIds,
    ledger,
  };
}

/**
 * Flag proper nouns in a title that the source never says. Advisory only: ASR
 * mangles names, so an unmatched one is a prompt to check rather than a fault.
 */
function groundingWarnings(ops: EditOp[], ctx: ExecContext): string[] {
  const titles = ops
    .map((op) => (typeof op.title === "string" ? op.title.trim() : ""))
    .filter(Boolean);
  if (titles.length === 0) return [];
  // Only meaningful once the transcript is loaded; a title written before any
  // read would be flagged against an empty vocabulary.
  if (!ctx.transcriptWords || ctx.transcriptWords.length === 0) return [];

  const vocab = buildVocabulary({
    transcriptWords: ctx.transcriptWords,
    title: ctx.facts.title,
    userPrompt: ctx.brief?.userPrompt,
  });

  const warnings: string[] = [];
  for (const title of titles) {
    const unknown = findUngroundedNames(vocab, title);
    if (unknown.length > 0) {
      warnings.push(
        `"${title}" names ${unknown.map((n) => `"${n}"`).join(", ")}, which the transcript never says. Speech-to-text garbles proper nouns, so it may still be right — but if you are recalling that name from outside this video rather than reading it here, take it out.`,
      );
    }
  }
  return warnings;
}

function execCheckBudget(ctx: ExecContext): ExecOutcome {
  const ledger = ledgerFor(ctx);
  return {
    result: {
      ok: true,
      text: `CURRENT CUT\n${renderSegmentTable(ctx.segments)}\n\nBUDGET\n${renderLedger(ledger)}`,
      summary: `Checked the budget · ${ledger.segmentCount} segments, ${ledger.totalDuration.toFixed(0)}s`,
      digest: {
        segments: ledger.segmentCount,
        total: ledger.totalDuration,
        blocking: ledger.blocking.length,
      },
    },
    ledger,
  };
}

function execSetProjectTitle(
  input: Record<string, unknown>,
  ctx: ExecContext,
): ExecOutcome {
  const title = String(input.title ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (title.length === 0) {
    return {
      result: toolError(
        "empty_title",
        "set_project_title was called with no title.",
        "Pass the series name as `title`.",
      ),
    };
  }
  const previous = ctx.projectTitle;
  ctx.projectTitle = title;
  return {
    result: {
      ok: true,
      text: `Project renamed from "${previous}" to "${title}". Tell the producer in your reply.`,
      summary: `Named the project "${truncate(title, 60)}"`,
      digest: { title, previous },
    },
    projectTitle: title,
  };
}

function execAsk(
  input: Record<string, unknown>,
  ctx: ExecContext,
): ExecOutcome {
  const question = String(input.question ?? "").trim();
  if (question.length === 0) {
    return {
      result: toolError(
        "empty_question",
        "ask_user was called with no question.",
        "Either ask something specific, or keep working and answer it yourself.",
      ),
    };
  }

  if (ctx.askCount >= MAX_ASKS_PER_RUN) {
    return {
      result: toolError(
        "too_many_questions",
        `You have already asked ${ctx.askCount} question(s) this run.`,
        "Make your best editorial judgment, note the assumption in your finish_turn concerns, and keep going.",
      ),
    };
  }

  const suggestions = Array.isArray(input.suggestions)
    ? input.suggestions.map((s) => String(s)).filter(Boolean).slice(0, 4)
    : [];

  ctx.askCount += 1;

  return {
    result: {
      ok: true,
      text: "Question sent to the producer. Your run is suspended until they reply.",
      summary: `Asked: ${truncate(question, 60)}`,
      digest: { question: truncate(question, 120) },
    },
    control: { kind: "ask_user", question, suggestions },
  };
}

function execFinish(
  input: Record<string, unknown>,
  ctx: ExecContext,
): ExecOutcome {
  const summary = String(input.summary ?? "").trim() || "Turn complete.";
  const concerns = Array.isArray(input.concerns)
    ? input.concerns.map((c) => String(c)).filter(Boolean)
    : [];

  const ledger = ledgerFor(ctx);

  // The coverage gate, checked before the budget and answerable only by going
  // and looking. Unlike the arithmetic below there is no second attempt that
  // waves it through on the strength of an argument: an editorial judgment can
  // outrank a runtime target, but there is no judgment to be had about footage
  // nobody has seen. The refusal cap exists so a run that genuinely cannot
  // examine anything still ends instead of spending every step here.
  const blindSpots = ledger.coverage.blindSpots;
  if (blindSpots.length > 0 && ctx.blindSpotRefusals < MAX_BLIND_SPOT_REFUSALS) {
    ctx.blindSpotRefusals += 1;
    const unseen = blindSpots.reduce((sum, s) => sum + s.seconds, 0);
    return {
      result: toolError(
        "unexamined_footage",
        `Not finishing yet. ${
          blindSpots.length === 1 ? "This stretch" : "These stretches"
        } of the source have never been looked at, and nothing was cut from ${
          blindSpots.length === 1 ? "it" : "them"
        }:\n\n${renderBlindSpots(blindSpots)}\n\nYou cannot know whether the cut is missing something from footage you have not opened. The producer asked for a cut of this video, not of the part of it you happened to search into.`,
        "read_transcript over each stretch above is the simplest way to clear this — one wide read usually covers all of it. Use watch_clip or view_frames where the moment is visual and the dialogue will not tell you. Then finish.",
        {
          summary: `Finish blocked · ${Math.round(unseen)}s never examined`,
          retryable: false,
        },
      ),
      ledger,
    };
  }

  // Guarded finish: refuse once while the budget is blocking, with the specific
  // numbers attached. On the second attempt the finish goes through and the
  // concerns are surfaced to the producer.
  if (ledger.blocking.length > 0 && ctx.finishRefusals < 1) {
    ctx.finishRefusals += 1;
    const { text: template } = getPrompt("guardedFinish", ctx.promptOverrides);
    const message = renderTemplate(template, {
      blocking: ledger.blocking.map((b) => `- ${b}`).join("\n"),
      ledger: renderLedger(ledger),
    });
    return {
      result: toolError(
        "unresolved_violations",
        message,
        "Fix the blocking items with edit_segments, then finish.",
        { summary: `Finish blocked · ${ledger.blocking.length} unresolved` },
      ),
      ledger,
    };
  }

  const allConcerns = [
    ...concerns,
    ...ledger.blocking.map((b) => `Unresolved: ${b}`),
    // Only reachable via the refusal cap, and the producer needs to know the
    // cut was signed off with part of the source never opened.
    ...blindSpots.map(
      (s) =>
        `Never examined: ${fmtTimecode(s.start)}–${fmtTimecode(s.end)} (${fmt(s.seconds)} of the source).`,
    ),
  ];

  return {
    result: {
      ok: true,
      text: "Turn finished.",
      summary: "Finished",
      digest: { summary: truncate(summary, 120) },
    },
    control: { kind: "finish", summary, concerns: allConcerns },
    ledger,
  };
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
