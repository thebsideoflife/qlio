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
  type VideoUnderstanding,
  type ProposedSegment,
  type CoverageReport,
  type SegmentContent,
} from "./types";

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
Quality Guidelines:
- Each segment should have a clear narrative purpose
- Titles should be compelling and descriptive
- Segments should flow naturally when viewed in sequence
- Prioritize emotional impact and narrative coherence over rigid timing
`;

// ============================================================================
// Purpose-Specific Planning Prompts
// ============================================================================

/**
 * Full Video: Split entire asset into microdrama chapters
 *
 * This takes a longer piece of content (e.g., 50 min) and intelligently
 * groups it into digestible chapters (e.g., 10 chapters of ~5 min each).
 */
function getFullVideoPrompt(
  understanding: VideoUnderstanding,
  targetSegmentMinutes: number
): string {
  const videoDurationSeconds = Math.round(understanding.duration);
  const videoDurationMinutes = Math.round(understanding.duration / 60);
  const expectedChapters = Math.ceil(
    videoDurationMinutes / targetSegmentMinutes
  );
  const targetSeconds = targetSegmentMinutes * 60;

  return `You are StoryIQ, an expert video editor reorganizing long-form content into bite-sized MICRODRAMA CHAPTERS for streaming consumption.

VIDEO UNDERSTANDING:
${formatUnderstandingCompact(understanding)}

YOUR TASK:
Take this ${videoDurationMinutes}-minute video and divide it into ${expectedChapters} chapters of approximately ${targetSegmentMinutes} minutes (~${targetSeconds} seconds) each.

Think of this like creating YouTube chapters or Netflix episode breaks - natural groupings that make a long piece of content easy to consume in short sessions.

CONSTRAINTS:
- Video is ${videoDurationSeconds} seconds total (timestamps must be 0 to ${videoDurationSeconds})
- Create exactly ${expectedChapters} chapters (give or take 1-2 based on natural breaks)
- Each chapter ~${targetSeconds} seconds (±60 seconds is fine for natural scene breaks)
- ALL content must be included - no gaps, no overlaps

CHAPTER REQUIREMENTS:
1. Find natural narrative break points (scene changes, topic shifts, dramatic beats)
2. Each chapter should have a compelling, descriptive title (like a YouTube chapter)
3. Titles should hint at the content without spoilers
4. Prefer ending chapters on cliffhangers or natural pauses

EXAMPLE for a 50-minute video with 5-minute chapters:
- Chapter 1: 0-300s "The Beginning" 
- Chapter 2: 300-600s "Rising Tension"
- ... (10 total chapters)
- Chapter 10: 2700-3000s "The Finale"

${QUALITY_GUIDELINES}
${OUTPUT_SCHEMA}`;
}

/**
 * C1.b - Highlights: Extract best moments with narrative flow
 */
function getHighlightsPrompt(
  understanding: VideoUnderstanding,
  targetDurationSeconds: number
): string {
  // Determine content style for format-aware guidance
  const isSerialFormat =
    understanding.genre?.toLowerCase().includes("reality") ||
    understanding.genre?.toLowerCase().includes("competition") ||
    understanding.logline?.toLowerCase().includes("island") ||
    understanding.logline?.toLowerCase().includes("contestants");

  const narrativeGuidance = isSerialFormat
    ? `This appears to be episodic/reality content. Focus on the key dramatic beats and character moments that define THIS episode. The viewer should understand what happened and why it matters.`
    : `This appears to be narrative/scripted content. Create a condensed story that has a beginning, middle, and end. The viewer should feel like they watched a complete mini-story, not just random clips.`;

  return `You are StoryIQ, an expert video editor creating a compelling HIGHLIGHTS REEL.

VIDEO UNDERSTANDING:
${formatUnderstandingCompact(understanding)}

TASK: Create a ${Math.round(
    targetDurationSeconds / 60
  )}-minute highlights package that tells a complete story.

${narrativeGuidance}

