/**
 * StoryIQ Prompts
 *
 * All prompt templates for the StoryIQ agent.
 * Prompts are explicit, version-controlled, and testable.
 *
 * Each purpose has:
 * 1. A planning prompt (initial segment selection)
 * 2. A review prompt (self-verification)
 * 3. A revision prompt (fixing issues)
 */

import {
  Purpose,
  type VideoMetadata,
  type TranscriptSegment,
  type ProposedSegment,
  type CoverageReport,
  type SegmentContent,
  type SceneWithDialogue,
} from "./types";
import { type SceneBreak } from "../twelvelabs";

// ============================================================================
// Common Prompt Components
// ============================================================================

const OUTPUT_SCHEMA = `
Output strict JSON only. No markdown, no explanation.
Schema:
{
  "plan": [
    {
      "startTime": number (seconds),
      "endTime": number (seconds),
      "title": string (creative, compelling title),
      "reasoning": string (why this segment works),
      "expectedContent": string (what happens in this segment),
      "section": string (optional, for structured formats)
    }
  ]
}`;

const QUALITY_GUIDELINES = `
CRITICAL INSTRUCTIONS:
1. READ THE TRANSCRIPT CAREFULLY - it contains what is actually SAID in the video.
2. Scene breaks describe VISUALS which may differ from audio (e.g., opening credits 
   show scenes but play theme music - the AUDIO is music, not dialogue).
3. Base segment titles on what is SAID in the transcript at those timestamps.
4. Do NOT use external knowledge about this show. Only use the data provided.
5. SEGMENTS MUST NOT OVERLAP - each segment's startTime must be >= the previous segment's endTime.

Quality Guidelines:
- Each segment should have a clear narrative purpose
- Titles should be compelling and describe what's SAID, not just what's shown
- Segments should flow naturally when viewed in sequence
- Prioritize emotional impact and narrative coherence over rigid timing
`;

// ============================================================================
// Purpose-Specific Planning Prompts
// ============================================================================

/**
 * Full Video: Split entire asset into chapters
 *
 * This takes a longer piece of content (e.g., 50 min) and intelligently
 * divides it into chapters. Target 90s per chapter, prefer under 2 min, hard max 3 min.
 * ALL content is included - no gaps.
 */
function getFullVideoPrompt(
  metadata: VideoMetadata,
  transcript: TranscriptSegment[],
  targetChapterSeconds: number,
  sceneBreaks: SceneBreak[] | null
): string {
  const videoDurationSeconds = Math.round(metadata.duration);
  const videoDurationMinutes = Math.round(metadata.duration / 60);

  // Chapter constraints: 45-180 seconds (target 90s, prefer under 2 min, hard max 3 min)
  const minChapterSeconds = 45;
  const maxChapterSeconds = 180;

  // Estimate expected chapters based on target (default 90s = 1.5 min)
  const effectiveTarget = Math.max(
    minChapterSeconds,
    Math.min(maxChapterSeconds, targetChapterSeconds)
  );
  const expectedChapters = Math.ceil(videoDurationSeconds / effectiveTarget);

  // Try to group dialogue by scene for better context
  const groupedScenes = sceneBreaks
    ? groupDialogueByScene(sceneBreaks, transcript, metadata.duration)
    : null;

  // Use scene-grouped format if available, otherwise fall back to existing format
  const contextSection = groupedScenes
    ? formatScenesForPlanning(metadata, groupedScenes)
    : formatContextForPlanning(metadata, transcript, sceneBreaks);

  return `You are StoryIQ, an expert video editor dividing long-form content into chapters.

${contextSection}

YOUR TASK:
Divide this ${videoDurationMinutes}-minute video into chapters (like YouTube chapters).

CHAPTER LENGTH RULES:
- Target: ${effectiveTarget} seconds (~1.5 min)
- Preferred max: 2 minutes
- Hard max: 3 minutes (chapters over 3 min will be rejected)
- Minimum: ${minChapterSeconds} seconds
- Expected: ~${expectedChapters} chapters for this ${videoDurationSeconds}-second video
- ALL content must be included - no gaps, no overlaps
- First chapter starts at 0, last ends at ${videoDurationSeconds}

CHAPTER REQUIREMENTS:
1. Use scene breaks as boundaries when possible
2. If a scene runs long, split at a dialogue pause or natural beat in the transcript
3. Give each chapter a compelling, descriptive title
4. Prefer ending on cliffhangers or natural pauses

${QUALITY_GUIDELINES}
${OUTPUT_SCHEMA}`;
}

