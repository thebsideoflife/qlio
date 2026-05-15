/**
 * Sports Replay Detection
 *
 * Detects plays the broadcast replayed (slow-mo, multi-angle, super slo-mo)
 * and uses that as the primary signal for what's highlight-worthy.
 *
 * Key insight: Broadcast directors are professional highlight curators.
 * If they replayed it, it's important.
 *
 * Each Pegasus replay row becomes one exported highlight (no merging of angles).
 *
 * Metadata:
 * - original_play_* : Linked live-action span when we can match it (optional precision)
 * - replay_clip_* : The replay footage timestamps on the program timeline
 * - reason_replayed: What happened on the replay (title source)
 */

import type { TwelveLabs, TwelvelabsApi } from "twelvelabs-js";
import type { ProposedSegment, TranscriptSegment } from "./types";

// ============================================================================
// Types
// ============================================================================

export interface ReplayedPlay {
  /** Precise start of the original live action (seconds) — metadata only, not used as output clip */
  original_play_start: number;
  /** Precise end of the original live action (seconds) — metadata only */
  original_play_end: number;
  /** When replay coverage of this play begins on the timeline (same as replay_clip_start) */
  first_replay_at: number;
  /** **[Output]** Start of replay footage on the program timeline (this Pegasus row only) */
  replay_clip_start: number;
  /** **[Output]** End of replay footage on the program timeline */
  replay_clip_end: number;
  /** One Pegasus replay row → one play; kept for titles/reasoning text */
  num_angles_shown: number;
  /** Why it was replayed (e.g., "touchdown pass", "controversial call", "amazing catch") */
  reason_replayed: string;
  /** Length of replay footage on the timeline for this clip (seconds) */
  total_replay_duration: number;
  /** Excitement level inferred from replay treatment */
  importance: "critical" | "high" | "medium";
  /** Game context for intelligent padding decisions */
  game_context?: string;
  /** Players involved (for title generation) */
  players_involved?: string[];
  /** Whether bounds were precisely matched or estimated */
  bounds_source: "live_segment" | "estimated";
}

export interface ReplayDetectionResult {
  /** All detected replayed plays, sorted by original_play_at */
  replayed_plays: ReplayedPlay[];
  /** Total video duration analyzed */
  video_duration: number;
  /** Notes about detection process */
  detection_notes: string[];
}

// ============================================================================
// Pegasus Segment Definition for Replay Detection
// ============================================================================

/**
 * Segment definitions optimized for detecting replay sequences in sports broadcasts.
 *
 * Key fields:
 * - is_replay: Boolean for whether this is replay footage vs live action
 * - replay_type: slow_mo | multi_angle | super_slo_mo | standard_replay
 * - replay_of_timestamp: Approximate timestamp of the original action
 * - play_description: What happened in the play
 */
export function sportsReplayDetectionDefinitions(): TwelvelabsApi.SegmentDefinition[] {
  return [
    {
      id: "qlio_replay_detector",
      description:
        "Analyze this sports broadcast with FINE-GRAINED timeline segments. " +
        "Each segment is one contiguous shot: either LIVE GAME ACTION (real-time field/play) or REPLAY FOOTAGE " +
        "(slow motion, repeated angle, 'look at that again', super-slo close-up, same play from a new camera). " +
        "Replay segments must be tagged footage_type=replay and should typically be SHORT (often 5–30s per angle). " +
        "Live segments should not span multiple unrelated plays—break at stoppages and shot changes where possible. " +
        "For each replay segment, set original_play_timestamp to when the live action occurred on the clock (seconds earlier on the timeline).",
      fields: [
        {
          name: "footage_type",
          type: "string",
          description:
            "Whether this segment shows live action or replay footage.",
          enum: ["live_action", "replay"],
        },
        {
          name: "replay_type",
          type: "string",
          description:
            "If footage_type=replay: what kind of replay. slow_mo=slow motion, multi_angle=same play from different camera, super_slo_mo=extreme slow motion close-up, standard=normal speed replay.",
          enum: ["slow_mo", "multi_angle", "super_slo_mo", "standard", "n/a"],
        },
        {
          name: "original_play_timestamp",
          type: "number",
          description:
            "If footage_type=replay: approximate timestamp (in seconds) when the original live action occurred. Usually 5-60 seconds before the replay.",
        },
        {
          name: "play_description",
          type: "string",
          description:
            "The ACTION being shown (not a meta-description). " +
            "For replay footage: name the exciting play itself — 'Cole Young line drive to center', 'diving catch by Martinez', 'close play at second base'. " +
            "DO NOT say 'replay of X' or 'showing the X' — just describe the action directly. " +
            "For live action: describe the current play happening on the field.",
        },
        {
          name: "players_involved",
          type: "array",
          description:
            "Players prominently featured (names, jersey numbers, or roles like 'quarterback', 'goalkeeper').",
          items: { type: "string" },
        },
        {
          name: "game_context",
          type: "string",
          description:
            "Brief game situation context (e.g., '4th quarter, 2 min left', 'overtime', 'penalty shootout').",
        },
      ],
    },
  ];
}

