/**
 * IQ Agent — shared types.
 *
 * The agent is a conversational cutting agent: Claude reasons, TwelveLabs
 * (Marengo search + Pegasus 1.5 ranged analysis), the word-level transcript and
 * extracted frames are its senses, and a small tool set edits the cut.
 *
 * Two processes share one contract: the worker appends to a seq-ordered event
 * log, the client reads it from a cursor. Nothing else crosses the boundary.
 */

// ============================================================================
// Brief — the IQ panel selections. Defaults, not a workflow.
// ============================================================================

export interface Brief {
  /** compact_video | episode_recap | highlights | full_video */
  format: string;
  /** tv | movie | other */
  assetType?: string;
  /** mobile | tv | tiktok | ig | shorts | facebook */
  platform?: string;
  /** Percent of source length to retain. null = agent decides. */
  targetPercent?: number | null;
  /** Explicit total target in seconds. Overrides targetPercent when set. */
  targetSeconds?: number | null;
  minSegmentDuration?: number | null;
  maxSegmentDuration?: number | null;
  /** Free-text producer instructions. */
  userPrompt?: string;
  autoFrame?: boolean;
  targetAspectRatio?: string;
}

// ============================================================================
// Segments — same shape the editor and renderer already use.
// ============================================================================

export interface AgentSegment {
  id: string;
  startTime: number;
  endTime: number;
  title: string;
  description: string;
  characters: string[];
  sceneTags: string[];
  keyDialogue: string;
  confidence: number;
  /** Preserved verbatim across agent edits — framing is written by another job. */
  framing?: unknown;
}

// ============================================================================
// Ledger — deterministic budget arithmetic, recomputed after every mutation.
// ============================================================================

export type TargetStatus = "under" | "within" | "over" | "no_target";

export interface LedgerTarget {
  seconds: number | null;
  band: [number, number] | null;
  status: TargetStatus;
  /** Signed seconds from target. Positive = over. */
  delta: number;
  deltaPercent: number;
  /** Where the target came from, so the model and user can see the reasoning. */
  source: "explicit_seconds" | "target_percent" | "format_default" | "none";
}

export interface SegmentBoundViolation {
  segmentId: string;
  title: string;
  duration: number;
  bound: "min" | "max";
  limit: number;
  /** Signed seconds past the bound. Always positive magnitude of the breach. */
  delta: number;
}

export interface LedgerOverlap {
  a: string;
  b: string;
  seconds: number;
}

/** A closed range on the source timeline, in seconds. */
export interface Interval {
  start: number;
  end: number;
}

export interface LedgerCoverage {
  quartiles: [number, number, number, number];
  largestGap: { start: number; end: number; seconds: number } | null;
  spreadWarning: string | null;
  /**
   * Stretches neither cut from nor ever examined. Kept separate from `blocking`
   * because the two gates mean different things: an editorial judgment can
   * override the arithmetic, but there is no judgment to make about footage
   * nobody looked at.
   */
  blindSpots: Array<{ start: number; end: number; seconds: number }>;
  examinedSeconds: number;
  examinedPercent: number;
}

export interface Ledger {
  videoDuration: number;
  segmentCount: number;
  totalDuration: number;
  target: {
    seconds: number | null;
    band: [number, number] | null;
    status: TargetStatus;
    delta: number;
    deltaPercent: number;
    source: LedgerTarget["source"];
  };
  perSegment: {
    min: number | null;
    max: number | null;
    violations: SegmentBoundViolation[];
  };
  overlaps: LedgerOverlap[];
  coverage: LedgerCoverage;
  /**
   * Segment edges never verified with a visual tool (view_frames/watch_clip).
   * A transcript can place a topic but not a cut point; edges placed from
   * dialogue alone are how "zone, then coast to max length" happens.
   */
  unverifiedEdges: Array<{
    segmentId: string;
    title: string;
    edge: "start" | "end";
    time: number;
  }>;
  /** Human-readable. Empty means the cut is structurally and arithmetically clean. */
  blocking: string[];
  /** Non-blocking observations worth surfacing to both model and producer. */
  warnings: string[];
}

// ============================================================================
// Cost meter — advisory. Never blocks a call.
// ============================================================================

