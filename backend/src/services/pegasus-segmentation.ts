/**
 * Pegasus 1.5 — time-based metadata (video segmentation) for Qlio evaluation.
 *
 * Async analyze tasks only accept video via TwelveLabs `VideoContext`:
 * - `url`: direct playable URL (e.g. presigned GET to raw mp4 in S3; not YouTube)
 * - `asset_id`: TwelveLabs media already on the platform — either an [upload](https://docs.twelvelabs.io/) `Asset.id`,
 *   or (for index-ingested video) the same id returned as `asset_id` on `GET .../indexes/{index_id}/videos/{video_id}`
 *   (often equal to `video_id`). No S3 egress from your bucket when TwelveLabs already holds the bytes.
 * - `base64_string`: inlined media
 *
 * Indexed Marengo `videoId` values are not used here — that is a separate API surface.
 *
 * Docs: https://docs.twelvelabs.io/docs/concepts/models/pegasus
 *       https://docs.twelvelabs.io/v1.3/docs/guides/segment-videos
 */

import { TwelveLabs, TwelvelabsApi } from "twelvelabs-js";
import type { ContentType } from "./storyiq/types";

/** StoryIQ Pegasus `time_based_metadata` segment length hints (seconds) — keep in sync with pipeline. */
export const QLIO_PEGASUS_SEGMENT_MIN_SEC = 60;
export const QLIO_PEGASUS_SEGMENT_MAX_SEC = 180;

// =============================================================================
// Qlio Microseries Definition (replaces A/B/C prompt)
// =============================================================================

/**
 * Microseries segment definition — simple, editorial-focused.
 * No A/B/C jargon. Uses `microseries_keep` for downstream filtering.
 */
export function qlioMicroseriesSegmentDefinitions(): TwelvelabsApi.SegmentDefinition[] {
  return [
    {
      id: "qlio_scene",
      description:
        "Segment the video into distinct scenes or substantive beats " +
        "(setting change, major story turn, or clear emotional shift). " +
        "A microseries cut keeps the main storyline plus one meaningful secondary thread with core cast; " +
        "tangential subplots, filler, and transitions that don't advance plot should be marked for exclusion. " +
        "If no clear threads exist, deliver a pared-down main spine only.",
      fields: [
        {
          name: "title",
          type: "string",
          description:
            "3-5 words: WHO does WHAT. A punchy scene headline. " +
            "Example: 'Spock Discovers Time Portal'. " +
            "Do NOT use dialogue quotes or 'Scene X' labels.",
        },
        {
          name: "description",
          type: "string",
          description:
            "7-10 words: One pithy sentence expanding the title. " +
            "Example: 'Kirk and Spock realize McCoy has altered history through the Guardian.' " +
            "Third-person, action-focused, no transcript verbatim.",
        },
        {
          name: "lead_characters",
          type: "array",
          description:
            "Named or identifiable characters prominently in this segment.",
          items: { type: "string" },
        },
        {
          name: "narrative_role",
          type: "string",
          description:
            "Where this segment sits in the story: main_story (core plot), secondary_story (B-plot with main cast), subplot (tangential thread), filler (exposition/transition), or transition (bridging only).",
          enum: [
            "main_story",
            "secondary_story",
            "subplot",
            "filler",
            "transition",
          ],
        },
        {
          name: "microseries_keep",
          type: "string",
          description:
            "Should this segment be kept in the microseries cut? 'yes' for main_story and valuable secondary_story; 'no' for subplot, filler, pure transitions, or content that doesn't advance core narrative.",
          enum: ["yes", "no"],
        },
      ],
    },
  ];
}

/**
 * Microseries definitions with generation-time guidance.
 * Only adds user instructions when provided — no default producer suffix.
 */
export function qlioMicroseriesSegmentDefinitionsForGeneration(opts: {
  userInstructions?: string;
  targetDurationSeconds?: number;
  videoDurationSeconds: number;
}): TwelvelabsApi.SegmentDefinition[] {
  const defs = qlioMicroseriesSegmentDefinitions();
  const d = defs[0];
  const parts: string[] = [];

  // Only add user instructions if provided (no default noise)
  if (opts.userInstructions?.trim()) {
    parts.push(`Producer instructions: ${opts.userInstructions.trim()}`);
  }

  if (opts.targetDurationSeconds && opts.targetDurationSeconds > 0) {
    parts.push(
      `Target ~${Math.round(opts.targetDurationSeconds)}s from this ${Math.round(opts.videoDurationSeconds)}s source.`,
    );
  }

  parts.push(
    "Prefer boundaries at natural dialogue pauses, scene changes, or clear visual beat shifts.",
  );

  const suffix = parts.length ? ` ${parts.join(" ")}` : "";
  return [{ ...d, description: d.description + suffix }];
}

// =============================================================================
// Episode Recap Definition
// =============================================================================

