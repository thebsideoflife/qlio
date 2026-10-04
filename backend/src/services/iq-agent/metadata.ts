/**
 * Delivery metadata, written as part of finishing an agent run.
 *
 * This is a deterministic post-run step, not a tool the model can decide to
 * skip — the same shape as autoframing. It runs after the cut is committed and
 * before the run is released, so by the time a run reports `completed` the
 * Export panel already has descriptions, tags, IAB categories and thumbnails.
 *
 * Three rules hold everywhere in this file:
 *
 * 1. **It never fails the run.** Every failure path degrades to writing less
 *    metadata. The cut is the deliverable; metadata is a bonus this step tries
 *    to get right while the run still has all its context.
 * 2. **Whatever it does not write stays detectably missing.** Entries are
 *    written per segment against the same fingerprint the Export pipeline uses,
 *    so anything skipped here is picked up by the Pegasus fallback unchanged.
 * 3. **It respects the invocation deadline.** Running out of clock means
 *    stopping cleanly with partial results, never being killed mid-write.
 */

import {
  computeSegmentMetadataFingerprint,
  isSegmentMetadataIncomplete,
  mergeSegmentMetadataEntry,
  normalizeContentAdvisory,
  pruneSegmentMetadata,
  segmentThumbnailTimestamp,
  type ExportMetadataOptions,
} from "../export-metadata";
import {
  iabAllowlistPromptBlock,
  iabHasTopic,
  normalizeIabTags,
} from "../iab-content-taxonomy";
import {
  computeProjectThumbnailFingerprint,
  ensureProjectCoverThumbnail,
} from "../project-thumbnails";
import type { StoredSegmentMetadata } from "../../types/segment-metadata";
import { mapWithConcurrency } from "../../utils/concurrency";
import { extractFrameToS3 } from "../../utils/thumbnailExtract";
import {
  callClaude,
  errorText,
  type ClaudeMessage,
  type ClaudeUsage,
} from "./claude";
import { MODEL_TEMPERATURE } from "./config";
import { fmtTimecode } from "./ledger";
import {
  readProjectMetadataState,
  writeProjectSegmentMetadata,
} from "./project";
import { METADATA_SYSTEM, METADATA_TASK } from "./prompts";
import type { ToolSchema } from "./tools";
import {
  groupWordsIntoLines,
  wordsInRange,
  type TranscriptWord,
} from "./tools/transcript";
import type { AgentSegment, Brief, VideoFacts } from "./types";

/**
 * What the agent path claims to produce. Also the yardstick for "is this
 * segment's metadata complete", so it must stay in step with what the tool
 * schema below actually asks for.
 */
export const AGENT_METADATA_OPTIONS: ExportMetadataOptions & {
  includeThumbnails: boolean;
} = {
  includeDescriptions: true,
  descriptionLengths: ["short", "two_sentences", "paragraph"],
  descriptiveTags: {
    contentAdvisory: true,
    mood: true,
    theme: true,
    tone: true,
  },
  includeIab: true,
  iabFields: { formFactor: true, genres: true, topics: true },
  includeThumbnails: true,
};

/** Segments per model call. Sized so a batch's output fits well inside the cap. */
const SEGMENTS_PER_CALL = 8;
const MAX_OUTPUT_TOKENS = 8192;
const THUMBNAIL_CONCURRENCY = 3;

/** Dialogue handed to the model per segment. Enough to place a scene, not a dump. */
const TRANSCRIPT_CHARS_PER_SEGMENT = 900;

/** Don't start another model call without at least this much clock left. */
const MODEL_CALL_RESERVE_MS = 75_000;
/** Don't start thumbnail extraction without at least this much clock left. */
const THUMBNAIL_RESERVE_MS = 45_000;

/** Above this, the short description is prose rather than a headline. */
const SHORT_DESCRIPTION_WORD_CAP = 12;
/** Mood/theme/tone are token lists, not sentences. */
const MAX_TAG_TOKENS = 3;

