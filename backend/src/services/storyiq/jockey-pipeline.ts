/**
 * Jockey Pipeline — Claude (Bedrock) narrative preprocess + windowed Pegasus
 * segmentation for compact_video and episode_recap only.
 *
 * Phases:
 *   0. Claude Sonnet → NarrativeBrief (transcript-grounded story beats)
 *   1. Window planner → AnalysisWindow[] (virtual windows over physical chunks)
 *   2. Parallel Pegasus tasks with brief-enriched segment definitions
 *   3. Merge + timeline coverage check (fail loudly on latter-half bias)
 *   4. Keep filter, target selection, quartile backfill / recap beat fitting
 *   5. Enforcer + narrative title pass (no mechanical "(Part N)" titles)
 */

import type { TwelveLabsWrapper } from "../twelvelabs";
import {
  createQlioPegasusSegmentationTask,
  parsePegasusSegmentationData,
  pollPegasusAnalyzeTask,
  buildJockeySegmentDefinitions,
  QLIO_PEGASUS_SEGMENT_MAX_SEC,
  QLIO_PEGASUS_SEGMENT_MIN_SEC,
} from "../pegasus-segmentation";
import {
  Purpose,
  type FinalSegments,
  type GenerationOptions,
  type ProposedSegment,
} from "./types";
import {
  resolveVideoContextForPegasus,
  mergeChunkResults,
  parsePegasusSceneRows,
  rowsToProposedSegments,
  shouldKeepPegasusSegment,
  type PegasusChunkTaskResult,
  type PegasusSceneRow,
} from "./pegasus-pipeline";
import {
  selectSegmentsForTarget,
  buildPegasusMetadataMap,
} from "./pegasus-selection";
import { enforceConstraints } from "./verify";
import { preprocessNarrativeBrief } from "./jockey/preprocess";
import { preprocessNarrativeBriefFromAgents } from "./jockey/preprocess-agents";
import {
  planAnalysisWindows,
  normalizeWindowRowTimes,
  JOCKEY_WINDOW_DURATION_SEC,
  JOCKEY_WINDOW_OVERLAP_SEC,
  type PhysicalVideoContext,
} from "./jockey/window-planner";
import {
  checkTimelineCoverage,
  backfillQuartileCoverage,
  narrowRecapBeatWindows,
} from "./jockey/coverage";
import { applyNarrativeTitles } from "./jockey/titles";
import type { AnalysisWindow, NarrativeBrief } from "./jockey/types";

/** Locked product decision: compact defaults to 50% of source runtime. */
const COMPACT_DEFAULT_TARGET_PERCENT = 50;
const EPISODE_RECAP_DEFAULT_TARGET_SEC = 75;
const MAX_CONCURRENT_PEGASUS = 4;
/** Recap totals outside this band get deterministically re-fit. */
const RECAP_MIN_TOTAL_SEC = 55;
const RECAP_MAX_TOTAL_SEC = 115;

export interface JockeyPipelineOptions extends GenerationOptions {
  maxPollWaitMs?: number;
  minSegmentDuration?: number;
  maxSegmentDuration?: number;
  /** Override virtual window size (eval experiments). */
  windowDurationSec?: number;
  /** Override virtual window overlap (eval experiments). */
  overlapSec?: number;
  /** Preset brief — skips the Claude preprocess entirely (eval use). */
  narrativeBrief?: NarrativeBrief;
  /** With a preset brief: don't inject brief content into Pegasus defs (eval use). */
  skipBriefEnrichment?: boolean;
  /** Source the brief from the TwelveLabs Agents API instead of Claude (eval use). */
  agentsApiKey?: string;
  agentsTwelveLabsAssetId?: string;
}

function pegasusSegmentDurationBounds(options?: {
  minSegmentDuration?: number;
  maxSegmentDuration?: number;
}): {
  minSegmentDuration: number;
  maxSegmentDuration: number;
} {
  return {
    minSegmentDuration:
      options?.minSegmentDuration ?? QLIO_PEGASUS_SEGMENT_MIN_SEC,
    maxSegmentDuration:
      options?.maxSegmentDuration ?? QLIO_PEGASUS_SEGMENT_MAX_SEC,
  };
}