/**
 * Extended definitions with generation-time guidance.
 */
export function sportsReplayDetectionDefinitionsForGeneration(opts: {
  userInstructions?: string;
  videoDurationSeconds: number;
}): TwelvelabsApi.SegmentDefinition[] {
  const defs = sportsReplayDetectionDefinitions();
  const d = defs[0];
  const parts: string[] = [];

  if (opts.userInstructions?.trim()) {
    parts.push(`Producer instructions: ${opts.userInstructions.trim()}`);
  }

  parts.push(
    "SEGMENT LENGTH: Prefer SHORT spans. Typical replay angle 5–25s; live shots between whistles 10–45s. " +
      "Split when camera angle, scene, or replay treatment changes; do not absorb multiple unrelated plays in one segment.",
    "CRITICAL: Accurately distinguish between LIVE ACTION and REPLAY footage. " +
      "Only mark segments as 'replay' when they show actual game action replays, NOT: players walking off, crowd shots, timeouts, breaks, commercials.",
    "Replay indicators: slow motion, instant replay graphics, same play from new angle, commentator saying 'let's see that again'.",
    "Live action indicators: real-time speed, game clock running, play-by-play commentary.",
    "For each replay, estimate when the original play happened (look back 5-60 seconds for the live version).",
    "play_description must describe THE ACTION (e.g. 'diving catch by Martinez') not meta-descriptions (e.g. 'replay of the catch'). This becomes the title.",
  );

  const suffix = parts.length ? ` ${parts.join(" ")}` : "";
  return [{ ...d, description: d.description + suffix }];
}

// ============================================================================
// Raw Pegasus Response Processing
// ============================================================================

export interface RawReplaySegment {
  start_time: number;
  end_time: number;
  footage_type: "live_action" | "replay";
  replay_type?: "slow_mo" | "multi_angle" | "super_slo_mo" | "standard" | "n/a";
  original_play_timestamp?: number;
  play_description: string;
  players_involved?: string[];
  game_context?: string;
}

/**
 * Parse Pegasus response into structured replay segments.
 */