export interface CostMeter {
  pegasusSeconds: number;
  pegasusCalls: number;
  pegasusCacheHits: number;
  searches: number;
  transcriptReads: number;
  frames: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  /** Paired with cacheReadTokens: zero writes and zero reads means caching is
   * off, which reads very differently from writes landing but never being hit. */
  cacheWriteTokens: number;
  toolCalls: number;
  toolErrors: number;
}

export function emptyCostMeter(): CostMeter {
  return {
    pegasusSeconds: 0,
    pegasusCalls: 0,
    pegasusCacheHits: 0,
    searches: 0,
    transcriptReads: 0,
    frames: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolCalls: 0,
    toolErrors: 0,
  };
}

// ============================================================================
// Tool results — structured, never thrown. 12-factor #11.
// ============================================================================

export type ToolName =
  | "search_video"
  | "read_transcript"
  | "watch_clip"
  | "view_frames"
  | "edit_segments"
  | "check_budget"
  | "ask_user"
  | "set_project_title"
  | "finish_turn";

export const TOOL_NAMES: ToolName[] = [
  "search_video",
  "read_transcript",
  "watch_clip",
  "view_frames",
  "edit_segments",
  "check_budget",
  "ask_user",
  "set_project_title",
  "finish_turn",
];

/** Image returned to Claude as a content block (view_frames only). */
export interface ToolImage {
  mediaType: "image/jpeg";
  base64: string;
  label: string;
}

export interface ToolOk {
  ok: true;
  /** Rendered for Claude. Keep it dense and factual. */
  text: string;
  /** One line for the activity box. */
  summary: string;
  /** Compact record kept in the tool ledger after the turn window rolls off. */
  digest?: unknown;
  /** Non-fatal problems the model should know about and can work around. */
  warnings?: string[];
  images?: ToolImage[];
}

export interface ToolErr {
  ok: false;
  code: string;
  message: string;
  /** What the model should try instead. Always populated. */
  hint: string;
  summary: string;
  /** Extra detail surfaced in the UI but not necessarily to the model. */
  detail?: string;
  /** Whether retrying the exact same call could plausibly succeed. */
  retryable?: boolean;
}

export type ToolResult = ToolOk | ToolErr;

export function toolError(
  code: string,
  message: string,
  hint: string,
  extra: { detail?: string; retryable?: boolean; summary?: string } = {},
): ToolErr {
  return {
    ok: false,
    code,
    message,
    hint,
    summary: extra.summary ?? `Failed: ${message}`,
    detail: extra.detail,
    retryable: extra.retryable ?? false,
  };
}

// ============================================================================
// Events — the single source of truth for the UI.
// ============================================================================

export type RunStage =
  | "starting"
  | "thinking"
  | "researching"
  | "cutting"
  | "reviewing"
  | "waiting_on_you"
  | "framing"
  | "finished";

export type RunStatus =
  | "idle"
  | "running"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentEventBody =
  | { type: "run.started"; trigger: RunTrigger; promptVersion?: string }
  | { type: "stage.changed"; stage: RunStage; note?: string }
  | { type: "message.user"; text: string; brief?: Brief; isBrief?: boolean }
  | { type: "message.assistant"; text: string }
  | {
      type: "tool.started";
      callId: string;
      name: ToolName | "unknown";
      input: unknown;
      label: string;
    }
  | { type: "tool.progress"; callId: string; note: string }
  | {
      type: "tool.finished";
      callId: string;
      name: ToolName | "unknown";
      ok: boolean;
      summary: string;
      digest?: unknown;
      /**
       * What the tool actually told the model, truncated. Without this a
       * watch_clip answer survives only in the model's context and the S3 cache,
       * so the event log cannot explain why a cut was made.
       */
      output?: string;
      warnings?: string[];
      error?: { code: string; message: string; hint: string; detail?: string };
      ms: number;
    }
  | {
      type: "state.updated";
      segments: AgentSegment[];
      ledger: Ledger;
      cost: CostMeter;
    }
  | {
      type: "question.asked";
      questionId: string;
      text: string;
      suggestions?: string[];
    }
  | { type: "run.awaiting_input" }
  | { type: "project.renamed"; title: string }
  | { type: "framing.started"; total: number }
  | { type: "framing.progress"; completed: number; total: number }
  | {
      type: "framing.completed";
      completed: number;
      total: number;
      failed?: number;
      error?: string;
    }
  | { type: "run.completed"; summary: string; concerns?: string[] }
  | {
      type: "run.failed";
      code: string;
      message: string;
      detail?: string;
      retryable: boolean;
    }
  | { type: "run.cancelled"; note?: string }
  | {
      type: "notice";
      level: "info" | "warn" | "error";
      message: string;
      detail?: string;
    };