STRUCTURE YOUR HIGHLIGHTS LIKE A MINI-STORY:
1. HOOK (first 10-15s): Start with something that grabs attention and sets up the stakes
2. RISING ACTION: Build through key moments that escalate tension or interest  
3. CLIMAX: Include the biggest emotional peak or revelation
4. RESOLUTION: End with a satisfying conclusion or cliffhanger

Selection Criteria:
- Emotional peaks marked as "high" or "peak" intensity
- Moments that CONNECT to each other narratively (cause → effect)
- Character-defining scenes that show growth or conflict
- Visual spectacle and memorable dialogue

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
 * C2 - Trailer: Movie trailer structure
 */
function getTrailerPrompt(understanding: VideoUnderstanding): string {
  return `You are StoryIQ, creating a movie trailer that builds curiosity and excitement.

VIDEO UNDERSTANDING:
${formatUnderstandingCompact(understanding)}

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
  understanding: VideoUnderstanding,
  targetSeconds: number
): string {
  const is30s = targetSeconds >= 25;

  return `You are StoryIQ, creating a ${
    is30s ? "30" : "15"
  } second tune-in spot designed for conversion.

VIDEO UNDERSTANDING:
${formatUnderstandingCompact(understanding)}

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
  understanding: VideoUnderstanding,
  targetSeconds: number
): string {
  return `You are StoryIQ, creating a recap video that reactivates interest and teases what's ahead.

VIDEO UNDERSTANDING:
${formatUnderstandingCompact(understanding)}

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
  understanding: VideoUnderstanding,
  targetSeconds: number
): string {
  return `You are StoryIQ, creating a "Previously on..." episode recap.

VIDEO UNDERSTANDING:
${formatUnderstandingCompact(understanding)}

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
  understanding: VideoUnderstanding,
  targetSeconds: number
): string {
  return `You are StoryIQ, creating a comprehensive season recap.

VIDEO UNDERSTANDING:
${formatUnderstandingCompact(understanding)}

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
  understanding: VideoUnderstanding,
  targetSeconds: number
): string {
  return `You are StoryIQ, creating a social media clip optimized for retention and engagement.

VIDEO UNDERSTANDING:
${formatUnderstandingCompact(understanding)}

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

  return `You are reviewing your own segment selections. Be critical but fair.

PURPOSE: ${purpose}

YOUR PROPOSED SEGMENTS:
${segmentDetails}

COVERAGE REPORT:
- Total duration: ${Math.round(coverage.totalDuration)}s
- Target duration: ${
    coverage.targetDuration ? Math.round(coverage.targetDuration) + "s" : "N/A"
  }
${
  coverage.gaps?.length
    ? `- GAPS FOUND: ${coverage.gaps
        .map((g) => `${g.start}s-${g.end}s`)
        .join(", ")}`
    : "- No gaps"
}
- Emotional peaks covered: ${coverage.emotionalCoverage.peaksCovered}/${
    coverage.emotionalCoverage.peaksTotal
  }
${
  coverage.issues.length > 0
    ? `- ISSUES: ${coverage.issues.join("; ")}`
    : "- No issues detected"
}

EVALUATE:
1. Does each segment deliver on its title and reasoning?
2. For "${purpose}" purpose - are the selections appropriate?
3. Are there obvious improvements (better break points, missed peaks)?
4. Is the overall quality high enough?

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
  issues: string[],
  understanding: VideoUnderstanding,
  purpose: Purpose
): string {
  return `You are revising your segment selections based on identified issues.

ORIGINAL SEGMENTS:
${originalSegments
  .map((s) => `- "${s.title}" [${s.startTime}-${s.endTime}s]: ${s.reasoning}`)
  .join("\n")}

ISSUES TO FIX:
${issues.map((i) => `- ${i}`).join("\n")}

VIDEO UNDERSTANDING:
${formatUnderstandingCompact(understanding)}

PURPOSE: ${purpose}

Create revised segments that address these issues while maintaining quality.

${OUTPUT_SCHEMA}`;
}

// ============================================================================
// Prompt Selector
// ============================================================================

export interface PlanningPromptOptions {
  purpose: Purpose;
  understanding: VideoUnderstanding;
  targetDuration?: number;
  userInstructions?: string;
}

export function getPlanningPrompt(
  purpose: Purpose,
  understanding: VideoUnderstanding,
  targetDuration?: number,
  userInstructions?: string
): string {
  let basePrompt: string;

  switch (purpose) {
    case Purpose.FULL_VIDEO:
      // Default to 5 minute chapters for microdramas
      const segmentMinutes = targetDuration ? targetDuration / 60 : 5;
      basePrompt = getFullVideoPrompt(understanding, segmentMinutes);
      break;

    case Purpose.HIGHLIGHTS:
      // Default to 60 seconds
      const highlightSeconds = targetDuration || 60;
      basePrompt = getHighlightsPrompt(understanding, highlightSeconds);
      break;

    case Purpose.TRAILER:
      basePrompt = getTrailerPrompt(understanding);
      break;

    case Purpose.TUNEIN:
      // Default to 30 seconds
      const tuneInSeconds = targetDuration || 30;
      basePrompt = getTuneInPrompt(understanding, tuneInSeconds);
      break;

    case Purpose.BRIDGE:
      // Default to 90 seconds
      const bridgeSeconds = targetDuration || 90;
      basePrompt = getBridgePrompt(understanding, bridgeSeconds);
      break;

    case Purpose.EPISODE_RECAP:
      // Default to 60 seconds
      const episodeRecapSeconds = targetDuration || 60;
      basePrompt = getEpisodeRecapPrompt(understanding, episodeRecapSeconds);
      break;

    case Purpose.SEASON_RECAP:
      // Default to 3 minutes
      const seasonRecapSeconds = targetDuration || 180;
      basePrompt = getSeasonRecapPrompt(understanding, seasonRecapSeconds);
      break;

    case Purpose.SOCIAL_SEGMENT:
      // Default to 30 seconds
      const socialSeconds = targetDuration || 30;
      basePrompt = getSocialSegmentPrompt(understanding, socialSeconds);
      break;

    default:
      // Fallback to highlights
      basePrompt = getHighlightsPrompt(understanding, 60);
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
// Helper: Compact Understanding Format
// ============================================================================

function formatUnderstandingCompact(understanding: VideoUnderstanding): string {
  const parts: string[] = [];

  parts.push(`TITLE: ${understanding.title}`);
  parts.push(
    `DURATION: ${Math.round(understanding.duration)}s (${Math.round(
      understanding.duration / 60
    )} min)`
  );
  parts.push(`LOGLINE: ${understanding.logline}`);
  parts.push(
    `TONE: ${understanding.tone} | THEMES: ${understanding.themes.join(", ")}`
  );
  parts.push("");

  parts.push("SCENES:");
  for (const scene of understanding.scenes.slice(0, 30)) {
    const chars =
      scene.characters.length > 0 ? ` [${scene.characters.join(", ")}]` : "";
    parts.push(
      `  [${scene.startTime}-${scene.endTime}s] ${scene.location}${chars}`
    );
    parts.push(`    ${scene.description}`);
  }
  if (understanding.scenes.length > 30) {
    parts.push(`  ... and ${understanding.scenes.length - 30} more scenes`);
  }
  parts.push("");

  if (understanding.characters.length > 0) {
    parts.push("CHARACTERS:");
    for (const char of understanding.characters.slice(0, 10)) {
      parts.push(`  • ${char.name}: ${char.description}`);
    }
    parts.push("");
  }

  parts.push("EMOTIONAL ARC:");
  for (const beat of understanding.emotionalArc) {
    const marker =
      beat.intensity === "peak" ? "★★" : beat.intensity === "high" ? "★" : "•";
    parts.push(
      `  ${marker} [${beat.startTime}-${beat.endTime}s] ${beat.emotion} (${beat.intensity})`
    );
  }
  parts.push("");

  if (understanding.peakMoments.length > 0) {
    parts.push("PEAK MOMENTS (must-include candidates):");
    for (const peak of understanding.peakMoments.slice(0, 10)) {
      parts.push(`  ★ ${peak.timestamp}s: ${peak.reason}`);
    }
  }

  return parts.join("\n");
}
