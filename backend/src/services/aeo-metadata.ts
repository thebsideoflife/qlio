/**
 * Search, targeting & AEO (answer-engine optimisation) metadata for a scene.
 *
 * One Claude Sonnet call per scene through SporeLabs. It reads the scene's
 * dialogue, the wider transcript (for names), the descriptions already made
 * for the scene, and the producer's show info, then writes entities, search
 * copy, key quotes, a TV rating, IAB topics and per-platform packaging.
 *
 * The model is trusted for wording, never for facts it cannot see:
 * - Series, season, episode and year come only from the producer's show info.
 * - Key quotes are kept only if they appear verbatim in the scene's dialogue.
 * - Ratings must be a US TV Parental Guidelines value.
 * - YouTube chapters must satisfy YouTube's own rules or are dropped.
 * - Cast is requested only when the producer named the series.
 */

import type { TranscriptSegment } from "./storyiq/types";
import { truncateFullTranscriptPlain } from "../utils/transcript";
import {
  iabAllowlistPromptBlock,
  normalizeIabTags,
  type IabTaxonomyTags,
} from "./iab-content-taxonomy";
import { SPORELABS_SONNET_MODEL, sporelabsChatText } from "./sporelabs";
import { formatEpisodeLabel, hasShowInfo, type ShowInfo } from "./show-info";
import type { AeoOptions } from "./export-metadata";
import type {
  AeoChapter,
  AeoPlatform,
  AeoPlatformPackage,
  StoredAeoMetadata,
} from "../types/segment-metadata";

// Pegasus (up to 10 min) + enrichment run first in the same 15-min invocation.
const AEO_TIMEOUT_MS = 120_000;
const AEO_MAX_TOKENS = 3_000;
const MAX_FULL_TRANSCRIPT_CHARS = 12_000;
const MAX_SCENE_DIALOGUE_CHARS = 16_000;

export const TV_RATINGS = [
  "TV-Y",
  "TV-Y7",
  "TV-G",
  "TV-PG",
  "TV-14",
  "TV-MA",
] as const;

const LIST_LIMITS = {
  characters: 8,
  cast: 8,
  locations: 5,
  fanAliases: 6,
  questions: 5,
  keyQuotes: 3,
} as const;

const PLATFORM_SPECS: Record<
  AeoPlatform,
  { label: string; titleMax?: number; descriptionMax: number; hashtagsMax: number; tags?: boolean; chapters?: boolean; prompt: string }
> = {
  youtube: {
    label: "YouTube",
    titleMax: 100,
    descriptionMax: 5000,
    hashtagsMax: 3,
    tags: true,
    chapters: true,
    prompt:
      '{"title": "<=70 chars, names + the hook", "description": "2-4 short paragraphs, entity-first, no links", "hashtags": ["up to 3"], "tags": ["5-12 search keywords"], "chapters": [{"start": "0:00", "title": "..."}]}',
  },
  youtube_shorts: {
    label: "YouTube Shorts",
    titleMax: 100,
    descriptionMax: 1000,
    hashtagsMax: 5,
    prompt:
      '{"title": "<=60 chars, punchy", "description": "1-2 sentences", "hashtags": ["3-5, include Shorts"]}',
  },
  tiktok: {
    label: "TikTok",
    descriptionMax: 2200,
    hashtagsMax: 8,
    prompt:
      '{"description": "caption, 1-2 lines, conversational, <=150 chars", "hashtags": ["4-8"]}',
  },
  instagram_reels: {
    label: "Instagram Reels",
    descriptionMax: 2200,
    hashtagsMax: 10,
    prompt:
      '{"description": "caption, 1-3 short lines", "hashtags": ["5-10"]}',
  },
};

export interface AeoGenerationInput {
  options: AeoOptions;
  /** Also pick IAB content topics (merged into tags.iab by the caller). */
  wantIabTopics: boolean;
  show: ShowInfo;
  videoTitle?: string;
  sceneTitle?: string;
  transcript: TranscriptSegment[];
  segmentStart: number;
  segmentEnd: number;
  descriptions?: { short?: string; two_sentences?: string; paragraph?: string };
  tags?: { mood?: string; theme?: string; tone?: string; content_advisory?: string };
}