export function parseReplayDetectionResponse(
  data: Record<string, unknown>,
): RawReplaySegment[] {
  const raw = data["qlio_replay_detector"];
  if (!Array.isArray(raw)) {
    throw new Error(
      `[ReplayDetection] Expected qlio_replay_detector array, got: ${Object.keys(data).join(", ")}`,
    );
  }

  return raw.map((row, i) => {
    if (!row || typeof row !== "object") {
      throw new Error(`[ReplayDetection] Invalid row ${i}`);
    }
    const r = row as Record<string, unknown>;
    const meta = (r.metadata || {}) as Record<string, unknown>;

    const start = Number(r.start_time);
    const end = Number(r.end_time);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(`[ReplayDetection] Row ${i}: bad start_time/end_time`);
    }

    const footageType = String(meta.footage_type || "live_action");
    const replayType = String(meta.replay_type || "n/a");
    const originalTs = meta.original_play_timestamp;
    const playDesc = String(meta.play_description || "Unknown play");
    const players = Array.isArray(meta.players_involved)
      ? meta.players_involved.map(String)
      : [];
    const gameCtx = String(meta.game_context || "");

    return {
      start_time: start,
      end_time: end,
      footage_type: footageType === "replay" ? "replay" : "live_action",
      replay_type:
        footageType === "replay"
          ? (replayType as RawReplaySegment["replay_type"])
          : undefined,
      original_play_timestamp:
        typeof originalTs === "number" ? originalTs : undefined,
      play_description: playDesc,
      players_involved: players,
      game_context: gameCtx,
    };
  });
}

// ============================================================================
// Link replay rows to live action (metadata only)
// ============================================================================

function estimatedOriginalPlayTime(seg: RawReplaySegment): number {
  return seg.original_play_timestamp ?? seg.start_time - 15;
}

/**
 * Find the live action segment closest to the replay's referenced original-play time.
 */
function findOriginalPlaySegment(
  targetTime: number,
  liveSegments: RawReplaySegment[],
): RawReplaySegment | null {

  // Find live segment that contains or is closest to the estimated original time
  let bestMatch: RawReplaySegment | null = null;
  let bestDistance = Infinity;

  for (const live of liveSegments) {
    // Check if target time falls within this segment
    if (targetTime >= live.start_time && targetTime <= live.end_time) {
      return live;
    }

    // Otherwise track closest
    const distStart = Math.abs(live.start_time - targetTime);
    const distEnd = Math.abs(live.end_time - targetTime);
    const dist = Math.min(distStart, distEnd);

    if (dist < bestDistance && dist < 30) {
      bestDistance = dist;
      bestMatch = live;
    }
  }

  return bestMatch;
}

// ============================================================================
// Main Detection Pipeline
// ============================================================================

/**
 * Process Pegasus segments to extract replayed plays.
 *
 * One `ReplayedPlay` per Pegasus replay row — each row is its own candidate highlight.
 */