const WRITE_METADATA_TOOL: ToolSchema = {
  name: "write_segment_metadata",
  description:
    "Record delivery metadata for the finished cut. One entry per scene you were given, using the exact scene_id.",
  input_schema: {
    type: "object",
    properties: {
      scenes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            scene_id: {
              type: "string",
              description: "The scene_id exactly as given to you.",
            },
            description_short: {
              type: "string",
              description:
                "Ten words or fewer. What happens on screen in this scene. No title case, no trailing period needed.",
            },
            description_two_sentences: {
              type: "string",
              description:
                "Exactly two sentences: what happens, and why it matters in the piece.",
            },
            description_paragraph: {
              type: "string",
              description:
                "Three to five sentences with the surrounding context and the emotional beat.",
            },
            mood: {
              type: "string",
              description:
                "Two or three comma-separated single words for the felt emotion, e.g. 'warm, nostalgic'. Not a sentence.",
            },
            theme: {
              type: "string",
              description:
                "Two or three comma-separated short noun phrases for what the scene is about, e.g. 'tradition, family'. Not a sentence.",
            },
            tone: {
              type: "string",
              description:
                "Two or three comma-separated single words for the register, e.g. 'wry, reflective'. Not a sentence.",
            },
            content_advisory: {
              type: "string",
              description:
                "Comma-separated advisory tokens that actually apply, e.g. 'mild language, alcohol'. Empty string when nothing applies. Never 'none'.",
            },
            iab_cat: {
              type: "array",
              items: { type: "string" },
              description:
                "IAB Content Taxonomy 3.0 IDs from the supplied lists only.",
            },
          },
          required: [
            "scene_id",
            "description_short",
            "description_two_sentences",
            "description_paragraph",
            "mood",
            "theme",
            "tone",
            "content_advisory",
            "iab_cat",
          ],
        },
      },
    },
    required: ["scenes"],
  },
};

export interface FinalizeMetadataResult {
  /** Segments that were missing complete metadata when the pass started. */
  targeted: number;
  /** Segments whose metadata row was written or updated. */
  written: number;
  /** Segments left for the Export fallback (out of time, or the model failed). */
  incomplete: number;
  thumbnails: number;
  coverThumbnail: boolean;
  /** One line for the activity log. Always safe to show a producer. */
  note: string;
}

export interface FinalizeMetadataParams {
  projectId: string;
  facts: VideoFacts;
  brief?: Brief;
  /** The committed cut. Metadata rows are keyed to these ids and bounds. */
  segments: AgentSegment[];
  transcriptWords: TranscriptWord[] | null;
  bucketName?: string;
  projectsTable?: string;
  /** Epoch-ms ceiling for the whole pass. */
  deadlineAt: number;
  onProgress?: (note: string) => void;
  /**
   * Called after every model call. These tokens are spent on the producer's
   * behalf during the run, so they belong in the run's cost, not off the books.
   */
  onUsage?: (usage: ClaudeUsage) => void;
}

