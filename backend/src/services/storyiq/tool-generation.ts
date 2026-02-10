/**
 * Tool-Based Segment Generation
 *
 * Uses Anthropic tool-use to generate segments with inline validation.
 * Claude calls add_segment/remove_segment/update_segment/finish_segments
 * tools that validate constraints and return actual transcript content.
 *
 * Pipeline:
 * 1. Tool Conversation: Claude creates segments with inline feedback
 * 2. Quality Review: Separate reviewer checks titles vs content
 * 3. Deterministic Fallback: Enforcer guarantees hard constraints
 */

import {
  Purpose,
  getPurposeConstraints,
  parseJSONFromLLM,
  type ProposedSegment,
  type TranscriptSegment,
  type VideoMetadata,
  type FinalSegments,
} from "./types";
import { type SceneBreak } from "../twelvelabs";
import {
  callClaudeWithTools,
  callClaude,
  type ClaudeTool,
  type ToolUseBlock,
  type ToolResultBlock,
  type ToolMessage,
} from "./claude-client";
import { getToolBasedPrompt } from "./prompts";
import { enforceConstraints } from "./verify";

// ============================================================================
// Constants
// ============================================================================

/** Max tool conversation rounds — enforcer handles remaining gaps/issues */
const MAX_TOOL_ROUNDS = 4;
/** Max fix rounds after quality review — 1 is usually enough */
const MAX_FIX_ROUNDS = 1;
const MAX_SEGMENT_DURATION = 180;
const MIN_SEGMENT_DURATION = 60;
const CONTENT_PREVIEW_CHARS = 800;

// ============================================================================
// Tool Definitions
// ============================================================================