/**
 * C1.b - Highlights: Extract best moments with narrative flow
 */
function getHighlightsPrompt(
  metadata: VideoMetadata,
  transcript: TranscriptSegment[],
  targetDurationSeconds: number,
  sceneBreaks: SceneBreak[] | null
): string {
  // Try to group dialogue by scene for better context
  const groupedScenes = sceneBreaks
    ? groupDialogueByScene(sceneBreaks, transcript, metadata.duration)
    : null;

  // Use scene-grouped format if available, otherwise fall back to existing format
  const contextSection = groupedScenes
    ? formatScenesForPlanning(metadata, groupedScenes)
    : formatContextForPlanning(metadata, transcript, sceneBreaks);

  return `You are StoryIQ, an expert video editor creating a compelling HIGHLIGHTS REEL.

${contextSection}

TASK: Create a ${Math.round(
    targetDurationSeconds / 60
  )}-minute highlights package that tells a complete story.

STRUCTURE YOUR HIGHLIGHTS LIKE A MINI-STORY:
1. HOOK (first 10-15s): Start with something that grabs attention and sets up the stakes
2. RISING ACTION: Build through key moments that escalate tension or interest  
3. CLIMAX: Include the biggest emotional peak or revelation
4. RESOLUTION: End with a satisfying conclusion or cliffhanger

Selection Criteria:
- Read the transcript to identify emotional peaks in dialogue
- Moments that CONNECT to each other narratively (cause → effect)
- Character-defining scenes that show growth or conflict
- Memorable dialogue and dramatic moments

Requirements:
- MUST feel like a complete viewing experience, not choppy clips
- Transitions should feel natural (avoid jarring jumps in story)
- Each segment should build toward the next
- The ending should feel intentional, not abrupt
- You may exceed target by 20-30% if it completes the story better

Target: ~${Math.round(targetDurationSeconds / 60)} minutes

${QUALITY_GUIDELINES}
${OUTPUT_SCHEMA}`;
}

/**
 * Compact Video: Condense video to target percentage while maintaining narrative coherence.
 * Target 90s per segment, prefer under 2 min, hard max 3 min.
 * Viewer should be able to watch all segments in order and follow the story.
 */
function getCompactVideoPrompt(
  metadata: VideoMetadata,
  transcript: TranscriptSegment[],
  targetPercent: number,
  sceneBreaks: SceneBreak[] | null
): string {
  const targetSeconds = Math.round((metadata.duration * targetPercent) / 100);
  const targetMinutes = Math.round(targetSeconds / 60);
  const expectedSegments = Math.round(targetSeconds / 90); // ~1.5 min each

  // Try to group dialogue by scene for better context
  const groupedScenes = sceneBreaks
    ? groupDialogueByScene(sceneBreaks, transcript, metadata.duration)
    : null;

  // Use scene-grouped format if available, otherwise fall back to existing format
  const contextSection = groupedScenes
    ? formatScenesForPlanning(metadata, groupedScenes)
    : formatContextForPlanning(metadata, transcript, sceneBreaks);

  return `You are StoryIQ, an expert video editor creating a COMPACT VERSION of this video.

CRITICAL: You must SELECT the best ${targetPercent}% of the video, NOT chapter the whole thing.
Your job is to CUT ${
    100 - targetPercent
  }% OF THE CONTENT - keep only what earns its screen time.

ORIGINAL VIDEO: ${Math.round(metadata.duration / 60)} minutes (${Math.round(
    metadata.duration
  )}s)
TARGET OUTPUT: ${targetPercent}% = ~${targetMinutes} minutes (~${targetSeconds}s total)
SEGMENTS: Approximately ${expectedSegments} segments × ~90s each = ~${targetSeconds}s

MATH CHECK: Your segments MUST add up to approximately ${targetSeconds}s (within 15%).
If your segments total ${Math.round(
    metadata.duration
  )}s, you have NOT cut anything - this is WRONG.

SEGMENT LENGTH RULES:
- Target: 90 seconds (1.5 min) per segment
- Preferred max: 2 minutes
- Hard max: 3 minutes (segments over 3 min will be rejected)
- Minimum: 45 seconds

Segments must be chronological and tell a coherent story when watched in order.
There WILL BE GAPS between segments - that's the point of compacting.

WHAT TO KEEP:
- High-impact moments: emotional peaks, reveals, humor, tension
- Opening hook, major plot points, climax, resolution
- Key character moments that move the story forward

WHAT TO CUT:
- Slow pacing, redundant dialogue, scenes that repeat information
- Extended B-roll, low-energy filler, disconnected subplots
- Anything a viewer would skip through

${contextSection}

${QUALITY_GUIDELINES}
${OUTPUT_SCHEMA}`;
}