export async function finalizeDeliveryMetadata(
  params: FinalizeMetadataParams,
): Promise<FinalizeMetadataResult> {
  const { projectId, segments, deadlineAt } = params;

  const empty: FinalizeMetadataResult = {
    targeted: 0,
    written: 0,
    incomplete: 0,
    thumbnails: 0,
    coverThumbnail: false,
    note: "No scenes to describe.",
  };

  if (segments.length === 0) return empty;

  const state = await readProjectMetadataState(projectId);
  const validIds = new Set(segments.map((s) => s.id));
  const existing = pruneSegmentMetadata(state.segmentMetadata, validIds);
  const existingById = new Map(existing.map((e) => [e.segmentId, e]));

  const targets = segments.filter((seg) =>
    isSegmentMetadataIncomplete(
      existingById.get(seg.id),
      seg.startTime,
      seg.endTime,
      AGENT_METADATA_OPTIONS,
    ),
  );

  if (targets.length === 0) {
    // Bounds can still have moved under a cover frame that is otherwise fine.
    const cover = await ensureCover(params, state);
    return {
      ...empty,
      coverThumbnail: cover,
      note: "Delivery metadata was already up to date.",
    };
  }

  params.onProgress?.(
    `Writing delivery metadata for ${targets.length} scene${targets.length === 1 ? "" : "s"}…`,
  );

  const generated = await generateAll(params, targets);

  // Thumbnails are independent of the model: a scene whose description failed
  // should still get its frame, and a scene the model described should not lose
  // its description because FFmpeg fell over.
  const thumbnails = await extractThumbnails(params, targets);

  const now = new Date().toISOString();
  const updates: StoredSegmentMetadata[] = [];

  for (const seg of targets) {
    const parsed = generated.get(seg.id);
    const thumbnailKey = thumbnails.get(seg.id);
    if (!parsed && !thumbnailKey) continue;

    const contentHash = computeSegmentMetadataFingerprint(
      seg.startTime,
      seg.endTime,
    );
    const previous = existingById.get(seg.id);
    // A row whose bounds moved is a different scene now; merging the old copy
    // back in would resurrect a description of footage that is no longer there.
    const mergeBase = previous?.contentHash === contentHash ? previous : undefined;

    updates.push(
      mergeSegmentMetadataEntry(mergeBase, {
        segmentId: seg.id,
        contentHash,
        descriptions: parsed?.descriptions,
        tags: parsed?.tags,
        ...(thumbnailKey ? { thumbnailKey } : {}),
        generatedAt: now,
      }),
    );
  }

  let written = 0;
  if (updates.length > 0) {
    // Re-read immediately before writing: a fallback job that started before
    // this run did could have landed rows in between, and this write replaces
    // the whole list.
    const fresh = await readProjectMetadataState(projectId).catch(() => state);
    const merged = new Map(
      pruneSegmentMetadata(fresh.segmentMetadata, validIds).map((e) => [
        e.segmentId,
        e,
      ]),
    );
    for (const update of updates) {
      const base =
        merged.get(update.segmentId)?.contentHash === update.contentHash
          ? merged.get(update.segmentId)
          : undefined;
      merged.set(update.segmentId, mergeSegmentMetadataEntry(base, update));
    }
    await writeProjectSegmentMetadata(projectId, Array.from(merged.values()));
    written = updates.length;
  }

  const coverThumbnail = await ensureCover(params, state);

  const incomplete = targets.filter((seg) => {
    const entry = updates.find((u) => u.segmentId === seg.id);
    return isSegmentMetadataIncomplete(
      entry,
      seg.startTime,
      seg.endTime,
      AGENT_METADATA_OPTIONS,
    );
  }).length;

  const outOfTime = Date.now() >= deadlineAt;

  return {
    targeted: targets.length,
    written,
    incomplete,
    thumbnails: thumbnails.size,
    coverThumbnail,
    note: buildNote({
      targeted: targets.length,
      written,
      incomplete,
      outOfTime,
    }),
  };
}

function buildNote(params: {
  targeted: number;
  written: number;
  incomplete: number;
  outOfTime: boolean;
}): string {
  const { targeted, written, incomplete, outOfTime } = params;
  const done = written - incomplete;
  if (done <= 0) {
    return outOfTime
      ? "Ran out of time writing delivery metadata — Export will fill it in."
      : "Delivery metadata could not be written this run — Export will fill it in.";
  }
  const base = `Wrote delivery metadata for ${done} of ${targeted} scene${targeted === 1 ? "" : "s"}.`;
  if (incomplete === 0) return base;
  return `${base} Export will fill in the remaining ${incomplete}.`;
}

// ============================================================================
// Model pass
// ============================================================================

export interface ParsedEntry {
  descriptions: {
    short: string;
    two_sentences: string;
    paragraph: string;
  };
  tags: {
    content_advisory: string;
    mood: string;
    theme: string;
    tone: string;
    iab?: NonNullable<StoredSegmentMetadata["tags"]>["iab"];
  };
}