function resolveTargetSeconds(
  options: JockeyPipelineOptions,
  duration: number,
): number {
  const { purpose, targetDuration, targetPercent } = options;

  let target =
    targetDuration ??
    (targetPercent ? Math.round((duration * targetPercent) / 100) : undefined);

  if (!target || target <= 0) {
    if (purpose === Purpose.EPISODE_RECAP) {
      target = EPISODE_RECAP_DEFAULT_TARGET_SEC;
    } else {
      target = Math.round((duration * COMPACT_DEFAULT_TARGET_PERCENT) / 100);
    }
  }
  return target;
}

function physicalChunksFromContext(
  videoContext: Awaited<ReturnType<typeof resolveVideoContextForPegasus>>,
  durationSec: number,
): PhysicalVideoContext[] {
  if (videoContext.isChunked && videoContext.chunks?.length) {
    return videoContext.chunks.map((c) => ({
      videoId: c.videoId,
      localDurationSec: c.endOffset - c.startOffset,
      physicalOffsetSec: c.startOffset,
      chunkIndex: c.chunkIndex,
    }));
  }

  if (videoContext.video?.type === "asset_id") {
    return [
      {
        videoId: videoContext.video.assetId,
        localDurationSec: durationSec,
        physicalOffsetSec: 0,
        chunkIndex: 0,
      },
    ];
  }

  throw new Error(
    "[Jockey] Asset must have TwelveLabs video ID(s) — S3 fallback not supported in Jockey path",
  );
}

interface WindowRunOutcome {
  results: PegasusChunkTaskResult[];
  failures: Array<{ window: AnalysisWindow; error: string }>;
}

/**
 * Run Pegasus over analysis windows in batches of MAX_CONCURRENT_PEGASUS.
 * Individual window failures are tolerated as long as at least one window
 * succeeds — the coverage check downstream decides whether the surviving
 * output is acceptable. All-window failure throws.
 */