/**
 * C2 - Trailer: Movie trailer structure
 */
function getTrailerPrompt(
  metadata: VideoMetadata,
  transcript: TranscriptSegment[]
): string {
  return `You are StoryIQ, creating a movie trailer that builds curiosity and excitement.

${formatContextForPlanning(metadata, transcript, null)}

TASK: Create a 2-2.5 minute trailer following this structure:

1. BUMPER (0:00-0:05) - 5 seconds
   Hook to stop the skip. Sound byte or striking visual.
   
2. ACT I SETUP (0:05-0:45) - 40 seconds
   Establish the world. Introduce protagonist. Show "normal life" before disruption.
   
3. ACT II CONFLICT (0:45-1:40) - 55 seconds
   Reveal the stakes. Show the antagonist/conflict. Build tension.
   Include a "Drop" moment - sudden silence or tonal shift.
   
4. ACT III CLIMAX (1:40-2:15) - 35 seconds
   Rapid montage. Peak action/emotion. Maximum intensity.
   
5. OUTRO (2:15-2:30) - 15 seconds
   Title moment. Final stinger. Leave them wanting more.

Mark each segment with its section name in the "section" field.

${QUALITY_GUIDELINES}
${OUTPUT_SCHEMA}`;
}

/**
 * C3 - Tune-In: Short promotional spot
 */
function getTuneInPrompt(
  metadata: VideoMetadata,
  transcript: TranscriptSegment[],
  targetSeconds: number
): string {
  const is30s = targetSeconds >= 25;

  return `You are StoryIQ, creating a ${
    is30s ? "30" : "15"
  } second tune-in spot designed for conversion.

${formatContextForPlanning(metadata, transcript, null)}

TASK: Create a ${is30s ? "30" : "15"} second spot following this structure:

1. COLD OPEN (0:00-0:05) - 5 seconds
   High-impact visual. Provocative one-liner. Stop the scroll.
   
2. PREMISE (0:05-${is30s ? "0:20" : "0:10"}) - ${is30s ? "15" : "5"} seconds
   Fast-paced montage. Establish genre and conflict instantly.
   
3. SELL (${is30s ? "0:20-0:25" : "0:10-0:13"}) - ${is30s ? "5" : "3"} seconds
   Final escalation. Best joke or action peak. The hook.
   
4. END CARD (${is30s ? "0:25-0:30" : "0:13-0:15"}) - 5 seconds
   Logo moment. Clear call-to-action.

Mark each segment with its section name.

${QUALITY_GUIDELINES}
${OUTPUT_SCHEMA}`;
}

/**
 * C4 - Bridge: Recap & Tease
 */
function getBridgePrompt(
  metadata: VideoMetadata,
  transcript: TranscriptSegment[],
  targetSeconds: number
): string {
  return `You are StoryIQ, creating a recap video that reactivates interest and teases what's ahead.

${formatContextForPlanning(metadata, transcript, null)}

TASK: Create a ${Math.round(
    targetSeconds / 60
  )}-minute recap following this structure:

1. ANCHOR (first 15% of duration)
   The single most shocking or emotional moment. Puts viewer back in the moment.
   
2. ROAD SO FAR (next 35% of duration)
   Rapid chronological montage of key story beats. Remind of allies, enemies, stakes.
   
3. PIVOT (next 15% of duration)
   Transition moment showing consequence or aftermath. Music shifts darker.
   
4. FORWARD LOOK (next 25% of duration)
   Tease of what's coming (later content from this video). New tension revealed.
   
5. CALL TO ACTION (final 10% of duration)
   Title card moment. Clear direction on where/when to watch.

Mark each segment with its section name.

${QUALITY_GUIDELINES}
${OUTPUT_SCHEMA}`;
}

