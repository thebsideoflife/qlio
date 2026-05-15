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

/**
 * Segment definitions for microdrama editor use: scene units + plot-lane tagging (A/B/C).
 * One definition keeps segments non-overlapping on the timeline; fields carry thread + hook metadata.
 */
export function qlioMicrodramaSegmentDefinitions(): TwelvelabsApi.SegmentDefinition[] {
  return [
    {
      id: "qlio_scene",
      description:
        "Segment the full video into distinct scenes or substantive beats " +
        "(setting change, major story turn, or clear emotional shift). " +
        "Each segment should be one coherent unit an editor could turn into a short-form clip candidate. " +
        "If a microdrama uses interleaved storylines, keep timeline order; tag which narrative thread dominates.",
      fields: [
        {
          name: "summary",
          type: "string",
          description:
            "2-4 sentences: what happens in this segment and why it matters for the overall story.",
        },
        {
          name: "primary_storyline",
          type: "string",
          description:
            "Which narrative thread this segment mainly advances, if any (microdrama A/B/C style).",
          enum: ["A", "B", "C", "multiple", "none", "unclear"],
        },
        {
          name: "storyline_note",
          type: "string",
          description:
            "If primary_storyline is multiple or unclear, briefly explain overlapping threads or transitions.",
        },
        {
          name: "characters",
          type: "array",
          description:
            "Named or identifiable characters prominently in this segment.",
          items: { type: "string" },
        },
        {
          name: "dominant_mood",
          type: "string",
          description:
            "Primary emotional tone (dialogue + performance + visuals).",
        },
        {
          name: "vertical_hook_potential",
          type: "string",
          description:
            "One line: why a viewer might stop scrolling here (tension, reveal, conflict, etc.).",
        },
        {
          name: "clip_fit",
          type: "string",
          description: "How suitable this beat is as a standalone short clip.",
          enum: ["strong", "moderate", "weak"],
        },
      ],
    },
  ];
}

/**
 * Same definitions as {@link qlioMicrodramaSegmentDefinitions}, with extra
 * natural-language goals baked into the segmenter prompt (producer instructions,
 * target runtime, subplot tagging).
 */
export function qlioMicrodramaSegmentDefinitionsForGeneration(opts: {
  userInstructions?: string;
  targetDurationSeconds?: number;
  videoDurationSeconds: number;
}): TwelvelabsApi.SegmentDefinition[] {
  const defs = qlioMicrodramaSegmentDefinitions();
  const d = defs[0];
  const parts: string[] = [];
  if (opts.userInstructions?.trim()) {
    parts.push(`Producer instructions (follow closely): ${opts.userInstructions.trim()}`);
  }
  if (opts.targetDurationSeconds && opts.targetDurationSeconds > 0) {
    parts.push(
      `The intended supercut targets about ${Math.round(opts.targetDurationSeconds)}s of selected material from this ${Math.round(opts.videoDurationSeconds)}s source; mark clip_fit=strong on beats that are essential for hitting that target, weak on tangents.`,
    );
  }
  parts.push(
    "Use primary_storyline A/B/C only when threads are clearly distinct; use multiple if A and B are hard to separate; use none for intros/outros.",
    'If the producer asks to drop or exclude a subplot (often "C"), label those beats primary_storyline=C.',
    "When choosing start/end times, prefer boundaries at natural dialogue pauses, line turns, or clear visual beat changes while respecting segment duration limits.",
  );
  const suffix = parts.length ? ` ${parts.join(" ")}` : "";
  return [{ ...d, description: d.description + suffix }];
}

// =============================================================================
// Serialized Sci-Fi (Star Trek–style) Profile
// =============================================================================

/**
 * Segment definitions for serialized sci-fi with interleaved A/B/C plot threading,
 * optimized for episodic structure like Star Trek.
 */