export function extractReplayedPlays(
  segments: RawReplaySegment[],
  videoDuration: number,
): ReplayDetectionResult {
  const notes: string[] = [];

  // Separate live and replay segments
  const liveSegments = segments.filter((s) => s.footage_type === "live_action");
  const replaySegments = segments.filter((s) => s.footage_type === "replay");

  notes.push(
    `Detected ${liveSegments.length} live segments, ${replaySegments.length} replay segments`,
  );

  if (replaySegments.length === 0) {
    notes.push("No replay sequences detected");
    return {
      replayed_plays: [],
      video_duration: videoDuration,
      detection_notes: notes,
    };
  }

  const sortedReplay = [...replaySegments].sort((a, b) => a.start_time - b.start_time);
  notes.push(`${sortedReplay.length} replay segments (one highlight candidate each)`);

  const replayedPlays: ReplayedPlay[] = [];
  let preciseMatches = 0;
  let estimatedMatches = 0;

  for (const seg of sortedReplay) {
    const estimatedOriginal = estimatedOriginalPlayTime(seg);
    const originalSegment = findOriginalPlaySegment(estimatedOriginal, liveSegments);

    const totalReplayDuration = seg.end_time - seg.start_time;
    const rt = seg.replay_type;

    let importance: ReplayedPlay["importance"] = "medium";
    if (rt === "super_slo_mo" || totalReplayDuration >= 20) {
      importance = "critical";
    } else if (
      rt === "slow_mo" ||
      rt === "multi_angle" ||
      totalReplayDuration >= 10
    ) {
      importance = "high";
    }

    const reason =
      originalSegment?.play_description ||
      seg.play_description ||
      "Significant play";

    let playStart: number;
    let playEnd: number;
    let boundsSource: ReplayedPlay["bounds_source"];

    if (originalSegment) {
      playStart = originalSegment.start_time;
      playEnd = originalSegment.end_time;
      boundsSource = "live_segment";
      preciseMatches++;
    } else {
      const estimatedPlayDuration = 10;
      playStart = Math.max(0, estimatedOriginal - 2);
      playEnd = playStart + estimatedPlayDuration;
      boundsSource = "estimated";
      estimatedMatches++;
    }

    const allPlayers = [...(seg.players_involved || [])];
    if (originalSegment?.players_involved) {
      for (const p of originalSegment.players_involved) {
        if (!allPlayers.includes(p)) allPlayers.push(p);
      }
    }

    const gameContext =
      originalSegment?.game_context || seg.game_context || undefined;

    replayedPlays.push({
      original_play_start: playStart,
      original_play_end: playEnd,
      first_replay_at: seg.start_time,
      replay_clip_start: seg.start_time,
      replay_clip_end: seg.end_time,
      num_angles_shown: 1,
      reason_replayed: reason,
      total_replay_duration: totalReplayDuration,
      importance,
      game_context: gameContext,
      players_involved: allPlayers.length > 0 ? allPlayers : undefined,
      bounds_source: boundsSource,
    });
  }

  // Sort by original play time
  replayedPlays.sort((a, b) => a.original_play_start - b.original_play_start);

  notes.push(
    `Bounds: ${preciseMatches} precise (from live segments), ${estimatedMatches} estimated`,
  );

  // Log importance distribution
  const critical = replayedPlays.filter((p) => p.importance === "critical").length;
  const high = replayedPlays.filter((p) => p.importance === "high").length;
  const medium = replayedPlays.filter((p) => p.importance === "medium").length;
  notes.push(`Importance: ${critical} critical, ${high} high, ${medium} medium`);

  return {
    replayed_plays: replayedPlays,
    video_duration: videoDuration,
    detection_notes: notes,
  };
}

/**
 * Drop only degenerate clips (too short to be useful).
 */
export function filterKeyReplayedPlays(plays: ReplayedPlay[]): {
  kept: ReplayedPlay[];
  dropped: ReplayedPlay[];
} {
  const kept: ReplayedPlay[] = [];
  const dropped: ReplayedPlay[] = [];

  for (const p of plays) {
    const clipLen = p.replay_clip_end - p.replay_clip_start;
    if (clipLen < 1.5) {
      dropped.push(p);
    } else {
      kept.push(p);
    }
  }

  return { kept, dropped };
}

/** Max duration for one exported replay clip (snappy). */
export const REPLAY_CLIP_MAX_SEC = 32;

/**
 * Build editor segments from **replay footage time ranges only** (excludes live-action plays).
 * Each `ReplayedPlay` carries `replay_clip_start` / `replay_clip_end` from Pegasus replay rows.
 */
export function replayClipsToProposedSegments(
  plays: ReplayedPlay[],
  videoDuration: number,
  transcript: TranscriptSegment[],
  maxClipSec: number = REPLAY_CLIP_MAX_SEC,
): ProposedSegment[] {
  return plays.map((play, i) => {
    let startTime = play.replay_clip_start;
    let endTime = play.replay_clip_end;
    if (!(endTime > startTime)) {
      endTime = Math.min(videoDuration, startTime + 4);
    }
    if (endTime - startTime > maxClipSec) {
      endTime = startTime + maxClipSec;
    }

    startTime = Math.max(0, Math.round(startTime * 10) / 10);
    endTime = Math.min(videoDuration, Math.round(endTime * 10) / 10);

    const transcriptText = transcript
      .filter((t) => t.endTime > startTime && t.startTime < endTime)
      .map((t) => t.text.trim())
      .filter(Boolean)
      .join(" ")
      .slice(0, 500);

    return {
      startTime,
      endTime,
      title: generateSegmentTitle(play, i),
      reasoning: `${generateSegmentReasoning(play)} Output is replay-only footage on the broadcast timeline (not the original live play).`,
      expectedContent: transcriptText || play.reason_replayed,
    };
  });
}