/**
 * C5 - Episode Recap: "Previously on..." style
 */
function getEpisodeRecapPrompt(
  metadata: VideoMetadata,
  transcript: TranscriptSegment[],
  targetSeconds: number
): string {
  return `You are StoryIQ, creating a "Previously on..." episode recap.

${formatContextForPlanning(metadata, transcript, null)}

TASK: Create a ${Math.round(
    targetSeconds
  )} second recap following this structure:

1. TRIGGER (0:00-0:03) - 3 seconds
   Opening beat. Mode switch signal.
   
2. DEEP CONTEXT (0:03-0:20) - 17 seconds
   Earlier content relevant to later payoffs. Subplot setup.
   
3. MOMENTUM (0:20-0:40) - 20 seconds
   Key beats from main storyline. The A-Plot progression.
   
4. SMOKING GUN (0:40-0:55) - 15 seconds
   Specific detail that will pay off. The setup for later revelation.
   
5. HARD OUT (0:55-1:00) - 5 seconds
   High-tension cliffhanger. Smash cut moment.

Mark each segment with its section name.

${QUALITY_GUIDELINES}
${OUTPUT_SCHEMA}`;
}

/**
 * C6 - Season Recap: Full season summary
 */
function getSeasonRecapPrompt(
  metadata: VideoMetadata,
  transcript: TranscriptSegment[],
  targetSeconds: number
): string {
  return `You are StoryIQ, creating a comprehensive season recap.

${formatContextForPlanning(metadata, transcript, null)}

TASK: Create a ${Math.round(
    targetSeconds / 60
  )} minute season recap following this structure:

1. RE-INTRODUCTION (first 15% of duration)
   Establish the world. Quick character portraits of main cast.
   
2. CATALYST (next 15% of duration)
   The inciting incident. What set the season in motion.
   
3. COMPLICATION (next 25% of duration)
   Middle act compression. Betrayals, setbacks, B-plot twists.
   
4. CLIMAX (next 20% of duration)
   The big battle/breakup/reveal. Season's peak moment.
   
5. FALLOUT (next 15% of duration)
   Who survived? New status quo. Board set for next season.
   
6. OUTRO (final 10% of duration)
   "Now Streaming" moment. Direct to content.

Mark each segment with its section name.

${QUALITY_GUIDELINES}
${OUTPUT_SCHEMA}`;
}

/**
 * C7 - Social Segment: Retention-optimized clip
 */
function getSocialSegmentPrompt(
  metadata: VideoMetadata,
  transcript: TranscriptSegment[],
  targetSeconds: number
): string {
  return `You are StoryIQ, creating a social media clip optimized for retention and engagement.

${formatContextForPlanning(metadata, transcript, null)}

TASK: Create a ${targetSeconds} second social clip following this structure:

1. THUMBSTOPPER (0:00-0:03) - 3 seconds
   Most arresting visual. NO fade-in. Immediate engagement.
   Text overlay moment (headline-worthy).
   
2. CONTEXT (0:03-0:10) - 7 seconds
   Compressed setup. Focus on faces. Dialogue starts immediately.
   
3. MEAT (0:10-0:${Math.round(targetSeconds * 0.7)}) - ${Math.round(
    targetSeconds * 0.5
  )} seconds
   The scene. Rapid cuts. Keep viewer from scrolling.
   
4. PAYOFF (0:${Math.round(targetSeconds * 0.7)}-0:${Math.round(
    targetSeconds * 0.9
  )}) - ${Math.round(targetSeconds * 0.2)} seconds
   The dopamine hit. Punchline, kiss, kill, or mic drop.
   
5. LOOP (final 5 seconds)
   Hard cut matching beginning. Enable seamless replay.

Mark each segment with its section name.

${QUALITY_GUIDELINES}
${OUTPUT_SCHEMA}`;
}

// ============================================================================
// Review & Revision Prompts
// ============================================================================

