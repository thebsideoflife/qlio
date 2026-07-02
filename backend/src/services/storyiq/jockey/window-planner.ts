import type { NarrativeBrief, AnalysisWindow, StoryBeat } from "./types";

/** Virtual window size for long-form assets (>30 min). */
export const JOCKEY_WINDOW_DURATION_SEC = 10 * 60;
export const JOCKEY_WINDOW_OVERLAP_SEC = 60;
export const SINGLE_WINDOW_THRESHOLD_SEC = 30 * 60;

export interface PhysicalVideoContext {
  videoId: string;
  localDurationSec: number;
  physicalOffsetSec: number;
  chunkIndex: number;
}

function beatsInRange(
  brief: NarrativeBrief,
  globalStart: number,
  globalEnd: number,
): StoryBeat[] {
  const beats: StoryBeat[] = [];
  for (const arc of brief.arcs) {
    for (const beat of arc.beats) {
      const mid = (beat.approximateStartSec + beat.approximateEndSec) / 2;
      if (mid >= globalStart && mid < globalEnd) {
        beats.push(beat);
      }
    }
  }
  if (brief.recapBeats) {
    for (const beat of brief.recapBeats) {
      const mid = (beat.approximateStartSec + beat.approximateEndSec) / 2;
      if (mid >= globalStart && mid < globalEnd) {
        beats.push(beat);
      }
    }
  }
  return beats;
}

function arcNamesForRange(
  brief: NarrativeBrief,
  globalStart: number,
  globalEnd: number,
): string[] {
  const names = new Set<string>();
  for (const arc of brief.arcs) {
    for (const beat of arc.beats) {
      const mid = (beat.approximateStartSec + beat.approximateEndSec) / 2;
      if (mid >= globalStart && mid < globalEnd) {
        names.add(arc.name);
      }
    }
  }
  return [...names];
}

function alignWindowToBeats(
  localStart: number,
  localEnd: number,
  physicalOffset: number,
  beats: StoryBeat[],
  localDuration: number,
): { start: number; end: number } {
  let start = localStart;
  let end = localEnd;

  for (const beat of beats) {
    const globalMid =
      (beat.approximateStartSec + beat.approximateEndSec) / 2;
    const localMid = globalMid - physicalOffset;
    if (localMid < localStart || localMid > localEnd) continue;

    if (Math.abs(localMid - localStart) <= 30) {
      start = Math.max(0, Math.min(localMid - 5, localStart));
    }
    if (Math.abs(localMid - localEnd) <= 30) {
      end = Math.min(localDuration, Math.max(localMid + 5, localEnd));
    }
  }

  if (end - start < 60) {
    return { start: localStart, end: localEnd };
  }
  return { start, end };
}

function windowsForPhysicalChunk(
  physical: PhysicalVideoContext,
  brief: NarrativeBrief,
  totalDurationSec: number,
  windowDurationSec: number,
  overlapSec: number,
  singleWindowThresholdSec: number,
): AnalysisWindow[] {
  const { videoId, localDurationSec, physicalOffsetSec, chunkIndex } = physical;
  const windows: AnalysisWindow[] = [];
  let globalIndex = 0;

  const useSingleWindow =
    totalDurationSec <= singleWindowThresholdSec ||
    localDurationSec <= windowDurationSec;

  if (useSingleWindow) {
    const globalStart = physicalOffsetSec;
    const globalEnd = physicalOffsetSec + localDurationSec;
    windows.push({
      videoId,
      localStartSec: 0,
      localEndSec: localDurationSec,
      physicalOffsetSec,
      chunkIndex: chunkIndex * 1000 + globalIndex,
      arcNames: arcNamesForRange(brief, globalStart, globalEnd),
    });
    return windows;
  }

  let localStart = 0;
  while (localStart < localDurationSec - 30) {
    let localEnd = Math.min(localStart + windowDurationSec, localDurationSec);
    const globalStart = physicalOffsetSec + localStart;
    const globalEnd = physicalOffsetSec + localEnd;

    const nearbyBeats = beatsInRange(brief, globalStart, globalEnd);
    const aligned = alignWindowToBeats(
      localStart,
      localEnd,
      physicalOffsetSec,
      nearbyBeats,
      localDurationSec,
    );

    windows.push({
      videoId,
      localStartSec: aligned.start,
      localEndSec: aligned.end,
      physicalOffsetSec,
      chunkIndex: chunkIndex * 1000 + globalIndex,
      arcNames: arcNamesForRange(brief, globalStart, globalEnd),
    });

    if (localEnd >= localDurationSec) break;
    localStart = localStart + windowDurationSec - overlapSec;
    globalIndex++;
  }

  return windows;
}

/**
 * Normalize Pegasus row times to the original video timeline.
 * With segment_definitions.time_ranges, TwelveLabs may return either asset-absolute
 * or window-relative timestamps depending on window position.
 */
export function normalizeWindowRowTimes(
  row: { start_time: number; end_time: number; metadata: Record<string, unknown> },
  window: AnalysisWindow,
  videoDurationSec: number,
): { start_time: number; end_time: number; metadata: Record<string, unknown> } {
  const gStart = window.physicalOffsetSec + window.localStartSec;
  const gEnd = window.physicalOffsetSec + window.localEndSec;
  const winDur = window.localEndSec - window.localStartSec;
  let start = row.start_time;
  let end = row.end_time;
  const mid = (start + end) / 2;

  const inGlobal = mid >= gStart - 2 && mid <= gEnd + 2;
  const looksWindowRelative =
    !inGlobal && end <= winDur + 30 && start <= winDur + 30;

  if (looksWindowRelative) {
    start += window.physicalOffsetSec + window.localStartSec;
    end += window.physicalOffsetSec + window.localStartSec;
  } else if (!inGlobal && window.physicalOffsetSec > 0) {
    start += window.physicalOffsetSec;
    end += window.physicalOffsetSec;
  }

  start = Math.max(0, Math.min(start, videoDurationSec));
  end = Math.max(start + 1, Math.min(end, videoDurationSec));

  return { start_time: start, end_time: end, metadata: row.metadata };
}

/**
 * Plan analysis windows across physical chunks (indexed TwelveLabs assets).
 */
export function planAnalysisWindows(
  physicalChunks: PhysicalVideoContext[],
  brief: NarrativeBrief,
  totalDurationSec: number,
  options?: {
    windowDurationSec?: number;
    overlapSec?: number;
    purpose?: "compact_video" | "episode_recap";
  },
): AnalysisWindow[] {
  const windowDurationSec =
    options?.windowDurationSec ?? JOCKEY_WINDOW_DURATION_SEC;
  const overlapSec = options?.overlapSec ?? JOCKEY_WINDOW_OVERLAP_SEC;
  const singleWindowThresholdSec =
    options?.purpose === "episode_recap"
      ? 60 * 60
      : SINGLE_WINDOW_THRESHOLD_SEC;

  const all: AnalysisWindow[] = [];
  for (const physical of physicalChunks) {
    all.push(
      ...windowsForPhysicalChunk(
        physical,
        brief,
        totalDurationSec,
        windowDurationSec,
        overlapSec,
        singleWindowThresholdSec,
      ),
    );
  }

  console.log(
    `[Jockey] Planned ${all.length} analysis window(s) across ${physicalChunks.length} physical chunk(s)`,
  );
  return all;
}
