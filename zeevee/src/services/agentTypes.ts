/**
 * The shape of the agent contract, plus the few presentation helpers the panel
 * shares. Kept free of transport concerns so it can be exercised in isolation.
 *
 * Mirrors backend/src/services/iq-agent/types.ts.
 */

import type { Segment } from "@/store/editorSlice";

export type ToolName =
  | "search_video"
  | "read_transcript"
  | "watch_clip"
  | "view_frames"
  | "edit_segments"
  | "check_budget"
  | "ask_user"
  | "finish_turn";

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

export interface AgentBrief {
  format: string;
  assetType?: string;
  platform?: string;
  targetPercent?: number | null;
  targetSeconds?: number | null;
  minSegmentDuration?: number | null;
  maxSegmentDuration?: number | null;
  userPrompt?: string;
  autoFrame?: boolean;
  targetAspectRatio?: string;
  isSports?: boolean;
}

export interface AgentLedger {
  videoDuration: number;
  segmentCount: number;
  totalDuration: number;
  target: {
    seconds: number | null;
    band: [number, number] | null;
    status: "under" | "within" | "over" | "no_target";
    delta: number;
    deltaPercent: number;
    source: "explicit_seconds" | "target_percent" | "format_default" | "none";
  };
  perSegment: {
    min: number | null;
    max: number | null;
    violations: Array<{
      segmentId: string;
      title: string;
      duration: number;
      bound: "min" | "max";
      limit: number;
      delta: number;
    }>;
  };
  overlaps: Array<{ a: string; b: string; seconds: number }>;
  coverage: {
    quartiles: [number, number, number, number];
    largestGap: { start: number; end: number; seconds: number } | null;
    spreadWarning: string | null;
    /** Stretches neither cut from nor ever examined. Blocks the agent finishing. */
    blindSpots: Array<{ start: number; end: number; seconds: number }>;
    examinedSeconds: number;
    examinedPercent: number;
  };
  blocking: string[];
  warnings: string[];
}

export interface AgentCost {
  pegasusSeconds: number;
  pegasusCalls: number;
  pegasusCacheHits: number;
  searches: number;
  transcriptReads: number;
  frames: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolCalls: number;
  toolErrors: number;
}

export interface AgentToolError {
  code: string;
  message: string;
  hint: string;
  detail?: string;
}

export type AgentEventBody =
  | { type: "run.started"; trigger: string; promptVersion?: string }
  | { type: "stage.changed"; stage: RunStage; note?: string }
  | { type: "message.user"; text: string; brief?: AgentBrief; isBrief?: boolean }
  | { type: "message.assistant"; text: string }
  | {
      type: "tool.started";
      callId: string;
      name: ToolName;
      input: unknown;
      label: string;
    }
  | { type: "tool.progress"; callId: string; note: string }
  | {
      type: "tool.finished";
      callId: string;
      name: ToolName;
      ok: boolean;
      summary: string;
      digest?: unknown;
      /** What the tool told the model, truncated. Kept for auditing a run. */
      output?: string;
      warnings?: string[];
      error?: AgentToolError;
      ms: number;
    }
  | {
      type: "state.updated";
      segments: Segment[];
      ledger: AgentLedger;
      cost: AgentCost;
    }
  | {
      type: "question.asked";
      questionId: string;
      text: string;
      suggestions?: string[];
    }
  | { type: "run.awaiting_input" }
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

export interface AgentRunState {
  runId: string;
  status: RunStatus;
  stage: RunStage;
  startedAt: string;
  lastHeartbeatAt: string;
  cancelRequested?: boolean;
  iterations: number;
  askCount: number;
  finishRefusals: number;
  trigger: string;
  endedAt?: string;
  error?: { code: string; message: string; detail?: string };
}

export interface AgentEventsResponse {
  cursor: number;
  hasMore: boolean;
  events: AgentEvent[];
  run: AgentRunState | null;
  lastRun: AgentRunState | null;
  segments: Segment[];
  ledger: AgentLedger | null;
  cost: AgentCost;
  brief: AgentBrief | null;
  openQuestionId: string | null;
  framing: { jobId: string; status: string; total: number } | null;
  queuedMessages?: number;
  promptVersion: string;
}

export interface SendMessageResponse {
  runId: string | null;
  started: boolean;
  queued: boolean;
  duplicate?: boolean;
  note?: string;
}

export interface AgentPromptSpec {
  key: "system" | "brief" | "guardedFinish" | "compaction";
  label: string;
  description: string;
  variables: string[];
  default: string;
  override: string | null;
}

export const STAGE_LABELS: Record<RunStage, string> = {
  starting: "Starting up",
  thinking: "Thinking",
  researching: "Studying the footage",
  cutting: "Building the cut",
  reviewing: "Checking the numbers",
  waiting_on_you: "Waiting on you",
  framing: "Framing the shots",
  finished: "Done",
};

export function formatDuration(seconds: number): string {
  const total = Math.round(Math.abs(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const sign = seconds < 0 ? "-" : "";
  return m > 0 ? `${sign}${m}m ${String(s).padStart(2, "0")}s` : `${sign}${s}s`;
}
