/**
 * Context assembly (12-factor #4).
 *
 * The context is *assembled* from curated parts on every iteration, never
 * appended to blindly. The live-state block is regenerated fresh each time and
 * is authoritative, which is exactly what lets history be compacted hard
 * without ever losing track of the actual cut.
 */

import {
  CONTEXT_SOFT_TOKEN_CAP,
  MAX_ITERATIONS,
  TURN_WINDOW,
} from "./config";
import { callClaude, type ClaudeMessage, type SystemBlock } from "./claude";
import { fmt, renderLedger, renderSegmentTable } from "./ledger";
import { getPrompt, renderTemplate, SPORTS_HIGHLIGHTS } from "./prompts";
import type {
  Brief,
  CostMeter,
  Ledger,
  PromptOverrides,
  StoredTurn,
  ToolLedgerEntry,
  VideoFacts,
} from "./types";

export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.ceil(text.length / 3.5);
}

/**
 * One breakpoint, on the last block rather than each one.
 *
 * A cache breakpoint caches the whole prefix up to it, so marking the system
 * prompt separately buys nothing and costs one of the four breakpoints the API
 * allows — the other three are worth far more on the message history, which is
 * where the tokens actually are. Marking only the tail also keeps the cached
 * prefix above the model's minimum cacheable length, which the system prompt
 * alone sits very close to.
 */
export function buildSystemBlocks(params: {
  facts: VideoFacts;
  brief?: Brief;
  overrides?: PromptOverrides;
}): SystemBlock[] {
  const { text: systemPrompt } = getPrompt("system", params.overrides);
  const blocks: SystemBlock[] = [
    { type: "text", text: systemPrompt },
    {
      type: "text",
      text: renderVideoFactsBlock(params.facts, params.brief),
      cache_control: { type: "ephemeral" },
    },
  ];
  if (params.brief?.isSports) {
    blocks.push({ type: "text", text: SPORTS_HIGHLIGHTS });
  }
  return blocks;
}

function renderVideoFactsBlock(facts: VideoFacts, brief?: Brief): string {
  const lines: string[] = [
    "## The source video",
    `Title: ${facts.title}`,
    `Duration: ${fmt(facts.duration)} (${facts.duration.toFixed(1)} seconds). All timestamps you give or receive are seconds on this timeline.`,
  ];

  if (facts.isChunked && facts.chunks.length > 1) {
    lines.push(
      `Indexed as ${facts.chunks.length} overlapping chunks. This is handled for you — always work in source-timeline seconds.`,
    );
  }
  if (!facts.transcriptS3Uri) {
    lines.push(
      "No transcript is available for this source, so read_transcript will not work. Rely on search_video, watch_clip and view_frames.",
    );
  }

  lines.push(
    "",
    "## The producer's panel selections",
    "These are defaults. Anything the producer says in conversation overrides them.",
  );

  if (brief) {
    lines.push(`- Format: ${brief.format ?? "unspecified"}`);
    if (brief.assetType) lines.push(`- Source type: ${brief.assetType}`);
    if (brief.platform) lines.push(`- Distribution: ${brief.platform}`);
    lines.push(
      `- Total runtime target: ${describeTarget(brief, facts.duration)}`,
    );
    lines.push(
      `- Per-segment bounds: ${describeBounds(brief)}`,
    );
    if (brief.userPrompt?.trim()) {
      lines.push(`- Producer instructions: ${brief.userPrompt.trim()}`);
    }
  } else {
    lines.push("- (none recorded)");
  }

  return lines.join("\n");
}

export function describeTarget(brief: Brief, videoDuration: number): string {
  if (brief.targetSeconds != null && brief.targetSeconds > 0) {
    return `${fmt(brief.targetSeconds)}`;
  }
  if (brief.targetPercent != null && brief.targetPercent > 0) {
    const seconds = (videoDuration * brief.targetPercent) / 100;
    return `${brief.targetPercent}% of the source ≈ ${fmt(seconds)}`;
  }
  if (brief.format === "episode_recap") {
    return "not set — recaps default to about 90s (band 60s–120s)";
  }
  return "not set — your editorial call, but say what you are aiming for";
}

export function describeBounds(brief: Brief): string {
  const parts: string[] = [];
  if (brief.minSegmentDuration) parts.push(`min ${fmt(brief.minSegmentDuration)}`);
  if (brief.maxSegmentDuration) parts.push(`max ${fmt(brief.maxSegmentDuration)}`);
  return parts.length > 0 ? parts.join(", ") : "none set";
}