export type AgentEvent = AgentEventBody & {
  runId: string;
  seq: number;
  ts: string;
};

// ============================================================================
// Conversation state persisted on the thread.
// ============================================================================

export interface StoredTurn {
  role: "user" | "assistant";
  /** Anthropic content blocks, already stripped of images. */
  content: unknown[];
}

export interface ToolLedgerEntry {
  name: ToolName | "unknown";
  line: string;
  ok: boolean;
}

/** Why a run exists. Shown in the panel so a run's origin is never a mystery. */
export type RunTrigger = "initial" | "message" | "answer" | "followup";

/** What finish_turn decided, held across a continuation. */
export interface PendingFinish {
  summary: string;
  concerns: string[];
}

export interface RunState {
  runId: string;
  status: RunStatus;
  stage: RunStage;
  startedAt: string;
  lastHeartbeatAt: string;
  cancelRequested?: boolean;
  iterations: number;
  askCount: number;
  finishRefusals: number;
  trigger: RunTrigger;
  endedAt?: string;
  error?: { code: string; message: string; detail?: string };
  /**
   * Set when the model called finish_turn but the invocation had too little
   * clock left to write delivery metadata. A fresh worker picks this up, skips
   * straight to wrapping up, and clears it. `null` means explicitly cleared;
   * `undefined` means the field was never written.
   */
  pendingFinish?: PendingFinish | null;
  /** Segment ids whose timing changed during this run — drives diff framing. */
  reframeIds?: string[];
  /**
   * Bumped by each worker invocation that picks this run up. Async Lambda
   * invokes are at-least-once, so two workers can hold the same runId; every
   * worker write is conditioned on its own epoch and the older one stands down.
   */
  epoch?: number;
}

export interface FramingMirror {
  jobId: string;
  status: "running" | "completed" | "failed";
  total: number;
  lastCompleted: number;
  runId: string;
  /** Bounds how long the poll endpoint keeps watching a job that never lands. */
  startedAt: string;
}

export interface PendingMessage {
  id: string;
  text: string;
  brief?: Brief;
  answerTo?: string;
  receivedAt: string;
  /** The opening brief, composed by the worker from the panel selections. */
  isBrief?: boolean;
}

export interface PromptOverrides {
  system?: string;
  brief?: string;
  guardedFinish?: string;
  compaction?: string;
}

export interface ThreadState {
  projectId: string;
  assetId: string;
  activeRunId?: string;
  runCounter: number;
  eventSeq: number;
  brief?: Brief;
  turns: StoredTurn[];
  summary?: string;
  toolLedger: ToolLedgerEntry[];
  segments: AgentSegment[];
  ledger?: Ledger;
  cost: CostMeter;
  /**
   * Everything looked at in this session, accumulated across runs. A follow-up
   * run inherits it: the editor has seen what it has seen, and re-reading it to
   * satisfy the coverage gate would be busywork.
   */
  examined: Interval[];
  pendingMessages: PendingMessage[];
  promptVersion?: string;
  promptOverrides?: PromptOverrides;
  run?: RunState;
  lastRun?: RunState;
  framing?: FramingMirror;
  openQuestionId?: string;
  idempotencyKeys?: Record<string, number>;
  updatedAt?: string;
  expiresAt?: number;
}

// ============================================================================
// Video facts the tools need. Resolved once per worker invocation.
// ============================================================================

export interface ChunkFacts {
  chunkIndex: number;
  videoId: string;
  /** Absolute start of this chunk in the source timeline. */
  sourceStart: number;
  /** Absolute end of this chunk in the source timeline. */
  sourceEnd: number;
  /** Longest chunk-local timestamp TwelveLabs will accept for this chunk. */
  indexedDuration: number;
}

export interface VideoFacts {
  assetId: string;
  title: string;
  duration: number;
  indexId: string;
  isChunked: boolean;
  /** Non-chunked assets have exactly one entry covering the whole timeline. */
  chunks: ChunkFacts[];
  transcriptS3Uri?: string;
  sourceBucket?: string;
  sourceKey?: string;
}