async function runWindowBatch(
  client: ReturnType<TwelveLabsWrapper["getClient"]>,
  windows: AnalysisWindow[],
  videoDurationSec: number,
  segmentDefinitionsFactory: (
    window: AnalysisWindow,
  ) => ReturnType<typeof buildJockeySegmentDefinitions>,
  bounds: { minSegmentDuration: number; maxSegmentDuration: number },
  customIdPrefix: string,
  deadline: () => number,
): Promise<WindowRunOutcome> {
  const results: PegasusChunkTaskResult[] = [];
  const failures: WindowRunOutcome["failures"] = [];

  const runOne = async (window: AnalysisWindow): Promise<void> => {
    const customId = `${customIdPrefix}-w${window.chunkIndex}`.slice(0, 64);
    try {
      const defs = segmentDefinitionsFactory(window);
      const task = await createQlioPegasusSegmentationTask(client, {
        video: { type: "asset_id", assetId: window.videoId },
        customId,
        segmentDefinitions: defs,
        limitAnalysisToWindow: {
          startTime: window.localStartSec,
          endTime: window.localEndSec,
        },
        minSegmentDuration: bounds.minSegmentDuration,
        maxSegmentDuration: bounds.maxSegmentDuration,
      });

      const polled = await pollPegasusAnalyzeTask(client, task.taskId, {
        intervalMs: 5000,
        maxWaitMs: Math.max(60_000, deadline()),
      });
      const parsed = parsePegasusSegmentationData(polled.result?.data);
      // Pegasus may return asset-local or window-relative times with
      // time_ranges — normalize everything to the original timeline here.
      const rows = parsePegasusSceneRows(parsed).map((row) =>
        normalizeWindowRowTimes(row, window, videoDurationSec),
      );

      console.log(
        `[Jockey] Window ${window.chunkIndex} complete: ${rows.length} segments ` +
          `(global ${Math.round(window.physicalOffsetSec + window.localStartSec)}–${Math.round(window.physicalOffsetSec + window.localEndSec)}s, task ${task.taskId})`,
      );

      results.push({
        chunkIndex: window.chunkIndex,
        // Rows are already on the original timeline; no further offset needed.
        startOffset: 0,
        endOffset: window.physicalOffsetSec + window.localEndSec,
        rows,
        taskId: task.taskId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Jockey] Window ${window.chunkIndex} failed: ${msg}`);
      failures.push({ window, error: msg });
    }
  };

  for (let i = 0; i < windows.length; i += MAX_CONCURRENT_PEGASUS) {
    const batch = windows.slice(i, i + MAX_CONCURRENT_PEGASUS);
    await Promise.all(batch.map(runOne));
  }

  if (results.length === 0) {
    throw new Error(
      `[Jockey] All ${windows.length} Pegasus window(s) failed. First error: ${failures[0]?.error ?? "unknown"}`,
    );
  }
  if (failures.length > 0) {
    console.warn(
      `[Jockey] ${failures.length}/${windows.length} window(s) failed — continuing with partial results ` +
        `(coverage check will reject biased output)`,
    );
  }

  return { results, failures };
}

async function runJockeyPegasusPhase(
  twelvelabs: TwelveLabsWrapper,
  options: JockeyPipelineOptions & {
    targetSeconds: number;
    brief: NarrativeBrief;
    windowDurationSec: number;
    overlapSec: number;
    deadline: () => number;
  },
): Promise<{
  chunkResults: PegasusChunkTaskResult[];
  taskIds: string[];
  windowFailures: number;
  windowCount: number;
}> {
  const { metadata, purpose, userInstructions, brief } = options;
  const client = twelvelabs.getClient();
  const videoContext = await resolveVideoContextForPegasus(
    twelvelabs,
    metadata.assetId,
  );
  const physical = physicalChunksFromContext(videoContext, metadata.duration);
  const purposeKey =
    purpose === Purpose.EPISODE_RECAP ? "episode_recap" : "compact_video";
  const windows = planAnalysisWindows(physical, brief, metadata.duration, {
    windowDurationSec: options.windowDurationSec,
    overlapSec: options.overlapSec,
    purpose: purposeKey,
  });

  const bounds = pegasusSegmentDurationBounds({
    minSegmentDuration:
      options.minSegmentDuration ??
      (purpose === Purpose.EPISODE_RECAP ? 10 : undefined),
    maxSegmentDuration:
      options.maxSegmentDuration ??
      (purpose === Purpose.EPISODE_RECAP ? 20 : undefined),
  });
  const safeId = `jockey-${metadata.assetId}`.replace(/[^a-zA-Z0-9_-]/g, "-");

  const purposeForDefs =
    purpose === Purpose.EPISODE_RECAP
      ? Purpose.EPISODE_RECAP
      : Purpose.COMPACT_VIDEO;

  const outcome = await runWindowBatch(
    client,
    windows,
    metadata.duration,
    (window) =>
      buildJockeySegmentDefinitions(brief, purposeForDefs, {
        userInstructions,
        targetDurationSeconds: options.targetSeconds,
        videoDurationSeconds: metadata.duration,
        windowArcNames: options.skipBriefEnrichment ? [] : window.arcNames,
        windowLocalStartSec: window.localStartSec,
        windowLocalEndSec: window.localEndSec,
        physicalOffsetSec: window.physicalOffsetSec,
        // time_ranges tasks can't take API-level duration bounds — carried as prompt guidance
        minSegmentDurationSec: bounds.minSegmentDuration,
        maxSegmentDurationSec: bounds.maxSegmentDuration,
      }),
    bounds,
    safeId,
    options.deadline,
  );

  return {
    chunkResults: outcome.results,
    taskIds: outcome.results.map((r) => r.taskId),
    windowFailures: outcome.failures.length,
    windowCount: windows.length,
  };
}

/** Convert brief recap beats directly into proposed segments (Pegasus keep-filter fallback). */
function segmentsFromRecapBeats(
  brief: NarrativeBrief,
  durationSec: number,
): ProposedSegment[] {
  const beats = brief.recapBeats ?? [];
  return beats
    .map((b) => ({
      startTime: Math.max(0, Math.min(b.approximateStartSec, durationSec - 5)),
      endTime: Math.max(
        b.approximateStartSec + 5,
        Math.min(b.approximateEndSec, durationSec),
      ),
      title: b.label,
      reasoning: `Narrative beat (${b.narrativeRole}): ${b.label}`,
      expectedContent: "",
      section: `role-${b.narrativeRole}`,
    }))
    .sort((a, b) => a.startTime - b.startTime);
}

interface PostProcessResult {
  proposed: ProposedSegment[];
  /** All parsed segments before keep-filter/selection — backfill candidates. */
  candidates: ProposedSegment[];
  selectionNotes: string[];
}

function postProcessRows(
  rawRows: PegasusSceneRow[],
  options: JockeyPipelineOptions & {
    targetSeconds: number;
    brief: NarrativeBrief;
  },
  transcript: GenerationOptions["transcript"],
  duration: number,
): PostProcessResult {
  const { purpose, targetSeconds, brief } = options;
  const selectionNotes: string[] = [];
  const candidates = rowsToProposedSegments(rawRows, transcript, duration);

  let keptRows = rawRows.filter((r) => shouldKeepPegasusSegment(r.metadata));
  const minKept = purpose === Purpose.EPISODE_RECAP ? 4 : 3;
  if (keptRows.length < minKept && rawRows.length > keptRows.length) {
    selectionNotes.push(
      `Keep filter too aggressive (${keptRows.length}/${rawRows.length} kept) — reverting to all candidates`,
    );
    keptRows = rawRows;
  } else if (keptRows.length < rawRows.length) {
    selectionNotes.push(
      `${rawRows.length} raw → ${keptRows.length} after keep filter`,
    );
  }

  let proposed = rowsToProposedSegments(keptRows, transcript, duration);
  const pegasusMetadata = buildPegasusMetadataMap(keptRows);

  if (proposed.length === 0) {
    if (purpose === Purpose.EPISODE_RECAP && (brief.recapBeats?.length ?? 0) >= 4) {
      selectionNotes.push(
        "Pegasus returned no usable recap beats — falling back to Claude brief recapBeats",
      );
      proposed = segmentsFromRecapBeats(brief, duration);
    } else {
      throw new Error("[Jockey] No segments after keep filter");
    }
  }

  if (purpose === Purpose.COMPACT_VIDEO && targetSeconds > 0) {
    const totalBefore = proposed.reduce(
      (sum, s) => sum + (s.endTime - s.startTime),
      0,
    );
    if (totalBefore > targetSeconds * 1.05) {
      const selection = selectSegmentsForTarget(
        proposed,
        { targetDuration: targetSeconds, contentType: "generic", purpose },
        pegasusMetadata,
      );
      proposed = selection.selected;
      selectionNotes.push(...selection.scoringNotes);
    }

    // Selection optimizes for score + duration; make sure it didn't hollow
    // out a timeline quartile that had viable candidates.
    const backfilled = backfillQuartileCoverage(candidates, proposed, duration);
    if (backfilled.length > proposed.length) {
      selectionNotes.push(
        `Quartile backfill: ${proposed.length} → ${backfilled.length} segments`,
      );
      proposed = backfilled;
    }
  }

  if (purpose === Purpose.EPISODE_RECAP) {
    const totalDuration = proposed.reduce(
      (sum, s) => sum + (s.endTime - s.startTime),
      0,
    );
    const needsTrim =
      proposed.length > 6 || totalDuration > targetSeconds * 1.25;
    const needsPad = proposed.length < 4;

    if (needsTrim || needsPad) {
      const recapTarget = Math.min(90, Math.max(60, targetSeconds));
      const selection = selectSegmentsForTarget(
        proposed,
        {
          targetDuration: recapTarget,
          contentType: "generic",
          purpose: Purpose.EPISODE_RECAP,
          lowerBoundMultiplier: needsPad ? 0.7 : 0.85,
          upperBoundMultiplier: needsTrim ? 1.0 : 1.15,
        },
        pegasusMetadata,
      );
      proposed = selection.selected;
      selectionNotes.push(
        `Recap beat adjust: ${proposed.length} beats, ~${Math.round(selection.totalDuration)}s`,
      );
    }

    proposed = fitRecapBand(proposed, brief, targetSeconds, duration, selectionNotes);
  }

  return { proposed, candidates, selectionNotes };
}

/**
 * Deterministic recap safety net: guarantee 4–6 beats totaling ~60–90s.
 * Falls back to brief recapBeats when Pegasus output can't be repaired.
 */
function fitRecapBand(
  segments: ProposedSegment[],
  brief: NarrativeBrief,
  targetSeconds: number,
  durationSec: number,
  notes: string[],
): ProposedSegment[] {
  let result = [...segments].sort((a, b) => a.startTime - b.startTime);

  if (result.length < 4 && (brief.recapBeats?.length ?? 0) >= 4) {
    notes.push(
      `Only ${result.length} recap beats survived — rebuilding from Claude brief recapBeats`,
    );
    result = segmentsFromRecapBeats(brief, durationSec);
  }

  if (result.length < 4) {
    throw new Error(
      `[Jockey] Recap produced only ${result.length} beats (need 4–6) and brief has no fallback beats`,
    );
  }

  if (result.length > 6) {
    // Keep chronological story flow: preserve first and last, drop the
    // shortest middle beats until 6 remain.
    while (result.length > 6) {
      let dropIdx = 1;
      let shortest = Infinity;
      for (let i = 1; i < result.length - 1; i++) {
        const d = result[i].endTime - result[i].startTime;
        if (d < shortest) {
          shortest = d;
          dropIdx = i;
        }
      }
      result.splice(dropIdx, 1);
    }
    notes.push(`Recap trimmed to 6 beats (chronological, kept bookends)`);
  }

  const total = result.reduce((sum, s) => sum + (s.endTime - s.startTime), 0);
  if (total < RECAP_MIN_TOTAL_SEC || total > RECAP_MAX_TOTAL_SEC) {
    result = narrowRecapBeatWindows(result, targetSeconds, durationSec);
    const newTotal = result.reduce(
      (sum, s) => sum + (s.endTime - s.startTime),
      0,
    );
    notes.push(
      `Recap re-fit: ${Math.round(total)}s → ${Math.round(newTotal)}s across ${result.length} beats`,
    );
  }

  return result;
}

async function resolveBrief(
  options: JockeyPipelineOptions,
  purposeKey: "compact_video" | "episode_recap",
  targetSeconds: number,
): Promise<{ brief: NarrativeBrief; source: string }> {
  const { metadata, transcript, userInstructions } = options;

  if (options.narrativeBrief) {
    return { brief: options.narrativeBrief, source: "preset" };
  }

  if (options.agentsApiKey && options.agentsTwelveLabsAssetId) {
    const { brief } = await preprocessNarrativeBriefFromAgents({
      agentsApiKey: options.agentsApiKey,
      twelveLabsAssetId: options.agentsTwelveLabsAssetId,
      purpose: purposeKey,
      title: metadata.title,
      durationSec: metadata.duration,
      targetRuntimeSec: targetSeconds,
      userInstructions,
    });
    return { brief, source: "agents" };
  }

  const brief = await preprocessNarrativeBrief({
    transcript,
    purpose: purposeKey,
    title: metadata.title,
    durationSec: metadata.duration,
    targetRuntimeSec: targetSeconds,
    userInstructions,
  });
  return { brief, source: "claude" };
}

/**
 * Generate segments via Jockey orchestration (Claude brief + windowed Pegasus).
 */
export async function generateSegmentsWithJockey(
  twelvelabs: TwelveLabsWrapper,
  options: JockeyPipelineOptions,
): Promise<FinalSegments> {
  const startMs = Date.now();
  const { metadata, transcript, purpose } = options;

  if (
    purpose !== Purpose.COMPACT_VIDEO &&
    purpose !== Purpose.EPISODE_RECAP
  ) {
    throw new Error(
      `[Jockey] Unsupported purpose "${purpose}" — Jockey handles compact_video and episode_recap only`,
    );
  }

  // Overall time budget: preprocess + all Pegasus attempts must finish inside
  // the caller's window (Lambda passes remaining-time-minus-buffer).
  const budgetMs = options.maxPollWaitMs ?? 3_600_000;
  const hardDeadline = startMs + budgetMs;
  const remainingMs = () => hardDeadline - Date.now();

  const purposeKey =
    purpose === Purpose.EPISODE_RECAP ? "episode_recap" : "compact_video";
  const targetSeconds = resolveTargetSeconds(options, metadata.duration);

  console.log(
    `[Jockey] Phase 0: narrative brief (${purposeKey}, target≈${targetSeconds}s, budget ${Math.round(budgetMs / 1000)}s)`,
  );
  const { brief, source: briefSource } = await resolveBrief(
    options,
    purposeKey,
    targetSeconds,
  );

  let windowDurationSec =
    options.windowDurationSec ?? JOCKEY_WINDOW_DURATION_SEC;
  let overlapSec = options.overlapSec ?? JOCKEY_WINDOW_OVERLAP_SEC;
  let attempts = 0;
  let lastCoverageIssues: string[] = [];
  let proposed: ProposedSegment[] = [];
  let candidates: ProposedSegment[] = [];
  let selectionNotes: string[] = [];
  let taskIds: string[] = [];
  let windowFailureNote = "";

  while (attempts < 2) {
    attempts++;
    if (remainingMs() < 120_000) {
      if (attempts === 1) {
        throw new Error(
          "[Jockey] Not enough time budget remaining to run Pegasus phase",
        );
      }
      console.warn(
        "[Jockey] Skipping coverage retry — time budget nearly exhausted",
      );
      break;
    }

    console.log(
      `[Jockey] Phase 1–2: Pegasus windows (attempt ${attempts}, ${windowDurationSec}s windows, ${Math.round(remainingMs() / 1000)}s budget left)`,
    );

    const pegasusResult = await runJockeyPegasusPhase(twelvelabs, {
      ...options,
      targetSeconds,
      brief,
      windowDurationSec,
      overlapSec,
      deadline: remainingMs,
    });
    taskIds = pegasusResult.taskIds;
    if (pegasusResult.windowFailures > 0) {
      windowFailureNote = `${pegasusResult.windowFailures}/${pegasusResult.windowCount} Pegasus window(s) failed; continued with partial results`;
    }

    const merged = mergeChunkResults(
      pegasusResult.chunkResults,
      metadata.duration,
    );
    const processed = postProcessRows(
      merged,
      { ...options, targetSeconds, brief },
      transcript,
      metadata.duration,
    );
    proposed = processed.proposed;
    candidates = processed.candidates;
    selectionNotes = processed.selectionNotes;

    const coverage = checkTimelineCoverage(
      proposed,
      metadata.duration,
      purpose === Purpose.EPISODE_RECAP
        ? Purpose.EPISODE_RECAP
        : Purpose.COMPACT_VIDEO,
    );

    if (coverage.passed) {
      lastCoverageIssues = [];
      break;
    }

    lastCoverageIssues = coverage.issues;
    console.warn(
      `[Jockey] Coverage check failed (attempt ${attempts}): ${coverage.issues.join("; ")}`,
    );

    if (attempts < 2) {
      windowDurationSec = Math.max(5 * 60, Math.floor(windowDurationSec / 2));
      overlapSec = Math.max(30, Math.floor(overlapSec / 2));
      console.log(
        `[Jockey] Retrying with halved windows: ${windowDurationSec}s, overlap ${overlapSec}s`,
      );
    }
  }

  if (lastCoverageIssues.length > 0) {
    throw new Error(
      `[Jockey] Timeline coverage failed after ${attempts} attempt(s): ${lastCoverageIssues.join("; ")}`,
    );
  }

  // Phase 5: deterministic constraint enforcement (bounds, overlaps, target).
  const enforced = enforceConstraints(
    proposed,
    metadata,
    transcript,
    purpose,
    purpose === Purpose.COMPACT_VIDEO ? targetSeconds : undefined,
  );
  if (enforced.changes.length > 0) {
    selectionNotes.push(
      `Enforcer: ${enforced.changes.map((c) => c.detail).join("; ")}`,
    );
  }
  proposed = enforced.segments;

  // The enforcer's target trim can re-introduce timeline bias — backfill once
  // more from the candidate pool rather than shipping a lopsided compact.
  if (purpose === Purpose.COMPACT_VIDEO) {
    const postEnforce = checkTimelineCoverage(
      proposed,
      metadata.duration,
      Purpose.COMPACT_VIDEO,
    );
    if (!postEnforce.passed) {
      const refilled = backfillQuartileCoverage(
        candidates,
        proposed,
        metadata.duration,
      );
      if (refilled.length > proposed.length) {
        selectionNotes.push(
          `Post-enforcer quartile backfill: ${proposed.length} → ${refilled.length} segments`,
        );
        proposed = refilled;
      } else {
        console.warn(
          `[Jockey] Post-enforcer coverage degraded and no backfill candidates: ${postEnforce.issues.join("; ")}`,
        );
      }
    }
  }

  // Phase 5b: narrative titles + metadata — beat labels / transcript-derived,
  // never mechanical "(Part N)" suffixes from enforcer splits.
  proposed = applyNarrativeTitles(proposed, brief, transcript);

  const processingTime = Date.now() - startMs;
  const totalDuration = proposed.reduce(
    (sum, s) => sum + (s.endTime - s.startTime),
    0,
  );

  console.log(
    `[Jockey] Done in ${processingTime}ms — ${proposed.length} segments, ~${Math.round(totalDuration)}s`,
  );

  const taskSummary =
    taskIds.length === 1
      ? `task ${taskIds[0]}`
      : `${taskIds.length} window tasks`;

  return {
    segments: proposed,
    confidence: 0.9,
    notes: [
      `Jockey ${taskSummary}; ${briefSource} brief + windowed Pegasus.`,
      ...(windowFailureNote ? [windowFailureNote] : []),
      ...selectionNotes,
    ],
    attempts,
  };
}

export function isJockeyPipelineEnabled(): boolean {
  return process.env.JOCKEY_COMPACT_RECAP_ENABLED === "true";
}