const SEGMENT_TOOLS: ClaudeTool[] = [
  {
    name: "add_segment",
    description:
      "Create a video segment. Validates duration (60-180s), overlap, and bounds. " +
      "Returns actual transcript content at those timestamps so you can verify your title matches what is really said. " +
      "Reports remaining budget.",
    input_schema: {
      type: "object",
      properties: {
        startTime: {
          type: "number",
          description:
            "Start time in seconds. Use precise timestamps from the transcript (e.g., 305.28).",
        },
        endTime: {
          type: "number",
          description:
            "End time in seconds. Use precise timestamps (e.g., 478.53).",
        },
        title: {
          type: "string",
          description:
            "Compelling title based on what is SAID in the transcript at these timestamps.",
        },
        reasoning: {
          type: "string",
          description: "Why this segment works for the video's purpose.",
        },
        expectedContent: {
          type: "string",
          description: "Brief description of what happens in this segment.",
        },
      },
      required: [
        "startTime",
        "endTime",
        "title",
        "reasoning",
        "expectedContent",
      ],
    },
  },
  {
    name: "remove_segment",
    description:
      "Remove a previously accepted segment by its ID number. " +
      "Use when over budget or when content review shows a bad segment.",
    input_schema: {
      type: "object",
      properties: {
        segmentId: {
          type: "number",
          description:
            "The segment ID number (shown in add_segment response, e.g., 5 for #5).",
        },
      },
      required: ["segmentId"],
    },
  },
  {
    name: "update_segment",
    description:
      "Update the title, reasoning, or expectedContent of an accepted segment " +
      "WITHOUT changing its time boundaries. Use to fix titles after reviewing " +
      "the returned transcript content.",
    input_schema: {
      type: "object",
      properties: {
        segmentId: {
          type: "number",
          description: "The segment ID number to update.",
        },
        title: {
          type: "string",
          description: "New title (optional — omit to keep current).",
        },
        reasoning: {
          type: "string",
          description: "New reasoning (optional).",
        },
        expectedContent: {
          type: "string",
          description: "New expected content description (optional).",
        },
      },
      required: ["segmentId"],
    },
  },
  {
    name: "finish_segments",
    description:
      "Call when all segments are created. Validates total duration against target " +
      "(for compact/highlights) or checks for coverage gaps (for full_video). " +
      "Returns success or tells you exactly what to fix.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

// ============================================================================
// Accepted Segment (with stored content)
// ============================================================================

interface AcceptedSegment {
  id: number;
  segment: ProposedSegment;
  content: string; // actual transcript content at these timestamps
}

// ============================================================================
// SegmentBuilder — State Machine
// ============================================================================

interface SegmentBuilderConfig {
  videoDuration: number;
  targetDuration?: number;
  purpose: Purpose;
  transcript: TranscriptSegment[];
}

class SegmentBuilder {
  private segments: Map<number, AcceptedSegment> = new Map();
  private nextId: number = 1;
  private videoDuration: number;
  private targetDuration?: number;
  private purpose: Purpose;
  private transcript: TranscriptSegment[];
  private needsTotalDuration: boolean;
  private finished: boolean = false;

  constructor(config: SegmentBuilderConfig) {
    this.videoDuration = config.videoDuration;
    this.targetDuration = config.targetDuration;
    this.purpose = config.purpose;
    this.transcript = config.transcript;

    const { needsTotalDuration } = getPurposeConstraints(config.purpose);
    this.needsTotalDuration = needsTotalDuration;
  }

  // ── add_segment ──────────────────────────────────────────────────────

  tryAdd(input: {
    startTime: number;
    endTime: number;
    title: string;
    reasoning: string;
    expectedContent: string;
  }): { success: boolean; message: string; id?: number } {
    if (this.finished) {
      return {
        success: false,
        message:
          "REJECTED. Segments are finalized. Call finish_segments was already successful.",
      };
    }

    let { startTime, endTime } = input;
    const adjustments: string[] = [];

    // 1. Validate bounds
    if (startTime < 0) {
      startTime = 0;
      adjustments.push("startTime clamped to 0");
    }
    if (endTime > this.videoDuration) {
      endTime = this.videoDuration;
      adjustments.push(
        `endTime clamped to ${this.videoDuration.toFixed(1)}s (video end)`,
      );
    }
    if (startTime >= endTime) {
      return {
        success: false,
        message: `REJECTED. startTime (${startTime.toFixed(1)}) must be before endTime (${endTime.toFixed(1)}).`,
      };
    }

    // 2. Validate duration
    const duration = endTime - startTime;
    if (duration < MIN_SEGMENT_DURATION) {
      return {
        success: false,
        message: `REJECTED. Duration ${Math.round(duration)}s is under ${MIN_SEGMENT_DURATION}s minimum. Extend the segment or merge with a neighbor.`,
      };
    }
    if (duration > MAX_SEGMENT_DURATION) {
      return {
        success: false,
        message: `REJECTED. Duration ${Math.round(duration)}s exceeds ${MAX_SEGMENT_DURATION}s maximum. Split this into two segments at a natural break point in the transcript.`,
      };
    }

    // 3. Check overlaps with existing segments
    for (const [id, existing] of this.segments) {
      const es = existing.segment;
      if (startTime < es.endTime && endTime > es.startTime) {
        return {
          success: false,
          message:
            `REJECTED. Overlaps with segment #${id} "${es.title}" [${es.startTime.toFixed(1)}-${es.endTime.toFixed(1)}s]. ` +
            `Your segment must start at or after ${es.endTime.toFixed(1)}s, or end at or before ${es.startTime.toFixed(1)}s.`,
        };
      }
    }

    // 4. Accept segment
    const segment: ProposedSegment = {
      startTime,
      endTime,
      title: input.title,
      reasoning: input.reasoning,
      expectedContent: input.expectedContent,
    };
    const content = this.getTranscriptContent(startTime, endTime);
    const id = this.nextId++;
    this.segments.set(id, { id, segment, content });

    // 5. Build success message
    const total = this.getTotalDuration();
    const budgetInfo = this.getBudgetInfo(total);
    const adjustNote =
      adjustments.length > 0 ? `\nAdjusted: ${adjustments.join("; ")}` : "";
    const contentPreview =
      content.length > 0
        ? `\nContent: "${content.substring(0, CONTENT_PREVIEW_CHARS)}${content.length > CONTENT_PREVIEW_CHARS ? "..." : ""}"`
        : "\nContent: (no dialogue in this range — visual/music only)";

    return {
      success: true,
      id,
      message:
        `ACCEPTED #${id}. "${input.title}" [${startTime.toFixed(1)}-${endTime.toFixed(1)}s] ${Math.round(duration)}s.` +
        `${adjustNote}\n${budgetInfo}${contentPreview}`,
    };
  }

  // ── remove_segment ───────────────────────────────────────────────────

  tryRemove(segmentId: number): { success: boolean; message: string } {
    if (this.finished) {
      return {
        success: false,
        message:
          "REJECTED. Segments are finalized. Call finish_segments was already successful.",
      };
    }

    const existing = this.segments.get(segmentId);
    if (!existing) {
      const validIds = Array.from(this.segments.keys()).sort((a, b) => a - b);
      return {
        success: false,
        message: `REJECTED. No segment with ID #${segmentId}. Valid IDs: ${validIds.join(", ") || "(none)"}`,
      };
    }

    const duration = existing.segment.endTime - existing.segment.startTime;
    this.segments.delete(segmentId);

    const total = this.getTotalDuration();
    const budgetInfo = this.getBudgetInfo(total);

    return {
      success: true,
      message: `REMOVED #${segmentId} "${existing.segment.title}" (freed ${Math.round(duration)}s).\n${budgetInfo}`,
    };
  }

  // ── update_segment ───────────────────────────────────────────────────

  tryUpdate(
    segmentId: number,
    fields: { title?: string; reasoning?: string; expectedContent?: string },
  ): { success: boolean; message: string } {
    if (this.finished) {
      return {
        success: false,
        message:
          "REJECTED. Segments are finalized. Call finish_segments was already successful.",
      };
    }

    const existing = this.segments.get(segmentId);
    if (!existing) {
      const validIds = Array.from(this.segments.keys()).sort((a, b) => a - b);
      return {
        success: false,
        message: `REJECTED. No segment with ID #${segmentId}. Valid IDs: ${validIds.join(", ") || "(none)"}`,
      };
    }

    if (fields.title) existing.segment.title = fields.title;
    if (fields.reasoning) existing.segment.reasoning = fields.reasoning;
    if (fields.expectedContent)
      existing.segment.expectedContent = fields.expectedContent;

    return {
      success: true,
      message: `UPDATED #${segmentId}. Title: "${existing.segment.title}" [${existing.segment.startTime.toFixed(1)}-${existing.segment.endTime.toFixed(1)}s]`,
    };
  }

  // ── finish_segments ──────────────────────────────────────────────────

  tryFinish(): { success: boolean; message: string } {
    const segments = this.getSortedSegments();
    const total = this.getTotalDuration();

    // For full_video: check gaps
    if (this.purpose === Purpose.FULL_VIDEO) {
      const issues: string[] = [];

      if (segments.length === 0) {
        return {
          success: false,
          message:
            "No segments created. Add segments covering the entire video.",
        };
      }

      // Check first segment starts near 0
      if (segments[0].segment.startTime > 5) {
        issues.push(
          `First segment starts at ${segments[0].segment.startTime.toFixed(1)}s — should start at or near 0s.`,
        );
      }

      // Check last segment ends near video duration
      const last = segments[segments.length - 1];
      if (last.segment.endTime < this.videoDuration - 5) {
        issues.push(
          `Last segment ends at ${last.segment.endTime.toFixed(1)}s — should end at or near ${this.videoDuration.toFixed(1)}s.`,
        );
      }

      // Check for gaps > 5s between segments
      for (let i = 1; i < segments.length; i++) {
        const gap =
          segments[i].segment.startTime - segments[i - 1].segment.endTime;
        if (gap > 5) {
          issues.push(
            `Gap of ${Math.round(gap)}s between #${segments[i - 1].id} (ends ${segments[i - 1].segment.endTime.toFixed(1)}s) and #${segments[i].id} (starts ${segments[i].segment.startTime.toFixed(1)}s).`,
          );
        }
      }

      if (issues.length > 0) {
        return {
          success: false,
          message: `GAPS FOUND. Full video must cover all content.\n${issues.join("\n")}\nAdd segments to fill these gaps.`,
        };
      }

      this.finished = true;
      return {
        success: true,
        message: `COMPLETE. ${segments.length} segments covering ${Math.round(total)}s of ${Math.round(this.videoDuration)}s video.`,
      };
    }

    // For budgeted purposes: check total duration
    if (
      this.needsTotalDuration &&
      this.targetDuration &&
      this.targetDuration > 0
    ) {
      const tolerance = 0.15;
      const minAllowed = this.targetDuration * (1 - tolerance);
      const maxAllowed = this.targetDuration * (1 + tolerance);
      const pctOff =
        ((total - this.targetDuration) / this.targetDuration) * 100;

      if (total > maxAllowed) {
        const excess = Math.round(total - this.targetDuration);
        const segmentsToRemove = Math.max(1, Math.round(excess / 90));

        const segList = segments
          .map(
            (s) =>
              `  #${s.id}: "${s.segment.title}" [${s.segment.startTime.toFixed(1)}-${s.segment.endTime.toFixed(1)}s] ${Math.round(s.segment.endTime - s.segment.startTime)}s`,
          )
          .join("\n");

        return {
          success: false,
          message:
            `OVER BUDGET. Total: ${Math.round(total)}s, target: ${Math.round(this.targetDuration)}s (${Math.round(pctOff)}% over, max ±15%).\n` +
            `Remove ~${segmentsToRemove} segment(s) (~${excess}s excess). Choose the least narratively important.\n` +
            `Current segments:\n${segList}`,
        };
      }

      if (total < minAllowed) {
        const deficit = Math.round(this.targetDuration - total);
        const segmentsToAdd = Math.max(1, Math.round(deficit / 90));
        return {
          success: false,
          message:
            `UNDER BUDGET. Total: ${Math.round(total)}s, target: ${Math.round(this.targetDuration)}s (${Math.round(Math.abs(pctOff))}% under, max ±15%).\n` +
            `Add ~${segmentsToAdd} more segment(s) (~${deficit}s needed). Find high-value content in the transcript.`,
        };
      }

      this.finished = true;
      return {
        success: true,
        message: `COMPLETE. ${segments.length} segments, total ${Math.round(total)}s (target: ${Math.round(this.targetDuration)}s, ${pctOff > 0 ? "+" : ""}${Math.round(pctOff)}%).`,
      };
    }

    // For other purposes (no strict total check)
    this.finished = true;
    return {
      success: true,
      message: `COMPLETE. ${segments.length} segments, total ${Math.round(total)}s.`,
    };
  }

  // ── Public accessors ─────────────────────────────────────────────────

  isFinished(): boolean {
    return this.finished;
  }

  /** Allow re-opening after quality review finds issues */
  resetFinished(): void {
    this.finished = false;
  }

  getSegments(): ProposedSegment[] {
    return this.getSortedSegments().map((s) => s.segment);
  }

  getSegmentsWithContent(): AcceptedSegment[] {
    return this.getSortedSegments();
  }

  getSegmentCount(): number {
    return this.segments.size;
  }

  /**
   * Check if current total duration is under the target (by more than 15% tolerance).
   * Used to decide if we should nudge Claude to continue when it stops early.
   */
  isUnderBudget(): boolean {
    if (!this.needsTotalDuration || !this.targetDuration) return false;
    const total = this.getTotalDuration();
    return total < this.targetDuration * 0.85;
  }

  /** Get a summary of current budget status for nudge messages */
  getBudgetSummary(): string {
    const total = this.getTotalDuration();
    if (!this.needsTotalDuration || !this.targetDuration) {
      return `${this.segments.size} segment(s), ${Math.round(total)}s total`;
    }
    const remaining = this.targetDuration - total;
    const pct = Math.round((total / this.targetDuration) * 100);
    return `${this.segments.size} segment(s), ${Math.round(total)}s of ${Math.round(this.targetDuration)}s target (${pct}%), ${Math.round(remaining)}s remaining`;
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private getSortedSegments(): AcceptedSegment[] {
    return Array.from(this.segments.values()).sort(
      (a, b) => a.segment.startTime - b.segment.startTime,
    );
  }

  private getTotalDuration(): number {
    let total = 0;
    for (const s of this.segments.values()) {
      total += s.segment.endTime - s.segment.startTime;
    }
    return total;
  }

  private getBudgetInfo(total: number): string {
    if (!this.needsTotalDuration || !this.targetDuration) {
      return `Total so far: ${Math.round(total)}s across ${this.segments.size} segment(s).`;
    }

    const remaining = this.targetDuration - total;

    if (remaining > 0) {
      const estimatedRemaining = Math.round(remaining / 90);
      const budgetHint =
        remaining < 60
          ? `${Math.round(remaining)}s remaining (not enough for another full segment — consider extending existing segments or wrapping up)`
          : `${Math.round(remaining)}s remaining of ${Math.round(this.targetDuration)}s target (~${estimatedRemaining} more segment(s))`;
      return `Budget: ${budgetHint}.`;
    } else {
      return `Budget: ${Math.round(Math.abs(remaining))}s OVER ${Math.round(this.targetDuration)}s target. Consider removing a segment before finishing.`;
    }
  }

  /**
   * Extract transcript text for a time range.
   * Used to return actual content in add_segment responses.
   * Includes words that overlap the range (start before end AND end after start).
   */
  private getTranscriptContent(start: number, end: number): string {
    const words = this.transcript
      .filter((t) => t.endTime > start && t.startTime < end)
      .map((t) => t.text.trim())
      .filter(Boolean);
    return words.join(" ");
  }
}

// ============================================================================
// Tool Call Handler
// ============================================================================

/**
 * Safely coerce an LLM-provided value to a number.
 * LLMs can return "305.28" (string) instead of 305.28 (number), or null/undefined.
 * Also handles MM.SS.F format (e.g., "80.49.0") that models sometimes output
 * when they see MM:SS timestamps in the prompt.
 * Returns NaN if the value cannot be meaningfully converted.
 */
function safeNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    // First try direct parse
    const direct = Number(value);
    if (!isNaN(direct)) return direct;

    // Check for MM.SS.F format (e.g., "80.49.0" = 80 min, 49.0 sec)
    const parts = value.split(".");
    if (parts.length === 3) {
      const mins = Number(parts[0]);
      const secs = Number(parts[1] + "." + parts[2]);
      if (!isNaN(mins) && !isNaN(secs)) {
        return mins * 60 + secs;
      }
    }
    return NaN;
  }
  return NaN;
}

/** Safely coerce an LLM-provided value to a string. */
function safeString(value: unknown, fallback: string = ""): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function handleToolCall(
  builder: SegmentBuilder,
  toolUse: ToolUseBlock,
): ToolResultBlock {
  const input = toolUse.input;
  let result: { success: boolean; message: string };

  switch (toolUse.name) {
    case "add_segment": {
      const startTime = safeNumber(input.startTime);
      const endTime = safeNumber(input.endTime);
      if (isNaN(startTime) || isNaN(endTime)) {
        result = {
          success: false,
          message: `REJECTED. Invalid timestamps: startTime=${JSON.stringify(input.startTime)}, endTime=${JSON.stringify(input.endTime)}. Both must be numbers.`,
        };
        break;
      }
      result = builder.tryAdd({
        startTime,
        endTime,
        title: safeString(input.title, "Untitled"),
        reasoning: safeString(input.reasoning),
        expectedContent: safeString(input.expectedContent),
      });
      break;
    }

    case "remove_segment": {
      const segmentId = safeNumber(input.segmentId);
      if (isNaN(segmentId) || !Number.isInteger(segmentId)) {
        result = {
          success: false,
          message: `REJECTED. Invalid segmentId: ${JSON.stringify(input.segmentId)}. Must be an integer.`,
        };
        break;
      }
      result = builder.tryRemove(segmentId);
      break;
    }

    case "update_segment": {
      const segmentId = safeNumber(input.segmentId);
      if (isNaN(segmentId) || !Number.isInteger(segmentId)) {
        result = {
          success: false,
          message: `REJECTED. Invalid segmentId: ${JSON.stringify(input.segmentId)}. Must be an integer.`,
        };
        break;
      }
      result = builder.tryUpdate(segmentId, {
        title: input.title !== undefined ? safeString(input.title) : undefined,
        reasoning:
          input.reasoning !== undefined
            ? safeString(input.reasoning)
            : undefined,
        expectedContent:
          input.expectedContent !== undefined
            ? safeString(input.expectedContent)
            : undefined,
      });
      break;
    }

    case "finish_segments":
      result = builder.tryFinish();
      break;

    default:
      result = { success: false, message: `Unknown tool: ${toolUse.name}` };
  }

  console.log(
    `[StoryIQ Tools] ${toolUse.name}: ${result.success ? "OK" : "FAIL"} — ${result.message.substring(0, 120)}`,
  );

  return {
    type: "tool_result",
    tool_use_id: toolUse.id,
    content: result.message,
    is_error: !result.success,
  };
}

// ============================================================================
// Main Orchestration
// ============================================================================

export interface GenerateWithToolsOptions {
  metadata: VideoMetadata;
  transcript: TranscriptSegment[];
  sceneBreaks: SceneBreak[] | null;
  purpose: Purpose;
  targetDuration?: number;
  targetPercent?: number;
  userInstructions?: string;
}

/**
 * Generate segments using Anthropic tool-use.
 *
 * Phase 1: Tool conversation — Claude calls add/remove/update/finish tools
 * Phase 2: Quality review — separate reviewer checks titles vs content
 * Phase 3: Deterministic fallback — enforcer guarantees hard constraints
 */
export async function generateSegmentsWithTools(
  options: GenerateWithToolsOptions,
): Promise<FinalSegments> {
  const { metadata, transcript, sceneBreaks, purpose, targetDuration } =
    options;
  const startTime = Date.now();

  console.log(
    `[StoryIQ Tools] Starting tool-based generation for ${metadata.assetId}`,
  );
  console.log(
    `[StoryIQ Tools] Purpose: ${purpose}, Target: ${targetDuration || "auto"}s, Video: ${metadata.duration}s`,
  );

  // Create the segment builder
  const builder = new SegmentBuilder({
    videoDuration: metadata.duration,
    targetDuration,
    purpose,
    transcript,
  });

  // Build the initial prompt
  const prompt = getToolBasedPrompt(
    purpose,
    metadata,
    transcript,
    sceneBreaks,
    targetDuration,
    options.userInstructions,
    options.targetPercent,
  );

  console.log(
    `[StoryIQ Tools] Prompt: ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens)`,
  );

  // ── Phase 1: Tool Conversation ─────────────────────────────────────

  // Use content block with cache_control to enable prompt caching.
  // The large context (scenes + transcript) is identical across all tool rounds,
  // so caching saves ~90% on input token costs after the first call.
  const messages: ToolMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: prompt,
          cache_control: { type: "ephemeral" },
        },
      ],
    },
  ];
  let totalToolCalls = 0;

  for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
    console.log(
      `[StoryIQ Tools] Round ${round}/${MAX_TOOL_ROUNDS} (${builder.getSegmentCount()} segments so far)`,
    );

    const response = await callClaudeWithTools({
      model: "haiku", // Haiku 4.5 for tool conversation (higher rate limits)
      maxTokens: 8000,
      tools: SEGMENT_TOOLS,
      messages,
    });

    // Extract tool_use blocks
    const toolUses = response.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use",
    );

    if (toolUses.length === 0) {
      console.log(
        `[StoryIQ Tools] No tool calls in round ${round}, stop_reason: ${response.stop_reason}`,
      );

      // Claude stopped without using tools — check if we should nudge it to continue
      if (!builder.isFinished() && builder.isUnderBudget()) {
        console.warn(
          `[StoryIQ Tools] Claude stopped but is under budget (${builder.getBudgetSummary()}). Nudging to continue.`,
        );

        // Add Claude's text response to history, then inject a nudge
        if (response.content.length > 0) {
          messages.push({ role: "assistant", content: response.content });
        }

        const nudgeMessage =
          `You have NOT met the target duration yet. Current status: ${builder.getBudgetSummary()}.\n\n` +
          `You MUST continue adding segments using add_segment until you are within 15% of the target. ` +
          `Then call finish_segments. Do not stop until the target is met.`;

        messages.push({ role: "user", content: nudgeMessage });

        // Continue to next round (don't break)
        continue;
      }

      // Not under budget, or already finished — do a final check and exit
      if (!builder.isFinished()) {
        const finishResult = builder.tryFinish();
        if (finishResult.success) {
          console.log(
            `[StoryIQ Tools] Forced finish: OK — ${finishResult.message.substring(0, 200)}`,
          );
        } else {
          console.warn(
            `[StoryIQ Tools] Forced finish: FAIL — ${finishResult.message.substring(0, 200)}`,
          );
          console.warn(
            `[StoryIQ Tools] Claude stopped early. Enforcer will attempt to fix.`,
          );
        }
      }
      break;
    }

    totalToolCalls += toolUses.length;
    console.log(`[StoryIQ Tools] Processing ${toolUses.length} tool call(s)`);

    // Process all tool calls
    const toolResults: ToolResultBlock[] = toolUses.map((tu) =>
      handleToolCall(builder, tu),
    );

    // Log results summary
    const accepted = toolResults.filter((r) => !r.is_error).length;
    const rejected = toolResults.filter((r) => r.is_error).length;
    console.log(
      `[StoryIQ Tools] Round ${round} results: ${accepted} accepted, ${rejected} rejected. Total segments: ${builder.getSegmentCount()}`,
    );

    // Add to conversation history
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });

    // Check if finished
    if (builder.isFinished()) {
      console.log(
        `[StoryIQ Tools] Phase 1 complete after ${round} round(s), ${totalToolCalls} tool calls`,
      );
      break;
    }

    if (round === MAX_TOOL_ROUNDS) {
      console.warn(
        `[StoryIQ Tools] Max rounds (${MAX_TOOL_ROUNDS}) reached without finish. Moving to fallback.`,
      );
    }
  }

  // ── Phase 2: Quality Review ────────────────────────────────────────

  console.log(
    `[StoryIQ Tools] Phase 2: Quality review (${builder.getSegmentCount()} segments)`,
  );
  const segmentsWithContent = builder.getSegmentsWithContent();
  const qualityResult = await runQualityReview(segmentsWithContent, purpose);
  const qualityIssues = qualityResult.issues;
  let qualityReviewConfidence: number | null = qualityResult.confidence;

  if (qualityIssues.length > 0) {
    console.log(
      `[StoryIQ Tools] Quality issues found: ${qualityIssues.length}`,
    );
    qualityIssues.forEach((issue) => console.log(`  - ${issue}`));

    // Inject review into tool conversation for fix rounds.
    // IMPORTANT: Anthropic API requires alternating user/assistant messages.
    // If the last message is a user message (tool_results), we must insert
    // a synthetic assistant message before our review message.
    builder.resetFinished();
    const reviewMessage =
      `Quality review found these issues with your segments:\n` +
      `${qualityIssues.map((i) => `- ${i}`).join("\n")}\n\n` +
      `Fix these issues using update_segment (for title fixes) or remove_segment + add_segment (for boundary changes). ` +
      `Then call finish_segments again.`;

    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === "user") {
      // Insert a synthetic assistant acknowledgment to maintain alternation
      messages.push({
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Understood. Let me review the quality feedback and make fixes.",
          },
        ],
      });
    }
    messages.push({ role: "user", content: reviewMessage });

    for (let fixRound = 1; fixRound <= MAX_FIX_ROUNDS; fixRound++) {
      console.log(`[StoryIQ Tools] Fix round ${fixRound}/${MAX_FIX_ROUNDS}`);

      const response = await callClaudeWithTools({
        model: "haiku", // Haiku 4.5 for fix rounds (higher rate limits)
        maxTokens: 4000,
        tools: SEGMENT_TOOLS,
        messages,
      });

      const toolUses = response.content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use",
      );

      if (toolUses.length === 0) {
        console.log(`[StoryIQ Tools] No tool calls in fix round ${fixRound}`);
        break;
      }

      totalToolCalls += toolUses.length;
      const toolResults: ToolResultBlock[] = toolUses.map((tu) =>
        handleToolCall(builder, tu),
      );

      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });

      if (builder.isFinished()) {
        console.log(
          `[StoryIQ Tools] Fix round complete. ${builder.getSegmentCount()} segments.`,
        );
        break;
      }
    }
  } else {
    console.log(`[StoryIQ Tools] Quality review passed — no issues`);
  }

  // ── Phase 3: Deterministic Fallback ────────────────────────────────

  console.log(`[StoryIQ Tools] Phase 3: Deterministic fallback`);
  let finalSegments = builder.getSegments();

  if (finalSegments.length === 0) {
    throw new Error(
      `[StoryIQ Tools] FATAL: Tool conversation produced 0 segments after ${totalToolCalls} tool calls. ` +
        `Cannot proceed with empty segmentation.`,
    );
  }

  // enforceConstraints self-guards via purpose — no need to compute
  // needsSegmentDuration/needsTotalDuration at the call site.
  const { segments: enforced, changes } = enforceConstraints(
    finalSegments,
    metadata,
    transcript,
    purpose,
    targetDuration,
  );

  if (changes.length > 0) {
    console.warn(`[StoryIQ Tools] Enforcer made ${changes.length} change(s):`);
    changes.forEach((c) => console.warn(`  - ${c.detail}`));
    finalSegments = enforced;
  } else {
    console.log(`[StoryIQ Tools] Enforcer: no changes needed (clean output)`);
    finalSegments = enforced; // always use the enforcer's copy
  }

  // ── Return ─────────────────────────────────────────────────────────

  const processingTime = Date.now() - startTime;
  const totalDuration = finalSegments.reduce(
    (sum, s) => sum + (s.endTime - s.startTime),
    0,
  );

  console.log(
    `[StoryIQ Tools] Complete in ${processingTime}ms. ` +
      `${finalSegments.length} segments, ${Math.round(totalDuration)}s total, ` +
      `${totalToolCalls} tool calls`,
  );

  // Use quality review confidence if available, otherwise base on enforcer outcome
  const confidence =
    qualityReviewConfidence !== null
      ? qualityReviewConfidence * (changes.length === 0 ? 1 : 0.85)
      : changes.length === 0
        ? 0.9
        : 0.75;

  return {
    segments: finalSegments,
    confidence,
    notes:
      changes.length > 0
        ? [
            `Enforcer applied ${changes.length} fix(es) after tool conversation.`,
          ]
        : ["All constraints met by tool conversation."],
    attempts: 1,
  };
}