export function renderLiveState(params: {
  segments: Parameters<typeof renderSegmentTable>[0];
  ledger: Ledger;
  cost: CostMeter;
  iterations: number;
}): string {
  const remaining = MAX_ITERATIONS - params.iterations;
  const lines = [
    "<live_state>",
    "This block is regenerated fresh every turn and is the authoritative state of the cut. Trust it over anything earlier in this conversation.",
    "",
    "CURRENT CUT",
    renderSegmentTable(params.segments),
    "",
    "BUDGET",
    renderLedger(params.ledger),
    "",
    "THIS RUN SO FAR",
    renderCost(params.cost),
    `Tool steps used: ${params.iterations} of ${MAX_ITERATIONS}.`,
  ];

  if (remaining <= 10) {
    lines.push(
      `Only ${remaining} tool steps remain in this run. Get the cut into a state you can stand behind and call finish_turn.`,
    );
  }

  lines.push("</live_state>");
  return lines.join("\n");
}

function renderCost(cost: CostMeter): string {
  return [
    `${cost.toolCalls} tool calls (${cost.toolErrors} failed)`,
    `${cost.searches} searches`,
    `${cost.pegasusCalls} clips watched, ${fmt(cost.pegasusSeconds)} of footage analyzed${
      cost.pegasusCacheHits > 0 ? ` (${cost.pegasusCacheHits} reused from cache)` : ""
    }`,
    `${cost.frames} frames viewed`,
    `${cost.transcriptReads} transcript reads`,
  ].join(" · ");
}

export function renderToolLedger(entries: ToolLedgerEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map((e) => `- ${e.ok ? "" : "FAILED: "}${e.line}`);
  return `<earlier_tool_calls>\nWhat you have already done this session, in order:\n${lines.join(
    "\n",
  )}\n</earlier_tool_calls>`;
}

/**
 * Assemble the full request. The live-state block is appended to the final user
 * message so it is the last thing the model reads before deciding what to do.
 */
export function assembleMessages(params: {
  turns: StoredTurn[];
  summary?: string;
  toolLedger: ToolLedgerEntry[];
  liveState: string;
}): ClaudeMessage[] {
  const messages: ClaudeMessage[] = [];

  const preamble: string[] = [];
  if (params.summary?.trim()) {
    preamble.push(`<session_summary>\n${params.summary.trim()}\n</session_summary>`);
  }
  const ledgerBlock = renderToolLedger(params.toolLedger);
  if (ledgerBlock) preamble.push(ledgerBlock);

  // Repair here rather than at every call site: rehydration, compaction and
  // the stored-history trim can all hand us a head that Claude would reject.
  const turns = repairHistoryHead(params.turns).map((t) => ({
    role: t.role,
    content: t.content as ClaudeMessage["content"],
  }));

  // A conversation must open with a user message. Compaction and history
  // trimming can both leave an assistant turn in front; folding the recap into
  // a leading user turn fixes it, and a synthetic one covers the rest.
  const recap = preamble.length > 0 ? preamble.join("\n\n") : "";
  if (turns.length > 0 && turns[0].role === "user") {
    if (recap) {
      turns[0] = {
        role: "user",
        content: [{ type: "text", text: recap }, ...turns[0].content],
      };
    }
  } else {
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text:
            recap ||
            "Picking up an editing session already in progress. What follows is the recent history.",
        },
      ],
    });
  }

  messages.push(...turns);

  // Cache the history before the live-state block is appended. Everything up to
  // here is byte-identical to the previous iteration, and it is where all the
  // weight is: a long run re-sends tens of thousands of tokens of tool results
  // on every single step. The live-state block changes each turn by design, so
  // it deliberately sits outside the cached prefix.
  markCacheBreakpoints(messages);

  const last = messages[messages.length - 1];
  if (last && last.role === "user") {
    last.content = [...last.content, { type: "text", text: params.liveState }];
  } else {
    messages.push({
      role: "user",
      content: [{ type: "text", text: params.liveState }],
    });
  }

  return messages;
}

/**
 * Two rolling breakpoints: one at the end of the history, one a couple of turns
 * back. The trailing one is the write for this iteration; the older one is
 * still a valid prefix of the next request, so a hit survives the turn in which
 * the history grows past the newest breakpoint.
 */
function markCacheBreakpoints(messages: ClaudeMessage[]): void {
  const positions: number[] = [];
  if (messages.length >= 1) positions.push(messages.length - 1);
  if (messages.length >= 3) positions.push(messages.length - 3);

  for (const index of positions) {
    const message = messages[index];
    const blocks = message.content;
    if (!Array.isArray(blocks) || blocks.length === 0) continue;

    const tail = blocks[blocks.length - 1];
    if (typeof tail !== "object" || tail === null) continue;

    // Clone: these blocks are shared with the turns that get persisted, and
    // cache_control must not be written to DynamoDB and replayed next run.
    message.content = [
      ...blocks.slice(0, -1),
      { ...(tail as Record<string, unknown>), cache_control: { type: "ephemeral" } },
    ];
  }
}

export interface CompactionResult {
  turns: StoredTurn[];
  summary?: string;
  compacted: boolean;
  note?: string;
}

