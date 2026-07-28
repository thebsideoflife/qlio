/**
 * Tool schemas. JSON in, JSON out — no framework (12-factor #3).
 *
 * Descriptions say what each tool is for and how long it takes, since latency
 * is the only thing the model should weigh when choosing between them.
 * Structural limits live in `config.ts` and are enforced in `executor.ts`,
 * never by asking the prompt nicely.
 */

import {
  FRAMES_PER_CALL,
  MAX_CLIP_WINDOW_SEC,
  MIN_CLIP_SEC,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
} from "./config";
import { fmtTimecode } from "./ledger";
import type { ToolName } from "./types";

export interface ToolSchema {
  name: ToolName;
  description: string;
  input_schema: Record<string, unknown>;
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "search_video",
    description:
      "Semantic search over the video for moments matching a natural-language query. Returns ranked clips with real timestamps on the source timeline. Fast — prefer it over watch_clip for discovery, and run several differently-phrased queries to map the video before you start cutting.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural language, e.g. 'two characters arguing in a car'. Up to 500 tokens.",
        },
        modalities: {
          type: "array",
          items: { type: "string", enum: ["visual", "audio", "transcription"] },
          description: "Defaults to ['visual','transcription'].",
        },
        operator: {
          type: "string",
          enum: ["or", "and"],
          description:
            "'or' matches any modality (default, broader). 'and' requires all of them.",
        },
        limit: {
          type: "integer",
          maximum: SEARCH_MAX_LIMIT,
          description: `Results to return. Default ${SEARCH_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT}.`,
        },
        timeRange: {
          type: "object",
          properties: {
            start: { type: "number" },
            end: { type: "number" },
          },
          description:
            "Optional. Restrict results to this window of the source timeline, in seconds.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_transcript",
    description:
      "Read the spoken dialogue for a time range. Instant — use it liberally to understand what is said, verify a cut lands between sentences, and check that a segment opens and closes cleanly. Also reports the nearest silences on either side of the range, which is where clean edges usually are.",
    input_schema: {
      type: "object",
      properties: {
        start: { type: "number", description: "Source-timeline seconds." },
        end: { type: "number", description: "Source-timeline seconds." },
        granularity: {
          type: "string",
          enum: ["sentences", "words"],
          description:
            "Default 'sentences'. Use 'words' when you need exact per-word timings to place a cut edge.",
        },
      },
      required: ["start", "end"],
    },
  },
  {
    name: "watch_clip",
    description: `Watch a specific window of the video and answer a question about it. Your only access to motion, performance, and pacing, and by far the slowest tool — a long window can take minutes while the producer waits. Use search_video and read_transcript to find candidates first, then watch the window a decision actually turns on. Windows must be at least ${MIN_CLIP_SEC}s; a shorter one is widened automatically.`,
    input_schema: {
      type: "object",
      properties: {
        start: { type: "number", description: "Source-timeline seconds." },
        end: {
          type: "number",
          description: `Source-timeline seconds. Long windows are allowed but slow; anything over ${MAX_CLIP_WINDOW_SEC}s is rejected as a mistake.`,
        },
        question: {
          type: "string",
          description:
            "What you want to know about this window. Be specific — ask for timestamps if you need them.",
        },
      },
      required: ["start", "end", "question"],
    },
  },
  {
    name: "view_frames",
    description: `Extract still frames from the video and look at them yourself. Use it to check framing, confirm a hard cut at a boundary, see who is on screen, or judge visual quality. Far quicker than watch_clip, but static — it shows composition, not motion. Up to ${FRAMES_PER_CALL} frames per call.`,
    input_schema: {
      type: "object",
      properties: {
        timestamps: {
          type: "array",
          items: { type: "number" },
          description: `Source-timeline seconds. Max ${FRAMES_PER_CALL} per call.`,
        },
        purpose: {
          type: "string",
          description: "What you are checking for.",
        },
      },
      required: ["timestamps", "purpose"],
    },
  },
  {
    name: "edit_segments",
    description:
      "Add, remove, or adjust segments in the cut. Every call returns the full recomputed budget — segment count, total runtime, distance from target, and any violations. Read that budget carefully: it is the ground truth on whether your cut meets the requirements. Batch related changes into a single call. Valid operations apply even when others in the batch are rejected.",
    input_schema: {
      type: "object",
      properties: {
        ops: {
          type: "array",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["add", "remove", "update"] },
              segmentId: {
                type: "string",
                description: "Required for remove and update.",
              },
              start: { type: "number", description: "Source-timeline seconds." },
              end: { type: "number", description: "Source-timeline seconds." },
              title: {
                type: "string",
                description:
                  "Ten words or less, WHO does WHAT. Never 'Part N' or 'Scene N'.",
              },
              description: {
                type: "string",
                description: "One sentence on why this moment earns its place.",
              },
            },
            required: ["op"],
          },
        },
        rationale: {
          type: "string",
          description: "One line on what this batch accomplishes.",
        },
      },
      required: ["ops"],
    },
  },
  {
    name: "check_budget",
    description:
      "Read the current segment table and budget without changing anything. Instant. Use it to orient at the start of a turn and to sanity-check before finishing.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "ask_user",
    description:
      "Ask the producer a clarifying question when a genuine editorial decision is theirs — competing readings of the brief, a tradeoff you cannot settle, missing context you cannot get from the video. Do NOT use this for anything you could determine by looking. Asking suspends your run until they reply.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string" },
        suggestions: {
          type: "array",
          items: { type: "string" },
          description:
            "2-4 short suggested answers, rendered as one-click chips. Optional.",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "finish_turn",
    description:
      "End your turn. Call this when the cut satisfies the brief and the budget, when you have answered the producer's question, or when something has genuinely blocked you. Summarize what you did and flag anything you are unsure about.",
    input_schema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Two or three sentences for the producer.",
        },
        concerns: {
          type: "array",
          items: { type: "string" },
          description:
            "Anything you were unsure about, or a deliberate violation and why.",
        },
      },
      required: ["summary"],
    },
  },
];