async function generateAll(
  params: FinalizeMetadataParams,
  targets: AgentSegment[],
): Promise<Map<string, ParsedEntry>> {
  const out = new Map<string, ParsedEntry>();

  for (let i = 0; i < targets.length; i += SEGMENTS_PER_CALL) {
    if (Date.now() + MODEL_CALL_RESERVE_MS > params.deadlineAt) {
      console.warn(
        `[IQAgent] metadata: out of time after ${out.size}/${targets.length} scenes`,
      );
      break;
    }
    const batch = targets.slice(i, i + SEGMENTS_PER_CALL);
    const parsed = await runBatch(params, batch, false);
    for (const [id, entry] of parsed) out.set(id, entry);
  }

  // One corrective pass, and only one: a second failure means the model is not
  // going to get there and the fallback is a better use of the producer's time.
  const retryTargets = targets.filter((seg) => {
    const entry = out.get(seg.id);
    return !entry || describeShortfall(entry).length > 0;
  });

  for (let i = 0; i < retryTargets.length; i += SEGMENTS_PER_CALL) {
    if (Date.now() + MODEL_CALL_RESERVE_MS > params.deadlineAt) break;
    const batch = retryTargets.slice(i, i + SEGMENTS_PER_CALL);
    const parsed = await runBatch(params, batch, true);
    for (const [id, entry] of parsed) {
      // Keep the better of the two attempts rather than trusting the retry
      // blindly — a retry can come back worse than what it was fixing.
      const previous = out.get(id);
      if (!previous || describeShortfall(entry).length <= describeShortfall(previous).length) {
        out.set(id, entry);
      }
    }
  }

  return out;
}

async function runBatch(
  params: FinalizeMetadataParams,
  batch: AgentSegment[],
  isRetry: boolean,
): Promise<Map<string, ParsedEntry>> {
  const out = new Map<string, ParsedEntry>();
  if (batch.length === 0) return out;

  try {
    const response = await callClaude({
      system: [{ type: "text", text: METADATA_SYSTEM }],
      messages: buildMessages(params, batch, isRetry),
      tools: [WRITE_METADATA_TOOL],
      // Sent as `auto` to Sonnet 5.5, which rejects forced tool use. The task
      // prompt asks for the call, and a batch that comes back without one is
      // caught by the retry pass like any other incomplete answer.
      toolChoice: { type: "tool", name: WRITE_METADATA_TOOL.name },
      maxTokens: MAX_OUTPUT_TOKENS,
      temperature: MODEL_TEMPERATURE,
      deadlineAt: params.deadlineAt,
    });

    params.onUsage?.(response.usage);

    const call = response.blocks.find(
      (b) =>
        (b as { type?: string }).type === "tool_use" &&
        (b as { name?: string }).name === WRITE_METADATA_TOOL.name,
    ) as { input?: Record<string, unknown> } | undefined;

    const scenes = Array.isArray(call?.input?.scenes)
      ? (call!.input!.scenes as unknown[])
      : [];

    const allowed = new Set(batch.map((s) => s.id));
    for (const raw of scenes) {
      const row = (raw ?? {}) as Record<string, unknown>;
      const id = typeof row.scene_id === "string" ? row.scene_id.trim() : "";
      // Ignore ids the model invented: writing them would create metadata rows
      // for scenes that do not exist.
      if (!allowed.has(id) || out.has(id)) continue;
      const entry = parseEntry(row);
      if (entry) out.set(id, entry);
    }
  } catch (err) {
    console.warn(
      `[IQAgent] metadata batch of ${batch.length} failed${isRetry ? " (retry)" : ""}: ${errorText(err)}`,
    );
  }

  return out;
}