/**
 * Fold older turns into a rolling summary once the window overflows. Falls back
 * to a deterministic digest if the summarizing model call fails — compaction
 * must never be the thing that kills a run.
 */
export async function compactHistory(params: {
  turns: StoredTurn[];
  summary?: string;
  overrides?: PromptOverrides;
}): Promise<CompactionResult> {
  const { turns, summary } = params;

  const overWindow = turns.length > TURN_WINDOW * 2;
  const overTokens = estimateTokens(turns) > CONTEXT_SOFT_TOKEN_CAP;
  if (!overWindow && !overTokens) {
    return { turns, summary, compacted: false };
  }

  const splitAt = Math.max(0, turns.length - TURN_WINDOW);
  if (splitAt <= 0) return { turns, summary, compacted: false };

  const kept = repairHistoryHead(turns.slice(splitAt));
  if (kept.length === 0) return { turns, summary, compacted: false };
  // Anything the repair dropped still belongs in the summary.
  const older = turns.slice(0, turns.length - kept.length);
  const transcript = renderTurnsForSummary(older);

  const { text: template } = getPrompt("compaction", params.overrides);
  const prompt = renderTemplate(template, { history: transcript });

  try {
    const response = await callClaude({
      system: [
        {
          type: "text",
          text: "You compact an editing session's history. Output only the summary.",
        },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      tools: [],
      maxTokens: 1024,
      temperature: 0.2,
    });
    const text = response.blocks
      .filter((b) => (b as { type?: string }).type === "text")
      .map((b) => String((b as { text?: string }).text ?? ""))
      .join("\n")
      .trim();

    if (text.length > 0) {
      return {
        turns: kept,
        summary: mergeSummary(summary, text),
        compacted: true,
        note: `Compacted ${older.length} earlier turns into the session summary.`,
      };
    }
  } catch (err) {
    console.warn("[IQAgent] model compaction failed, using local digest:", err);
  }

  return {
    turns: kept,
    summary: mergeSummary(summary, transcript.slice(0, 4000)),
    compacted: true,
    note: `Compacted ${older.length} earlier turns locally (the summarizer was unavailable).`,
  };
}

function mergeSummary(previous: string | undefined, next: string): string {
  if (!previous?.trim()) return next;
  return `${previous.trim()}\n\n${next}`.slice(-8000);
}

/**
 * Make a truncated history legal to send. Claude requires the first message to
 * be from the user, and rejects a `tool_result` whose `tool_use` is no longer
 * in the conversation — both of which a cut at an arbitrary point produces.
 * Rather than refuse to compact (which lets the window grow until the request
 * itself is rejected), the orphaned pieces are rewritten as plain text.
 */
export function repairHistoryHead(turns: StoredTurn[]): StoredTurn[] {
  let head = 0;
  while (head < turns.length && turns[head].role === "assistant") head += 1;
  if (head >= turns.length) return [];

  const kept = turns.slice(head);
  if (containsToolResult(kept[0])) {
    kept[0] = { role: "user", content: flattenTurnContent(kept[0]) };
  }
  return kept;
}

function containsToolResult(turn: StoredTurn): boolean {
  if (turn.role !== "user" || !Array.isArray(turn.content)) return false;
  return turn.content.some(
    (block) => (block as { type?: string })?.type === "tool_result",
  );
}

function flattenTurnContent(turn: StoredTurn): unknown[] {
  const texts: string[] = [];
  const passthrough: unknown[] = [];
  for (const raw of turn.content ?? []) {
    const block = raw as Record<string, unknown>;
    if (block.type === "tool_result") {
      texts.push(flattenToolResult(block));
    } else if (block.type === "text") {
      texts.push(String(block.text ?? ""));
    } else {
      passthrough.push(block);
    }
  }
  const joined = texts.filter(Boolean).join("\n\n");
  return [
    {
      type: "text",
      text: `Results from tool calls made earlier in this session:\n\n${joined}`,
    },
    ...passthrough,
  ];
}

function renderTurnsForSummary(turns: StoredTurn[]): string {
  const lines: string[] = [];
  for (const turn of turns) {
    for (const raw of turn.content ?? []) {
      const block = raw as Record<string, unknown>;
      if (block.type === "text") {
        lines.push(`${turn.role}: ${String(block.text ?? "").slice(0, 1200)}`);
      } else if (block.type === "tool_use") {
        lines.push(
          `assistant used ${String(block.name)} with ${JSON.stringify(block.input).slice(0, 300)}`,
        );
      } else if (block.type === "tool_result") {
        lines.push(`result: ${flattenToolResult(block).slice(0, 800)}`);
      }
    }
  }
  return lines.join("\n");
}

function flattenToolResult(block: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const item = c as Record<string, unknown>;
        return item.type === "text" ? String(item.text ?? "") : `[${String(item.type)}]`;
      })
      .join(" ");
  }
  return "";
}