// ============================================================================
// Quality Review (Separate Claude Call)
// ============================================================================

interface QualityReviewResult {
  issues: string[];
  confidence: number | null; // null if review failed or didn't report
}

async function runQualityReview(
  segments: AcceptedSegment[],
  purpose: Purpose,
): Promise<QualityReviewResult> {
  if (segments.length === 0) return { issues: [], confidence: null };

  const segmentDetails = segments
    .map((s) => {
      return (
        `SEGMENT #${s.id}: "${s.segment.title}"\n` +
        `  Time: ${s.segment.startTime.toFixed(1)}s - ${s.segment.endTime.toFixed(1)}s (${Math.round(s.segment.endTime - s.segment.startTime)}s)\n` +
        `  Reasoning: ${s.segment.reasoning}\n` +
        `  ACTUAL CONTENT: "${s.content.substring(0, 500) || "(no dialogue — visual/music only)"}"`
      );
    })
    .join("\n\n");

  const prompt =
    `You are reviewing video segments for QUALITY ONLY. Duration and constraint issues are handled by code — ignore them.\n\n` +
    `PURPOSE: ${purpose}\n\n` +
    `SEGMENTS WITH ACTUAL CONTENT:\n\n${segmentDetails}\n\n` +
    `CHECK EACH SEGMENT:\n` +
    `1. Does the title match the ACTUAL CONTENT shown? Flag specific mismatches (e.g., "Segment #3 titled 'The Big Fight' but content shows a quiet dinner conversation").\n` +
    `2. Is the title based on external knowledge rather than the transcript? Flag if so.\n` +
    `3. Are any titles generic or meaningless (e.g., "Scene 5", "Continuation")?\n` +
    `4. For ${purpose}: are critical narrative moments missing?\n\n` +
    `Output JSON only:\n` +
    `{\n` +
    `  "issues": ["specific issue 1", "specific issue 2"],\n` +
    `  "confidence": number (0-1, your confidence in the segment quality),\n` +
    `  "passed": boolean\n` +
    `}\n\n` +
    `If all titles accurately match their content and selections are appropriate, return {"issues": [], "confidence": 0.9, "passed": true}.`;

  try {
    const content = await callClaude({
      model: "sonnet",
      maxTokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });

    const parsed = parseJSONFromLLM<{
      issues?: string[];
      confidence?: number;
      passed?: boolean;
    }>(content);

    const confidence =
      typeof parsed.confidence === "number" ? parsed.confidence : null;

    if (
      parsed.passed === true ||
      !parsed.issues ||
      parsed.issues.length === 0
    ) {
      return { issues: [], confidence };
    }
    return { issues: parsed.issues, confidence };
  } catch (error) {
    console.error("[StoryIQ Tools] Quality review failed:", error);
    return { issues: [], confidence: null }; // Don't block on review failure
  }
}