function buildMessages(
  params: FinalizeMetadataParams,
  batch: AgentSegment[],
  isRetry: boolean,
): ClaudeMessage[] {
  const { facts, brief } = params;

  const header = [
    `Source video: ${facts.title} (${facts.duration.toFixed(0)}s).`,
    brief?.format ? `Format: ${brief.format}.` : "",
    brief?.platform ? `Distribution: ${brief.platform}.` : "",
    brief?.userPrompt?.trim()
      ? `Producer instructions for the cut: ${brief.userPrompt.trim()}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  const scenes = batch
    .map((seg, index) => renderScene(params, seg, index + 1))
    .join("\n\n");

  const retryNote = isRetry
    ? "\n\nYour previous answer for these scenes was incomplete or off-spec. Re-do them and follow every rule exactly — especially the ten-word cap on description_short, the token-list format for mood/theme/tone, and picking at least one Topic ID."
    : "";

  const text = [
    header,
    "",
    METADATA_TASK,
    "",
    iabAllowlistPromptBlock(AGENT_METADATA_OPTIONS.iabFields),
    "",
    `Scenes (${batch.length}):`,
    scenes,
    retryNote,
  ].join("\n");

  return [{ role: "user", content: [{ type: "text", text }] }];
}

function renderScene(
  params: FinalizeMetadataParams,
  seg: AgentSegment,
  ordinal: number,
): string {
  const lines = [
    `### Scene ${ordinal}`,
    `scene_id: ${seg.id}`,
    `runs ${fmtTimecode(seg.startTime)}–${fmtTimecode(seg.endTime)} (${(seg.endTime - seg.startTime).toFixed(0)}s)`,
    `editorial title: ${seg.title || "(untitled)"}`,
  ];
  if (seg.description?.trim()) {
    lines.push(`why it was cut: ${seg.description.trim()}`);
  }
  const dialogue = renderDialogue(params.transcriptWords, seg);
  lines.push(dialogue ? `dialogue:\n${dialogue}` : "dialogue: (none on record)");
  return lines.join("\n");
}

function renderDialogue(
  words: TranscriptWord[] | null,
  seg: AgentSegment,
): string {
  if (!words || words.length === 0) return "";
  const lines = groupWordsIntoLines(wordsInRange(words, seg.startTime, seg.endTime));
  if (lines.length === 0) return "";

  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    if (used + text.length > TRANSCRIPT_CHARS_PER_SEGMENT) {
      out.push("…");
      break;
    }
    out.push(text);
    used += text.length + 1;
  }
  return out.join(" ");
}

// ============================================================================
// Parsing and validation
// ============================================================================

function parseEntry(row: Record<string, unknown>): ParsedEntry | null {
  const short = cleanText(row.description_short);
  const two = cleanText(row.description_two_sentences);
  const paragraph = cleanText(row.description_paragraph);

  // A row with no usable prose at all is noise; leaving it out keeps the
  // segment detectably incomplete so the fallback picks it up.
  if (!short && !two && !paragraph) return null;

  const advisory = cleanText(row.content_advisory);
  const iab = normalizeIabTags(
    row.iab_cat,
    undefined,
    AGENT_METADATA_OPTIONS.iabFields,
  );

  return {
    descriptions: {
      short,
      two_sentences: two,
      paragraph,
    },
    tags: {
      // Empty string is meaningful here: it records "checked, nothing applies"
      // and stops the Export panel re-requesting the field forever.
      content_advisory: normalizeContentAdvisory(advisory) ?? "",
      mood: tokenList(row.mood),
      theme: tokenList(row.theme),
      tone: tokenList(row.tone),
      ...(iab ? { iab } : {}),
    },
  };
}

/** Everything about this entry that misses the delivery bar, for the retry pass. */
export function describeShortfall(entry: ParsedEntry): string[] {
  const problems: string[] = [];
  if (!entry.descriptions.short) problems.push("no short description");
  else if (wordCount(entry.descriptions.short) > SHORT_DESCRIPTION_WORD_CAP) {
    problems.push("short description is too long");
  }
  if (!entry.descriptions.two_sentences) problems.push("no two-sentence description");
  if (!entry.descriptions.paragraph) problems.push("no paragraph description");
  if (!entry.tags.mood) problems.push("no mood");
  if (!entry.tags.theme) problems.push("no theme");
  if (!entry.tags.tone) problems.push("no tone");
  if (!iabHasTopic(entry.tags.iab)) problems.push("no IAB topic");
  return problems;
}