/** Human-readable activity labels. Written for producers, not developers. */
export function toolLabel(name: ToolName, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "search_video":
      return `Searching for "${truncate(String(i.query ?? ""), 60)}"`;
    case "read_transcript":
      return `Reading dialogue ${range(i.start, i.end)}`;
    case "watch_clip":
      return `Watching ${range(i.start, i.end)}`;
    case "view_frames": {
      const count = Array.isArray(i.timestamps) ? i.timestamps.length : 0;
      return `Looking at ${count} frame${count === 1 ? "" : "s"}`;
    }
    case "edit_segments":
      return describeOps(i.ops);
    case "check_budget":
      return "Checking the budget";
    case "ask_user":
      return "Asking you a question";
    case "finish_turn":
      return "Wrapping up";
    default:
      return name;
  }
}

function describeOps(ops: unknown): string {
  if (!Array.isArray(ops) || ops.length === 0) return "Editing segments";
  const counts = { add: 0, remove: 0, update: 0 } as Record<string, number>;
  for (const op of ops) {
    const kind = (op as { op?: string })?.op;
    if (kind && kind in counts) counts[kind] += 1;
  }
  const parts: string[] = [];
  if (counts.add) parts.push(`Added ${counts.add}`);
  if (counts.update) parts.push(`Adjusted ${counts.update}`);
  if (counts.remove) parts.push(`Removed ${counts.remove}`);
  if (parts.length === 0) return "Editing segments";
  return `${parts.join(", ")} segment${
    counts.add + counts.update + counts.remove === 1 ? "" : "s"
  }`;
}

function range(start: unknown, end: unknown): string {
  if (typeof start !== "number" || typeof end !== "number") return "";
  return `${fmtTimecode(start)}–${fmtTimecode(end)}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