export interface AeoGenerationResult {
  aeo: Omit<StoredAeoMetadata, "showInfoHash">;
  iab?: IabTaxonomyTags;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** Scene dialogue with timestamps relative to the scene start. */
export function sceneDialogue(
  transcript: TranscriptSegment[],
  start: number,
  end: number,
): string {
  const lines = transcript
    .filter((seg) => seg.endTime > start && seg.startTime < end && seg.text.trim())
    .map((seg) => {
      const speaker = seg.speaker ? `${seg.speaker}: ` : "";
      return `[${clock(seg.startTime - start)}] ${speaker}${seg.text.trim()}`;
    });
  let text = lines.join("\n");
  if (text.length > MAX_SCENE_DIALOGUE_CHARS) {
    text = text.slice(0, MAX_SCENE_DIALOGUE_CHARS - 1) + "…";
  }
  return text;
}

export function buildAeoPrompt(input: AeoGenerationInput): {
  system: string;
  user: string;
} {
  const o = input.options;
  const showKnown = hasShowInfo(input.show);
  const durationSec = Math.max(0, input.segmentEnd - input.segmentStart);
  const fields: string[] = [];

  if (o.characters) {
    fields.push('"characters": ["character names who appear in this scene"]');
  }
  if (o.cast && showKnown) {
    fields.push(
      '"cast": ["actors who played those characters in this series, same order; only ones you are certain of"]',
    );
  }
  if (o.locations) {
    fields.push('"locations": ["in-story places shown, e.g. \\"USS Enterprise bridge\\""]');
  }
  if (o.searchTitle) {
    fields.push(
      '"search_title": "<=70 chars: what happens, with character names, then \\" | \\" and the series name if known"',
    );
  }
  if (o.entityDescription) {
    fields.push(
      '"entity_description": "1-2 sentences that open by naming the series/episode and the main characters, then what happens"',
    );
  }
  if (o.fanAliases) {
    fields.push('"fan_aliases": ["2-5 short phrases fans would search for this moment"]');
  }
  if (o.questions) {
    fields.push('"questions_answered": ["2-4 natural search questions this clip answers"]');
  }
  if (o.keyQuotes) {
    fields.push(
      '"key_quotes": ["1-3 memorable lines copied EXACTLY from the scene dialogue, no timestamps or speaker names"]',
    );
  }
  if (o.contentRating) {
    fields.push(`"content_rating": "one of ${TV_RATINGS.join(", ")}"`);
  }
  if (input.wantIabTopics) {
    fields.push('"iab_topics": ["ids from the IAB list below"]');
  }
  const platforms = (o.platforms ?? []).filter((p) => PLATFORM_SPECS[p]);
  if (platforms.length) {
    const specs = platforms
      .map((p) => `    "${p}": ${PLATFORM_SPECS[p].prompt}`)
      .join(",\n");
    fields.push(`"platforms": {\n${specs}\n  }`);
  }

  const showBlock = showKnown
    ? [
        input.show.series ? `Series: ${input.show.series}` : "",
        formatEpisodeLabel(input.show)
          ? `Episode: ${formatEpisodeLabel(input.show)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "Not provided. Do not guess the series, episode or actors; use the video title only.";

  const chapterRule = platforms.includes("youtube")
    ? `\nYouTube chapters: times are from the start of this ${clock(durationSec)} clip; the first is 0:00; at least 3 chapters, each at least 10 seconds long. If the clip is too short for that, return "chapters": [].`
    : "";

  const descriptions =
    input.descriptions?.paragraph ||
    input.descriptions?.two_sentences ||
    input.descriptions?.short ||
    "";
  const tagLine = [
    input.tags?.mood ? `mood: ${input.tags.mood}` : "",
    input.tags?.theme ? `theme: ${input.tags.theme}` : "",
    input.tags?.tone ? `tone: ${input.tags.tone}` : "",
    input.tags?.content_advisory ? `advisory: ${input.tags.content_advisory}` : "",
  ]
    .filter(Boolean)
    .join("; ");

  const system =
    "You write search and discovery metadata for short vertical clips cut from film and TV. " +
    "Be specific and factual: use real character names from the transcript, never invent plot, " +
    "episode details or actors. Write for people searching, not for marketing. Return JSON only.";

  const user = `Write discovery metadata for one scene.

<show_info>
${showBlock}
</show_info>

<video_title>${input.videoTitle?.trim() || "(none)"}</video_title>
<scene_title>${input.sceneTitle?.trim() || "(none)"}</scene_title>
<scene_length>${clock(durationSec)}</scene_length>

<scene_description>
${descriptions || "(none)"}${tagLine ? `\n(${tagLine})` : ""}
</scene_description>

<scene_dialogue>
${sceneDialogue(input.transcript, input.segmentStart, input.segmentEnd) || "(none)"}
</scene_dialogue>

<full_transcript_for_names>
${truncateFullTranscriptPlain(input.transcript, MAX_FULL_TRANSCRIPT_CHARS) || "(none)"}
</full_transcript_for_names>
${input.wantIabTopics ? `\n${iabAllowlistPromptBlock({ topics: true, genres: false, formFactor: false })}\n` : ""}${chapterRule}
Use [] for any list with nothing accurate to put in it.

JSON only:
{
  ${fields.join(",\n  ")}
}`;

  return { system, user };
}

// ---------------------------------------------------------------------------
// Parsing and validation (pure; unit-tested in scripts/test-aeo-metadata.ts)
// ---------------------------------------------------------------------------

function extractJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("AEO response did not contain a JSON object");
  }
  return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
}

function cleanString(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

/** Multi-line text (descriptions): keeps paragraph breaks. */
function cleanBlock(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
  return text.length <= max ? text : `${text.slice(0, max - 1).trim()}…`;
}

export function cleanList(value: unknown, maxItems: number, maxChars = 120): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = cleanString(item, maxChars).replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9']+/g, " ")
    .trim();
}

/** Keeps only quotes that appear word for word in the scene's dialogue. */
export function verifyQuotes(
  quotes: string[],
  transcript: TranscriptSegment[],
  start: number,
  end: number,
): string[] {
  const dialogue = normalizeForMatch(
    transcript
      .filter((seg) => seg.endTime > start && seg.startTime < end)
      .map((seg) => seg.text)
      .join(" "),
  );
  if (!dialogue) return [];
  return quotes.filter((quote) => {
    const q = normalizeForMatch(quote);
    return q.split(" ").length >= 2 && ` ${dialogue} `.includes(` ${q} `);
  });
}

export function normalizeRating(value: unknown): string {
  if (typeof value !== "string") return "";
  const compact = value.toUpperCase().replace(/[\s_]+/g, "-").replace(/^TV(?=[A-Z0-9])/, "TV-");
  return (TV_RATINGS as readonly string[]).includes(compact) ? compact : "";
}

export function normalizeHashtags(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const body = item.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]+/gu, "");
    if (!body || body.length > 50) continue;
    const key = body.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`#${body}`);
    if (out.length >= max) break;
  }
  return out;
}

function parseClock(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parts = value.trim().split(":").map((p) => Number(p));
  if (!parts.length || parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  return parts.reduce((total, p) => total * 60 + p, 0);
}

/**
 * YouTube only shows chapters when the first starts at 0:00, there are at
 * least three, and each lasts at least 10 seconds. Anything else is dropped
 * rather than repaired, since a repaired chapter list would be invented.
 */
export function validateChapters(value: unknown, durationSec: number): AeoChapter[] {
  if (!Array.isArray(value)) return [];
  const chapters: AeoChapter[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const startSec = parseClock(row.start ?? row.startSec ?? row.time);
    const title = cleanString(row.title, 80);
    if (startSec === null || !title) continue;
    chapters.push({ startSec: Math.round(startSec), title });
  }
  chapters.sort((a, b) => a.startSec - b.startSec);
  if (chapters.length < 3 || chapters[0].startSec !== 0) return [];
  for (let i = 0; i < chapters.length; i++) {
    const next = i + 1 < chapters.length ? chapters[i + 1].startSec : durationSec;
    if (next - chapters[i].startSec < 10) return [];
  }
  return chapters;
}

function parsePlatform(
  platform: AeoPlatform,
  raw: unknown,
  durationSec: number,
): AeoPlatformPackage {
  const spec = PLATFORM_SPECS[platform];
  const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const pkg: AeoPlatformPackage = {};
  if (spec.titleMax) {
    const title = cleanString(row.title, spec.titleMax);
    if (title) pkg.title = title;
  }
  const description = cleanBlock(row.description ?? row.caption, spec.descriptionMax);
  if (description) pkg.description = description;
  const hashtags = normalizeHashtags(row.hashtags, spec.hashtagsMax);
  if (hashtags.length) pkg.hashtags = hashtags;
  if (spec.tags) {
    const tags = cleanList(row.tags, 15, 30);
    let total = 0;
    const fitted = tags.filter((t) => (total += t.length + 1) <= 500);
    if (fitted.length) pkg.tags = fitted;
  }
  if (spec.chapters) {
    const chapters = validateChapters(row.chapters, durationSec);
    if (chapters.length) pkg.chapters = chapters;
  }
  return pkg;
}

/**
 * Every requested field is set in the result, empty when the model gave
 * nothing usable, so the same request is not repeated on the next visit.
 */
export function parseAeoResponse(
  raw: string,
  input: AeoGenerationInput,
): AeoGenerationResult {
  const data = extractJson(raw);
  const o = input.options;
  const durationSec = Math.max(0, input.segmentEnd - input.segmentStart);
  const aeo: AeoGenerationResult["aeo"] = {};

  if (o.characters || o.cast || o.locations) {
    aeo.entities = {};
    if (o.characters) aeo.entities.characters = cleanList(data.characters, LIST_LIMITS.characters, 60);
    if (o.cast) {
      aeo.entities.cast = hasShowInfo(input.show) ? cleanList(data.cast, LIST_LIMITS.cast, 60) : [];
    }
    if (o.locations) aeo.entities.locations = cleanList(data.locations, LIST_LIMITS.locations, 80);
  }

  if (o.searchTitle || o.entityDescription || o.fanAliases || o.questions) {
    aeo.search = {};
    if (o.searchTitle) aeo.search.title = cleanString(data.search_title, 100);
    if (o.entityDescription) aeo.search.entityDescription = cleanString(data.entity_description, 400);
    if (o.fanAliases) aeo.search.fanAliases = cleanList(data.fan_aliases, LIST_LIMITS.fanAliases, 60);
    if (o.questions) {
      aeo.search.questions = cleanList(data.questions_answered, LIST_LIMITS.questions, 140).map(
        (q) => (/[?？]$/.test(q) ? q : `${q}?`),
      );
    }
  }

  if (o.keyQuotes) {
    aeo.keyQuotes = verifyQuotes(
      cleanList(data.key_quotes, 6, 240),
      input.transcript,
      input.segmentStart,
      input.segmentEnd,
    ).slice(0, LIST_LIMITS.keyQuotes);
  }

  if (o.contentRating) aeo.contentRating = normalizeRating(data.content_rating);

  const platforms = (o.platforms ?? []).filter((p) => PLATFORM_SPECS[p]);
  if (platforms.length) {
    const rawPlatforms =
      data.platforms && typeof data.platforms === "object"
        ? (data.platforms as Record<string, unknown>)
        : {};
    aeo.platforms = {};
    for (const platform of platforms) {
      aeo.platforms[platform] = parsePlatform(platform, rawPlatforms[platform], durationSec);
    }
  }

  const result: AeoGenerationResult = { aeo };
  if (input.wantIabTopics) {
    const iab = normalizeIabTags(data.iab_topics, undefined, {
      topics: true,
      genres: false,
      formFactor: false,
    });
    if (iab) result.iab = iab;
  }
  return result;
}

/** True when the request asks the model for anything at all. */
export function aeoHasModelWork(options: AeoOptions | undefined, wantIabTopics: boolean): boolean {
  if (wantIabTopics) return true;
  if (!options) return false;
  return Boolean(
    options.characters ||
      options.cast ||
      options.locations ||
      options.searchTitle ||
      options.entityDescription ||
      options.fanAliases ||
      options.questions ||
      options.keyQuotes ||
      options.contentRating ||
      options.platforms?.length,
  );
}

export async function generateSegmentAeo(
  input: AeoGenerationInput,
): Promise<AeoGenerationResult> {
  const { system, user } = buildAeoPrompt(input);
  const text = await sporelabsChatText({
    model: SPORELABS_SONNET_MODEL,
    system,
    user,
    maxTokens: AEO_MAX_TOKENS,
    temperature: 0.3,
    timeoutMs: AEO_TIMEOUT_MS,
    json: true,
  });
  if (!text.trim()) throw new Error("AEO generation returned an empty response");
  return parseAeoResponse(text, input);
}