/**
 * Episode recap segment definition — "previously on" style beats.
 *
 * Design goal: The selected beats should cut together into a cohesive mini-story,
 * not just isolated "big moments." Think Game of Thrones recaps (surfaces the
 * oath/betrayal/item that pays off in THIS episode) or Breaking Bad recaps
 * (connects prior choices → upcoming consequences).
 */
export function episodeRecapSegmentDefinitions(): TwelvelabsApi.SegmentDefinition[] {
  return [
    {
      id: "qlio_scene",
      description:
        "Create a 'Previously on...' recap: 4-6 beats (~60-90 seconds) that form a cohesive mini-story. " +
        "The beats should CONNECT — each one sets up or pays off another. " +
        "Include: turning points, confrontations, revelations, promises/threats that will matter. " +
        "Skip: exposition dumps, travelogue, humor that doesn't advance plot, any beat that only makes sense with 2+ minutes of context.",
      fields: [
        {
          name: "title",
          type: "string",
          description:
            "3-5 words: WHO does WHAT. Punchy headline for this beat. " +
            "Examples: 'Jon Learns His Lineage', 'Walt Refuses the Money', 'Locke Opens the Hatch'. " +
            "No dialogue quotes, no spoiler reveals.",
        },
        {
          name: "description",
          type: "string",
          description:
            "One sentence: what happens AND why it matters for the story. " +
            "Example: 'Cersei refuses Ned's mercy, sealing both their fates.' " +
            "Connect cause to effect.",
        },
        {
          name: "lead_characters",
          type: "array",
          description: "1-3 characters driving this beat.",
          items: { type: "string" },
        },
        {
          name: "story_function",
          type: "string",
          description:
            "What role does this beat play in the recap's mini-narrative? " +
            "setup (establishes stakes/conflict), escalation (raises tension), pivot (changes direction), payoff (delivers on prior setup).",
          enum: ["setup", "escalation", "pivot", "payoff"],
        },
        {
          name: "recap_keep",
          type: "string",
          description:
            "Keep in the final recap? 'yes' ONLY for beats that: (1) connect to at least one other kept beat, AND (2) are essential or highly memorable. " +
            "Mark exactly 4-6 beats 'yes'. All others 'no'.",
          enum: ["yes", "no"],
        },
      ],
    },
  ];
}

/**
 * Episode recap definitions with generation-time guidance.
 */
export function episodeRecapSegmentDefinitionsForGeneration(opts: {
  userInstructions?: string;
  videoDurationSeconds: number;
  targetDurationSeconds?: number;
}): TwelvelabsApi.SegmentDefinition[] {
  const defs = episodeRecapSegmentDefinitions();
  const d = defs[0];
  const parts: string[] = [];

  if (opts.userInstructions?.trim()) {
    parts.push(`Producer instructions: ${opts.userInstructions.trim()}`);
  }

  const recapTarget =
    opts.targetDurationSeconds && opts.targetDurationSeconds > 0
      ? Math.round(opts.targetDurationSeconds)
      : 75;

  parts.push(
    `Target runtime: ~${recapTarget}s (4-6 beats, each 10-20s).`,
    "The kept beats should tell a STORY together — a viewer watching only the recap should feel narrative momentum, not a random highlight reel.",
    "Imagine cutting these beats back-to-back: do they flow? Does beat 2 follow from beat 1? Does the last beat leave the viewer wanting more?",
  );

  const suffix = parts.length ? ` ${parts.join(" ")}` : "";
  return [{ ...d, description: d.description + suffix }];
}

// =============================================================================
// Segment definitions by classifier output (sports uses replay path, not here)
// =============================================================================

export function getSegmentDefinitions(
  contentType: ContentType,
  opts: {
    userInstructions?: string;
    targetDurationSeconds?: number;
    videoDurationSeconds: number;
    purpose?: "compact_video" | "full_video" | "highlights" | "episode_recap";
  },
): TwelvelabsApi.SegmentDefinition[] {
  // Episode recap uses dedicated definition
  if (opts.purpose === "episode_recap") {
    return episodeRecapSegmentDefinitionsForGeneration({
      userInstructions: opts.userInstructions,
      videoDurationSeconds: opts.videoDurationSeconds,
      targetDurationSeconds: opts.targetDurationSeconds,
    });
  }

  // All other purposes use microseries definition (includes generic and serialized_scifi)
  return qlioMicroseriesSegmentDefinitionsForGeneration(opts);
}

// =============================================================================
// Task Creation & Polling
// =============================================================================