export function trekSerializedSegmentDefinitions(): TwelvelabsApi.SegmentDefinition[] {
  return [
    {
      id: "qlio_trek_scene",
      description:
        "Segment the episode into distinct scenes, tracking interleaved narrative threads. " +
        "Each segment should be 60-180s representing one coherent scene unit. " +
        "Tag which storyline (A/B/C) dominates each segment: " +
        "A = main bridge/captain's mission/primary conflict, " +
        "B = secondary mission or character B-story, " +
        "C = tertiary/bottle thread or episodic subplot. " +
        "A/B/C designation helps downstream filtering (e.g., drop C-plots for condensed version). " +
        "Maintain timeline order; do not overlap segments.",
      fields: [
        {
          name: "summary",
          type: "string",
          description:
            "2-4 sentences: what happens in this segment and how it advances the episode's story.",
        },
        {
          name: "primary_storyline",
          type: "string",
          description:
            "Which narrative thread this segment mainly advances. A = main plot (captain's mission, primary conflict), B = secondary mission or character B-story, C = tertiary subplot or bottle thread.",
          enum: ["A", "B", "C", "multiple", "none", "unclear"],
        },
        {
          name: "storyline_note",
          type: "string",
          description:
            "If primary_storyline is multiple or unclear, explain the overlapping threads or why classification is difficult.",
        },
        {
          name: "characters",
          type: "array",
          description:
            "Named characters prominently featured in this segment (e.g., 'Captain Picard', 'Data', 'Spock').",
          items: { type: "string" },
        },
        {
          name: "dominant_mood",
          type: "string",
          description:
            "Primary emotional tone of the segment (e.g., 'tense', 'philosophical', 'action', 'humorous', 'melancholic').",
        },
        {
          name: "plot_function",
          type: "string",
          description:
            "Where this segment sits in narrative structure: setup (establishing stakes), conflict (rising tension), climax (peak confrontation), resolution (aftermath), or transition (bridging scenes).",
          enum: ["setup", "conflict", "climax", "resolution", "transition"],
        },
        {
          name: "vertical_hook_potential",
          type: "string",
          description:
            "One line: why a viewer might stop scrolling here (dramatic reveal, character moment, visual spectacle, etc.).",
        },
        {
          name: "clip_fit",
          type: "string",
          description:
            "How suitable this segment is as a standalone short clip.",
          enum: ["strong", "moderate", "weak"],
        },
      ],
    },
  ];
}

/**
 * Trek serialized definitions with generation-time guidance.
 */
export function trekSerializedSegmentDefinitionsForGeneration(opts: {
  userInstructions?: string;
  targetDurationSeconds?: number;
  videoDurationSeconds: number;
}): TwelvelabsApi.SegmentDefinition[] {
  const defs = trekSerializedSegmentDefinitions();
  const d = defs[0];
  const parts: string[] = [];
  if (opts.userInstructions?.trim()) {
    parts.push(`Producer instructions (follow closely): ${opts.userInstructions.trim()}`);
  }
  if (opts.targetDurationSeconds && opts.targetDurationSeconds > 0) {
    parts.push(
      `The intended supercut targets about ${Math.round(opts.targetDurationSeconds)}s from this ${Math.round(opts.videoDurationSeconds)}s episode; mark clip_fit=strong on essential A-plot beats, weak on skippable C-plot tangents.`,
    );
  }
  parts.push(
    "Use primary_storyline A/B/C to track distinct narrative threads; use multiple only when threads genuinely interweave in a single scene.",
    "If producer asks to drop C-plots, mark those segments primary_storyline=C so they can be filtered.",
    "For classic Trek structure: teaser → A-plot setup → B-plot introduction → interleaved development → convergence → resolution.",
    "When choosing segment boundaries, prefer scene changes (location shifts, act breaks, commercial-break-style transitions).",
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
  },
): TwelvelabsApi.SegmentDefinition[] {
  switch (contentType) {
    case "serialized_scifi":
      return trekSerializedSegmentDefinitionsForGeneration(opts);
    case "generic":
    default:
      return qlioMicrodramaSegmentDefinitionsForGeneration(opts);
  }
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
    params.segmentDefinitions ?? qlioMicrodramaSegmentDefinitions();

  if (
    params.limitAnalysisToWindow &&
    (params.startTime !== undefined ||
      params.endTime !== undefined)
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
    console.error(`[Pegasus] Task ${taskId} failed. Full error:`, JSON.stringify(task.error, null, 2));
    console.error(`[Pegasus] Task ${taskId} full response:`, JSON.stringify({
      status: task.status,
      requestParams: task.requestParams,
      error: task.error,
    }, null, 2));
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