// Purpose descriptions for the reviewer
const PURPOSE_CONTEXT: Record<string, string> = {
  full_video: `Split the entire video into CHAPTERS. Target 90s per chapter, prefer under 2 min, max 3 min. ALL content must be covered with no gaps.`,
  compact_video: `Cut the fluff, keep what earns its screen time. Condense to target percentage with 90s segments (max 3 min). Chronological, coherent story.`,
  highlights: `Extract the BEST moments into a highlights reel. Target 90s segments, max 3 min. Should tell a mini-story with beginning, middle, end.`,
  trailer: `Create a 2-2.5 minute movie-style trailer with bumper, setup, conflict, climax, and outro sections.`,
  tunein: `Create a 15-30 second promotional spot designed for conversion.`,
  bridge: `Create a recap & tease bridge that reactivates interest.`,
  episode_recap: `Create a "Previously on..." style episode recap.`,
  season_recap: `Create a comprehensive season summary.`,
  social_segment: `Create a social media clip optimized for retention and engagement.`,
};

export function getReviewPrompt(
  segments: ProposedSegment[],
  segmentContent: SegmentContent[],
  coverage: CoverageReport,
  purpose: Purpose
): string {
  const segmentDetails = segments
    .map((seg, i) => {
      const content = segmentContent[i];
      return `
SEGMENT ${i + 1}: "${seg.title}"
  Time: ${seg.startTime}s - ${seg.endTime}s (${Math.round(
        seg.endTime - seg.startTime
      )}s)
  Section: ${seg.section || "N/A"}
  Your reasoning: ${seg.reasoning}
  
  ACTUAL CONTENT:
  ${content?.transcript?.substring(0, 500) || "No transcript available"}
  ${content?.sceneDescriptions?.[0]?.substring(0, 300) || ""}
`;
    })
    .join("\n---\n");

  const purposeDescription =
    PURPOSE_CONTEXT[purpose] || `Generate content for ${purpose} purpose.`;

  return `You are reviewing your own segment selections. Be critical but fair.

PURPOSE: ${purpose}
WHAT THIS MEANS: ${purposeDescription}

YOUR PROPOSED SEGMENTS:
${segmentDetails}

COVERAGE REPORT:
- Total duration: ${Math.round(coverage.totalDuration)}s
- Target total duration: ${
    coverage.targetDuration ? Math.round(coverage.targetDuration) + "s" : "N/A"
  }
${
  coverage.gaps?.length
    ? `- GAPS FOUND: ${coverage.gaps
        .map((g) => `${g.start}s-${g.end}s`)
        .join(", ")}`
    : "- No gaps"
}
${
  coverage.issues.length > 0
    ? `- ISSUES: ${coverage.issues.join("; ")}`
    : "- No issues detected"
}

EVALUATE:
1. Does the ACTUAL CONTENT match the segment title and reasoning?
2. Is the total duration within 15% of target?
3. Are the selections appropriate for the purpose?
4. Are there obvious improvements?

Output JSON:
{
  "needsRevision": boolean,
  "confidence": number (0-1),
  "issues": string[] (specific problems found),
  "suggestions": string[] (how to fix)
}`;
}

export function getRevisionPrompt(
  originalSegments: ProposedSegment[],
  segmentContent: SegmentContent[],
  issues: string[],
  metadata: VideoMetadata,
  transcript: TranscriptSegment[],
  purpose: Purpose
): string {
  // Check if there are duration-related issues
  const hasDurationIssues = issues.some(
    (i) =>
      i.includes("maximum") ||
      i.includes("minimum") ||
      i.includes("over") ||
      i.includes("under")
  );

  const durationReminder = hasDurationIssues
    ? `\nREMINDER: Target 90s, prefer under 2 min, hard max 3 min. Split long segments at natural breaks.\n`
    : "";

  // Format original segments with what the verifier saw
  const segmentDetails = originalSegments
    .map((s, i) => {
      const content = segmentContent[i];
      return `- "${s.title}" [${s.startTime}-${s.endTime}s] (${Math.round(
        s.endTime - s.startTime
      )}s)
    Reasoning: ${s.reasoning}
    Content: ${content?.transcript?.substring(0, 300) || "No transcript"}...`;
    })
    .join("\n\n");

  return `You are revising your segment selections based on identified issues.

ORIGINAL SEGMENTS (with content preview):
${segmentDetails}

ISSUES TO FIX:
${issues.map((i) => `- ${i}`).join("\n")}
${durationReminder}
FULL VIDEO CONTEXT:
${formatContextForPlanning(metadata, transcript, null)}

PURPOSE: ${purpose}

Create revised segments that address these issues while maintaining quality.
Use the full transcript above to find better alternatives.

${OUTPUT_SCHEMA}`;
}