function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Collapse whatever the model wrote into at most three comma-separated tokens.
 * A model that answers a "two or three tokens" field with a sentence is common
 * enough that clipping it is worth more than rejecting the whole entry.
 */
function tokenList(value: unknown): string {
  const raw = cleanText(value);
  if (!raw) return "";
  const tokens = raw
    .split(/[,;/|]+/)
    .map((t) => t.trim().replace(/\.$/, ""))
    .filter((t) => t.length > 0 && t.toLowerCase() !== "none");
  if (tokens.length === 0) return "";
  return tokens.slice(0, MAX_TAG_TOKENS).join(", ");
}

// ============================================================================
// Thumbnails
// ============================================================================

async function extractThumbnails(
  params: FinalizeMetadataParams,
  targets: AgentSegment[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const { facts, bucketName } = params;

  if (!bucketName || !facts.sourceBucket || !facts.sourceKey) {
    console.warn("[IQAgent] metadata: no source object, skipping thumbnails");
    return out;
  }

  const sourceBucket = facts.sourceBucket;
  const sourceKey = facts.sourceKey;

  await mapWithConcurrency(targets, THUMBNAIL_CONCURRENCY, async (seg) => {
    if (Date.now() + THUMBNAIL_RESERVE_MS > params.deadlineAt) return;
    const destKey = `thumbnails/projects/${params.projectId}/${seg.id}.jpg`;
    try {
      await extractFrameToS3({
        sourceBucket,
        sourceKey,
        timestampSec: clampTimestamp(
          segmentThumbnailTimestamp(seg.startTime),
          seg,
          facts.duration,
        ),
        destBucket: bucketName,
        destKey,
      });
      out.set(seg.id, destKey);
    } catch (err) {
      console.warn(
        `[IQAgent] metadata: thumbnail for ${seg.id} failed: ${errorText(err)}`,
      );
    }
  });

  return out;
}

/** One second in, unless the segment is shorter than that or the file ends first. */
function clampTimestamp(
  preferred: number,
  seg: AgentSegment,
  duration: number,
): number {
  const upper = Math.max(seg.startTime, Math.min(seg.endTime - 0.1, duration - 0.5));
  return Math.max(seg.startTime, Math.min(preferred, upper));
}

async function ensureCover(
  params: FinalizeMetadataParams,
  state: { thumbnailKey?: string; thumbnailContentHash?: string },
): Promise<boolean> {
  const { facts, bucketName, projectsTable, segments } = params;
  if (!bucketName || !projectsTable || !facts.sourceKey) return false;
  if (Date.now() + THUMBNAIL_RESERVE_MS > params.deadlineAt) return false;

  const fingerprint = computeProjectThumbnailFingerprint(segments);
  if (!fingerprint) return false;
  if (state.thumbnailKey && state.thumbnailContentHash === fingerprint) {
    return false;
  }

  try {
    const cover = await ensureProjectCoverThumbnail({
      projectId: params.projectId,
      segments,
      sourceKey: facts.sourceKey,
      bucketName,
      projectsTable,
      existingThumbnailKey: state.thumbnailKey,
      existingThumbnailContentHash: state.thumbnailContentHash,
    });
    return cover?.generated === true;
  } catch (err) {
    console.warn(`[IQAgent] metadata: cover thumbnail failed: ${errorText(err)}`);
    return false;
  }
}

/** Exposed for the loop's "is there anything left to do" check. */
export function countSegmentsNeedingMetadata(
  segments: AgentSegment[],
  metadata: StoredSegmentMetadata[],
): number {
  const byId = new Map(metadata.map((m) => [m.segmentId, m]));
  return segments.filter((seg) =>
    isSegmentMetadataIncomplete(
      byId.get(seg.id),
      seg.startTime,
      seg.endTime,
      AGENT_METADATA_OPTIONS,
    ),
  ).length;
}