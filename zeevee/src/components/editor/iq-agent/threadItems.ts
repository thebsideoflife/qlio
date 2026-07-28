/**
 * Turns the raw event log into the rows the thread renders.
 *
 * Kept apart from the component because this is where the log's ordering and
 * in-place updates (tool progress, framing progress) are reasoned about, and
 * that deserves to be tested on its own.
 */

import {
  STAGE_LABELS,
  type AgentEvent,
  type AgentToolError,
  type ToolName,
} from "@/services/agentTypes";

/** Only used when a result arrives without the call that produced it. */
const TOOL_FALLBACK_LABELS: Record<ToolName, string> = {
  search_video: "Searched the video",
  read_transcript: "Read the transcript",
  watch_clip: "Watched a clip",
  view_frames: "Looked at frames",
  edit_segments: "Edited the cut",
  check_budget: "Checked the budget",
  ask_user: "Asked a question",
  finish_turn: "Wrapped up",
};

export type ToolItem = {
  kind: "tool";
  key: string;
  seq: number;
  name: ToolName;
  label: string;
  progress: string[];
  done: boolean;
  ok: boolean;
  summary?: string;
  warnings?: string[];
  error?: AgentToolError;
  ms?: number;
};

export type ThreadItem =
  | { kind: "user"; key: string; seq: number; text: string; isBrief: boolean }
  | { kind: "assistant"; key: string; seq: number; text: string }
  | ToolItem
  | { kind: "stage"; key: string; seq: number; label: string; note?: string }
  | {
      kind: "notice";
      key: string;
      seq: number;
      level: "info" | "warn" | "error";
      message: string;
      detail?: string;
    }
  | { kind: "question"; key: string; seq: number; text: string }
  | {
      kind: "framing";
      key: string;
      seq: number;
      completed: number;
      total: number;
      done: boolean;
      error?: string;
    }
  | {
      kind: "completed";
      key: string;
      seq: number;
      summary: string;
      concerns: string[];
    }
  | {
      kind: "failed";
      key: string;
      seq: number;
      code: string;
      message: string;
      detail?: string;
      retryable: boolean;
    }
  | { kind: "cancelled"; key: string; seq: number; note?: string }
  | { kind: "runStart"; key: string; seq: number };

export function buildThreadItems(events: AgentEvent[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  const toolIndex = new Map<string, ToolItem>();
  let framingItem: Extract<ThreadItem, { kind: "framing" }> | null = null;
  let lastStage: string | null = null;

  for (const event of events) {
    switch (event.type) {
      case "run.started":
        // The first run needs no divider; later ones mark a new turn.
        if (items.length > 0) {
          items.push({ kind: "runStart", key: `s${event.seq}`, seq: event.seq });
        }
        lastStage = null;
        break;

      case "message.user":
        items.push({
          kind: "user",
          key: `s${event.seq}`,
          seq: event.seq,
          text: event.text,
          isBrief: event.isBrief === true,
        });
        break;

      case "message.assistant":
        items.push({
          kind: "assistant",
          key: `s${event.seq}`,
          seq: event.seq,
          text: event.text,
        });
        break;

      case "stage.changed":
        // "Thinking" between every tool call is noise; the spinner covers it.
        // It also isn't recorded, so dropping back into it and out again
        // doesn't reprint the heading the producer is already looking at.
        if (event.stage === "thinking") break;
        if (event.stage !== lastStage) {
          items.push({
            kind: "stage",
            key: `s${event.seq}`,
            seq: event.seq,
            label: STAGE_LABELS[event.stage] ?? event.stage,
            note: event.note,
          });
        }
        lastStage = event.stage;
        break;

      case "tool.started": {
        const item: ToolItem = {
          kind: "tool",
          key: `t${event.callId}`,
          seq: event.seq,
          name: event.name,
          label: event.label,
          progress: [],
          done: false,
          ok: true,
        };
        toolIndex.set(event.callId, item);
        items.push(item);
        break;
      }

      case "tool.progress": {
        const item = toolIndex.get(event.callId);
        if (item) item.progress.push(event.note);
        break;
      }

      case "tool.finished": {
        // A client that joined mid-run can see a result whose start is behind
        // its cursor. Stand a row up for it rather than drop the outcome.
        const item = toolIndex.get(event.callId) ?? {
          kind: "tool" as const,
          key: `t${event.callId}`,
          seq: event.seq,
          name: event.name,
          label: TOOL_FALLBACK_LABELS[event.name] ?? event.name,
          progress: [],
          done: false,
          ok: true,
        };
        if (!toolIndex.has(event.callId)) {
          toolIndex.set(event.callId, item);
          items.push(item);
        }
        item.done = true;
        item.ok = event.ok;
        item.summary = event.summary;
        item.warnings = event.warnings;
        item.error = event.error;
        item.ms = event.ms;
        break;
      }

      case "question.asked":
        items.push({
          kind: "question",
          key: `s${event.seq}`,
          seq: event.seq,
          text: event.text,
        });
        break;

      case "framing.started":
        framingItem = {
          kind: "framing",
          key: `f${event.seq}`,
          seq: event.seq,
          completed: 0,
          total: event.total,
          done: false,
        };
        items.push(framingItem);
        break;

      case "framing.progress":
        if (framingItem && !framingItem.done) {
          framingItem.completed = event.completed;
          framingItem.total = event.total;
        }
        break;

      case "framing.completed":
        if (framingItem && !framingItem.done) {
          framingItem.completed = event.completed;
          framingItem.total = event.total;
          framingItem.done = true;
          framingItem.error = event.error;
        } else {
          framingItem = {
            kind: "framing",
            key: `f${event.seq}`,
            seq: event.seq,
            completed: event.completed,
            total: event.total,
            done: true,
            error: event.error,
          };
          items.push(framingItem);
        }
        break;

      case "run.completed":
        items.push({
          kind: "completed",
          key: `s${event.seq}`,
          seq: event.seq,
          summary: event.summary,
          concerns: event.concerns ?? [],
        });
        break;

      case "run.failed":
        items.push({
          kind: "failed",
          key: `s${event.seq}`,
          seq: event.seq,
          code: event.code,
          message: event.message,
          detail: event.detail,
          retryable: event.retryable,
        });
        break;

      case "run.cancelled":
        items.push({
          kind: "cancelled",
          key: `s${event.seq}`,
          seq: event.seq,
          note: event.note,
        });
        break;

      case "notice":
        items.push({
          kind: "notice",
          key: `s${event.seq}`,
          seq: event.seq,
          level: event.level,
          message: event.message,
          detail: event.detail,
        });
        break;

      default:
        break;
    }
  }

  return items;
}