// ============================================================================
// Prompt Selector
// ============================================================================

export interface PlanningPromptOptions {
  purpose: Purpose;
  metadata: VideoMetadata;
  transcript: TranscriptSegment[];
  sceneBreaks: SceneBreak[] | null;
  targetDuration?: number;
  targetPercent?: number;
  userInstructions?: string;
}

export function getPlanningPrompt(
  purpose: Purpose,
  metadata: VideoMetadata,
  transcript: TranscriptSegment[],
  sceneBreaks: SceneBreak[] | null,
  targetDuration?: number,
  userInstructions?: string,
  targetPercent?: number
): string {
  let basePrompt: string;

  switch (purpose) {
    case Purpose.FULL_VIDEO:
      // Default to 90 seconds (1.5 min) for chapters
      // Target range is 45-120 seconds per chapter (max 2 min)
      const chapterSeconds = targetDuration || 90;
      basePrompt = getFullVideoPrompt(
        metadata,
        transcript,
        chapterSeconds,
        sceneBreaks
      );
      break;

    case Purpose.COMPACT_VIDEO:
    case Purpose.HIGHLIGHTS:
      // Compact video: condense to target percentage
      // Default to 50% if not specified
      const percent = targetPercent || 50;
      basePrompt = getCompactVideoPrompt(
        metadata,
        transcript,
        percent,
        sceneBreaks
      );
      break;

    case Purpose.TRAILER:
      basePrompt = getTrailerPrompt(metadata, transcript);
      break;

    case Purpose.TUNEIN:
      // Default to 30 seconds
      const tuneInSeconds = targetDuration || 30;
      basePrompt = getTuneInPrompt(metadata, transcript, tuneInSeconds);
      break;

    case Purpose.BRIDGE:
      // Default to 90 seconds
      const bridgeSeconds = targetDuration || 90;
      basePrompt = getBridgePrompt(metadata, transcript, bridgeSeconds);
      break;

    case Purpose.EPISODE_RECAP:
      // Default to 60 seconds
      const episodeRecapSeconds = targetDuration || 60;
      basePrompt = getEpisodeRecapPrompt(
        metadata,
        transcript,
        episodeRecapSeconds
      );
      break;

    case Purpose.SEASON_RECAP:
      // Default to 3 minutes
      const seasonRecapSeconds = targetDuration || 180;
      basePrompt = getSeasonRecapPrompt(
        metadata,
        transcript,
        seasonRecapSeconds
      );
      break;

    case Purpose.SOCIAL_SEGMENT:
      // Default to 30 seconds
      const socialSeconds = targetDuration || 30;
      basePrompt = getSocialSegmentPrompt(metadata, transcript, socialSeconds);
      break;

    default:
      // Fallback to highlights
      basePrompt = getHighlightsPrompt(metadata, transcript, 60, sceneBreaks);
  }

  // Inject user instructions if provided
  if (userInstructions?.trim()) {
    return `${basePrompt}

---
USER INSTRUCTIONS (from the editor - incorporate these preferences):
${userInstructions.trim()}
---`;
  }

  return basePrompt;
}

// ============================================================================
// Helper: Format Context for Planning (includes transcript)
// ============================================================================

/**
 * Format video metadata, transcript, and scene breaks for planning prompts.
 * This is the primary context Claude uses to make segment decisions.
 */
function formatContextForPlanning(
  metadata: VideoMetadata,
  transcript: TranscriptSegment[],
  sceneBreaks: SceneBreak[] | null
): string {
  const parts: string[] = [];

  // Basic metadata
  parts.push(`TITLE: ${metadata.title}`);
  parts.push(
    `DURATION: ${Math.round(metadata.duration)}s (${Math.round(
      metadata.duration / 60
    )} min)`
  );
  parts.push("");

  // Scene breaks (if available)
  if (sceneBreaks && sceneBreaks.length > 0) {
    parts.push("SCENE BREAKS (what's visually happening):");
    for (const scene of sceneBreaks) {
      const mins = Math.floor(scene.time / 60);
      const secs = Math.floor(scene.time % 60);
      const timestamp = `${mins}:${String(secs).padStart(2, "0")}`;
      parts.push(
        `  ${timestamp} | ${scene.who} | ${scene.action} | ${scene.mood} | ${scene.audio}`
      );
    }
    parts.push("");
  }

  // Full transcript
  parts.push("TRANSCRIPT (what's being said):");
  for (const seg of transcript) {
    const mins = Math.floor(seg.startTime / 60);
    const secs = Math.floor(seg.startTime % 60);
    const timestamp = `${mins}:${String(secs).padStart(2, "0")}`;
    const speaker = seg.speaker ? `[${seg.speaker}] ` : "";
    parts.push(`  ${timestamp} ${speaker}${seg.text}`);
  }

  return parts.join("\n");
}