// ============================================================================
// Segment Generation from Replayed Plays
// ============================================================================

/**
 * Generate intelligent segment titles from replay data.
 * Cleans up Pegasus descriptions to be action-focused titles.
 */
function generateSegmentTitle(play: ReplayedPlay, index: number): string {
  let title = play.reason_replayed.trim();

  // Strip meta-prefixes like "Replay of", "Showing the", etc.
  title = title
    .replace(/^(replay of|replaying|showing the|look at this|watch this|here's the)\s*/i, "")
    .replace(/^(the\s+)?/i, ""); // Remove leading "the"

  // Filter out boring/generic descriptions that aren't about game action
  const boringPatterns = [
    /players?\s+(walk|walking|leave|leaving|head|heading)\s+(off|to|toward)/i,
    /crowd\s+(cheering|reacting|celebrating)/i,
    /scoreboard/i,
    /commercial\s+break/i,
    /between\s+innings/i,
    /timeout/i,
    /break\s+in\s+action/i,
  ];

  const isBoring = boringPatterns.some((p) => p.test(title));

  // If we have a good action-focused title, use it
  if (!isBoring && title.length > 5 && title.length < 80) {
    // Capitalize first letter, remove trailing punctuation
    const cleaned = title.charAt(0).toUpperCase() + title.slice(1);
    return cleaned.replace(/[.!?]+$/, "");
  }

  // Try to use player names if available
  if (play.players_involved && play.players_involved.length > 0) {
    const player = play.players_involved[0];
    return `${player}'s Play`;
  }

  // Fallback to importance-based generic title
  const prefix =
    play.importance === "critical"
      ? "Key Play"
      : play.importance === "high"
        ? "Highlight"
        : "Play";
  return `${prefix} ${index + 1}`;
}

/**
 * Generate reasoning text for a segment.
 */
function generateSegmentReasoning(play: ReplayedPlay): string {
  const parts: string[] = [];

  parts.push(
    `Replay footage on broadcast timeline (~${Math.round(play.total_replay_duration)}s).`,
  );

  if (play.importance === "critical") {
    parts.push("Treatment (length or extreme slow-motion) suggests a major moment.");
  } else if (play.importance === "high") {
    parts.push("Replay treatment suggests a solid highlight.");
  }

  return parts.join(" ");
}

export interface ReplayToSegmentsOptions {
  /** Include replay footage in segment (extends endTime to include replays) */
  includeReplays?: boolean;
  /** Minimum segment duration — only extend if shorter than this */
  minDuration?: number;
  /** Maximum segment duration */
  maxDuration?: number;
  /** Transcript for expectedContent field */
  transcript?: TranscriptSegment[];
  /** Reduce lead/trail padding (shorter clips, ~10s-style moments) */
  tightSegmentBounds?: boolean;
}

/**
 * Calculate intelligent padding based on play context.
 *
 * Different plays need different amounts of lead-in/trail-out:
 * - Scoring plays: need reaction time after (celebration)
 * - Big plays (catches, runs): need setup before
 * - Controversial calls: need context before and reaction after
 * - Critical importance: more generous padding
 */
function calculatePadding(
  play: ReplayedPlay,
): { leadIn: number; trailOut: number } {
  const reason = play.reason_replayed.toLowerCase();
  const gameCtx = (play.game_context || "").toLowerCase();

  // Base padding depends on importance
  let leadIn = play.importance === "critical" ? 2.0 : 1.5;
  let trailOut = play.importance === "critical" ? 2.5 : 2.0;

  // Scoring plays need more trail-out for celebration/reaction
  if (
    reason.includes("touchdown") ||
    reason.includes("goal") ||
    reason.includes("score") ||
    reason.includes("basket") ||
    reason.includes("home run")
  ) {
    trailOut = Math.max(trailOut, 3.0);
  }

  // Setup-heavy plays need more lead-in
  if (
    reason.includes("catch") ||
    reason.includes("pass") ||
    reason.includes("throw") ||
    reason.includes("kick") ||
    reason.includes("shot")
  ) {
    leadIn = Math.max(leadIn, 2.0);
  }

  // Controversial plays need context
  if (
    reason.includes("controversial") ||
    reason.includes("call") ||
    reason.includes("review") ||
    reason.includes("challenge") ||
    reason.includes("foul") ||
    reason.includes("penalty")
  ) {
    leadIn = Math.max(leadIn, 2.5);
    trailOut = Math.max(trailOut, 3.0);
  }

  // High-pressure game situations need more context
  if (
    gameCtx.includes("overtime") ||
    gameCtx.includes("final") ||
    gameCtx.includes("last minute") ||
    gameCtx.includes("game winning") ||
    gameCtx.includes("tying")
  ) {
    leadIn += 1.0;
    trailOut += 1.0;
  }

  // Estimated bounds need more padding (less confidence)
  if (play.bounds_source === "estimated") {
    leadIn += 1.0;
    trailOut += 1.0;
  }

  return { leadIn, trailOut };
}

/**
 * Convert replayed plays into editor segments.
 *
 * Uses live-play bounds plus context padding; `tightSegmentBounds` shortens clips for sports highlights.
 */
export function replayedPlaysToSegments(
  plays: ReplayedPlay[],
  videoDuration: number,
  options: ReplayToSegmentsOptions = {},
): ProposedSegment[] {
  const {
    includeReplays = false,
    minDuration = 15,
    maxDuration = 120,
    tightSegmentBounds = false,
    transcript = [],
  } = options;

  const segments: ProposedSegment[] = [];

  for (let i = 0; i < plays.length; i++) {
    const play = plays[i];

    // Step 1: Get base bounds (precise from live segment or estimated)
    const baseStart = play.original_play_start;
    const baseEnd = play.original_play_end;

    // Step 2: Padding for context (smaller when tightSegmentBounds)
    let { leadIn, trailOut } = calculatePadding(play);
    if (tightSegmentBounds) {
      leadIn *= 0.45;
      trailOut *= 0.45;
    }

    // Step 3: Apply padding
    let startTime = baseStart - leadIn;
    let endTime = includeReplays
      ? play.first_replay_at + play.total_replay_duration + 1.0 // 1s buffer after replays
      : baseEnd + trailOut;

    // Step 4: Enforce duration constraints
    const duration = endTime - startTime;

    if (duration < minDuration) {
      // Extend to meet minimum, preferring to extend end (capture reaction)
      const needed = minDuration - duration;
      const extendEnd = Math.min(needed * 0.6, videoDuration - endTime);
      const extendStart = needed - extendEnd;
      startTime = Math.max(0, startTime - extendStart);
      endTime = Math.min(videoDuration, endTime + extendEnd);
    }

    if (endTime - startTime > maxDuration) {
      // Trim from end (keep the play start)
      endTime = startTime + maxDuration;
    }

    // Step 5: Final bounds check
    startTime = Math.max(0, Math.round(startTime * 10) / 10); // Round to 0.1s
    endTime = Math.min(videoDuration, Math.round(endTime * 10) / 10);

    // Get transcript snippet for expectedContent
    const transcriptText = transcript
      .filter((t) => t.endTime > startTime && t.startTime < endTime)
      .map((t) => t.text.trim())
      .filter(Boolean)
      .join(" ")
      .slice(0, 500);

    // Build reasoning with bounds info
    const boundsInfo = play.bounds_source === "live_segment"
      ? "Precise bounds from detected live segment."
      : "Bounds estimated from replay timing.";

    segments.push({
      startTime,
      endTime,
      title: generateSegmentTitle(play, i),
      reasoning: `${generateSegmentReasoning(play)} ${boundsInfo}`,
      expectedContent: transcriptText || play.reason_replayed,
    });
  }

  return segments;
}