export interface CreateQlioSegmentationTaskParams {
  video: TwelvelabsApi.VideoContext;
  /** Correlate tasks in logs / webhooks (optional). */
  customId?: string;
  minSegmentDuration?: number;
  maxSegmentDuration?: number;
  /** Top-level clipping (TwelveLabs). Mutually exclusive with `segmentDefinitions[].timeRanges`. */
  startTime?: number;
  endTime?: number;
  /**
   * Limit segmentation to `[startTime, endTime]` on the video asset by attaching
   * `time_ranges` to each segment definition (TwelveLabs-recommended pattern for
   * `time_based_metadata`). Mutually exclusive with top-level `startTime`/`endTime`,
   * and with `minSegmentDuration`/`maxSegmentDuration` on the request.
   */
  limitAnalysisToWindow?: TwelvelabsApi.AnalyzeTimeRange;
  /** Replace default definitions for experiments */
  segmentDefinitions?: TwelvelabsApi.SegmentDefinition[];
}

/**
 * Start Pegasus 1.5 **async video segmentation** (`POST .../analyze-async/tasks`).
 * Uses `analysisMode: "time_based_metadata"` + `segment_definitions` — this is TwelveLabs’
 * segment API (not sync `analyze` chat-style calls).
 */
export async function createQlioPegasusSegmentationTask(
  client: TwelveLabs,
  params: CreateQlioSegmentationTaskParams,
): Promise<TwelvelabsApi.CreateAnalyzeTaskResponse> {
  let segmentDefinitions =
    params.segmentDefinitions ?? qlioMicroseriesSegmentDefinitions();

  if (
    params.limitAnalysisToWindow &&
    (params.startTime !== undefined || params.endTime !== undefined)
  ) {
    throw new Error(
      "[Pegasus] limitAnalysisToWindow is mutually exclusive with startTime/endTime",
    );
  }

  const win = params.limitAnalysisToWindow;
  if (win) {
    // timeRanges is mutually exclusive with top-level startTime/endTime, but NOT with min/maxSegmentDuration
    if (params.startTime !== undefined || params.endTime !== undefined) {
      throw new Error(
        "[Pegasus] limitAnalysisToWindow is mutually exclusive with top-level startTime/endTime",
      );
    }
    segmentDefinitions = segmentDefinitions.map((def) => ({
      ...def,
      timeRanges: [{ startTime: win.startTime, endTime: win.endTime }],
    }));
  }

  const payload: Parameters<typeof client.analyzeAsync.tasks.create>[0] = {
    modelName: "pegasus1.5",
    video: params.video,
    analysisMode: "time_based_metadata",
    customId: params.customId,
    responseFormat: {
      type: "segment_definitions",
      segmentDefinitions,
    },
  };

  // min/maxSegmentDuration work with both timeRanges and top-level startTime/endTime
  if (params.minSegmentDuration !== undefined) {
    payload.minSegmentDuration = params.minSegmentDuration;
  }
  if (params.maxSegmentDuration !== undefined) {
    payload.maxSegmentDuration = params.maxSegmentDuration;
  }
  // top-level startTime/endTime only if NOT using timeRanges
  if (!win) {
    if (params.startTime !== undefined) {
      payload.startTime = params.startTime;
    }
    if (params.endTime !== undefined) {
      payload.endTime = params.endTime;
    }
  }

  return client.analyzeAsync.tasks.create(payload);
}

/**
 * Poll until the async task completes or fails.
 */
export async function pollPegasusAnalyzeTask(
  client: TwelveLabs,
  taskId: string,
  options?: { intervalMs?: number; maxWaitMs?: number },
): Promise<TwelvelabsApi.AnalyzeTaskResponse> {
  const intervalMs = options?.intervalMs ?? 5000;
  const maxWaitMs = options?.maxWaitMs ?? 3_600_000; // 1 hour
  const deadline = Date.now() + maxWaitMs;

  let task = await client.analyzeAsync.tasks.retrieve(taskId);
  while (task.status !== "ready" && task.status !== "failed") {
    if (Date.now() > deadline) {
      throw new Error(
        `[Pegasus] Task ${taskId} still ${task.status} after ${maxWaitMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    task = await client.analyzeAsync.tasks.retrieve(taskId);
  }

  if (task.status === "failed") {
    console.error(
      `[Pegasus] Task ${taskId} failed. Full error:`,
      JSON.stringify(task.error, null, 2),
    );
    console.error(
      `[Pegasus] Task ${taskId} full response:`,
      JSON.stringify(
        {
          status: task.status,
          requestParams: task.requestParams,
          error: task.error,
        },
        null,
        2,
      ),
    );
    const msg = task.error?.message ?? JSON.stringify(task.error ?? {});
    throw new Error(`[Pegasus] Task ${taskId} failed: ${msg}`);
  }

  return task;
}

/**
 * Parse `task.result.data` JSON. Keys match segment definition `id` values (e.g. `qlio_scene`).
 */
export function parsePegasusSegmentationData(
  json: string | undefined,
): Record<string, unknown> {
  if (!json) {
    throw new Error("[Pegasus] No result data in task response");
  }
  return JSON.parse(json) as Record<string, unknown>;
}