// ============================================================================
// Helper: Format Scenes with Grouped Dialogue
// ============================================================================

/**
 * Format timestamp as M:SS
 */
function formatTimestamp(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

/**
 * Group transcript dialogue into scenes.
 * Returns null if no scene breaks exist or if grouping fails.
 */
function groupDialogueByScene(
  sceneBreaks: SceneBreak[],
  transcript: TranscriptSegment[],
  videoDuration: number
): SceneWithDialogue[] | null {
  // Fallback if no scenes
  if (!sceneBreaks || sceneBreaks.length === 0) {
    return null;
  }

  try {
    // Sort scenes by time
    const sorted = [...sceneBreaks].sort((a, b) => a.time - b.time);

    return sorted.map((scene, i) => {
      const startTime = scene.time;
      const endTime =
        i < sorted.length - 1 ? sorted[i + 1].time : videoDuration;

      // Get transcript segments that START within this scene (no duplicates across scenes)
      const dialogue = transcript.filter(
        (t) => t.startTime >= startTime && t.startTime < endTime
      );

      const allText = dialogue.map((d) => d.text).join(" ");

      return {
        sceneIndex: i + 1,
        startTime,
        endTime,
        who: scene.who,
        action: scene.action,
        mood: scene.mood,
        audio: scene.audio,
        dialogue,
        wordCount: allText.split(/\s+/).filter((w) => w).length,
      };
    });
  } catch (error) {
    console.error("[StoryIQ] Failed to group dialogue by scene:", error);
    return null; // Fallback to existing format
  }
}

/**
 * Format grouped scenes for planning prompts.
 * Concatenates all dialogue into a single text block per scene for token efficiency.
 */
function formatScenesForPlanning(
  metadata: VideoMetadata,
  scenes: SceneWithDialogue[]
): string {
  const parts: string[] = [];

  parts.push(`TITLE: ${metadata.title}`);
  parts.push(
    `DURATION: ${Math.round(metadata.duration)}s (${Math.round(
      metadata.duration / 60
    )} min)`
  );
  parts.push(`SCENES: ${scenes.length} total`);
  parts.push("");
  parts.push(
    "NOTE: Cut at scene boundaries for clean visual transitions. Scene times are your primary cut points."
  );
  parts.push("");

  for (const scene of scenes) {
    const startTs = formatTimestamp(scene.startTime);
    const endTs = formatTimestamp(scene.endTime);
    const duration = Math.round(scene.endTime - scene.startTime);

    parts.push(
      `--- Scene ${scene.sceneIndex} (${startTs} - ${endTs}) | ${duration}s ---`
    );
    parts.push(
      `Visual: ${scene.who} | ${scene.action} | ${scene.mood} | ${scene.audio}`
    );

    if (scene.dialogue.length > 0) {
      // Concatenate all dialogue into one text block (much more token-efficient)
      const dialogueText = scene.dialogue.map((d) => d.text).join(" ");
      parts.push(`Dialogue: ${dialogueText}`);
    } else {
      parts.push("Dialogue: (none - visual/music only)");
    }
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * Format scene breaks as a list for prompts that need just scene info.
 */
function formatSceneBreaks(sceneBreaks: SceneBreak[] | null): string {
  if (!sceneBreaks || sceneBreaks.length === 0) {
    return "  No scene breaks detected - use your judgment based on the transcript";
  }

  return sceneBreaks
    .map((s) => {
      const mins = Math.floor(s.time / 60);
      const secs = Math.floor(s.time % 60);
      return `  ${mins}:${String(secs).padStart(2, "0")} | ${s.who} | ${
        s.action
      } | ${s.mood}`;
    })
    .join("\n");
}
