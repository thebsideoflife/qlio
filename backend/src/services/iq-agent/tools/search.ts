/**
 * search_video — Marengo semantic search. Cheap, fast, grounded timestamps.
 *
 * Search is scoped to the asset (and every chunk of it) with a stringified id
 * filter, and every result is mapped back onto the source timeline before the
 * model ever sees it.
 */

import type { TwelveLabs } from "twelvelabs-js";
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_TIMEOUT_MS,
} from "../config";
import { toSourceTime } from "../chunks";
import { fmtTimecode } from "../ledger";
import { toolError, type ToolResult, type VideoFacts } from "../types";

export type SearchModality = "visual" | "audio" | "transcription";

export interface SearchHit {
  start: number;
  end: number;
  /** Relevance score when Marengo returns one. */
  score?: number;
  /** 1-based position in Marengo's ranking; the documented ordering field. */
  rank?: number;
  confidence?: string;
  transcription?: string;
}

/** Hits closer than this on both edges are the same moment seen twice. */
const DEDUPE_TOLERANCE_SEC = 1.5;

export function normalizeModalities(input: unknown): SearchModality[] {
  const allowed: SearchModality[] = ["visual", "audio", "transcription"];
  if (!Array.isArray(input) || input.length === 0) {
    return ["visual", "transcription"];
  }
  const picked = input.filter((m): m is SearchModality =>
    allowed.includes(m as SearchModality),
  );
  return picked.length > 0 ? picked : ["visual", "transcription"];
}

/**
 * Collapse duplicate hits produced by the 30s overlap between chunks, keeping
 * the highest-scoring copy of each moment.
 */
export function dedupeHits(hits: SearchHit[]): SearchHit[] {
  const sorted = [...hits].sort(byRelevance);
  const kept: SearchHit[] = [];
  for (const hit of sorted) {
    const duplicate = kept.some(
      (k) =>
        Math.abs(k.start - hit.start) < DEDUPE_TOLERANCE_SEC &&
        Math.abs(k.end - hit.end) < DEDUPE_TOLERANCE_SEC,
    );
    if (!duplicate) kept.push(hit);
  }
  return kept;
}

export async function runSearchVideo(params: {
  client: TwelveLabs;
  facts: VideoFacts;
  query: string;
  modalities?: unknown;
  operator?: unknown;
  limit?: unknown;
  timeRange?: { start?: number; end?: number };
}): Promise<ToolResult> {
  const { client, facts } = params;
  const query = String(params.query ?? "").trim();

  if (query.length === 0) {
    return toolError(
      "bad_query",
      "query is empty.",
      "Describe the moment you are looking for in natural language.",
    );
  }

  const videoIds = facts.chunks.map((c) => c.videoId).filter(Boolean);
  if (videoIds.length === 0) {
    return toolError(
      "not_indexed",
      "This asset has no indexed video ids, so semantic search is unavailable.",
      "Use read_transcript to map the video, and watch_clip on specific windows.",
    );
  }

  const modalities = normalizeModalities(params.modalities);
  const operator = params.operator === "and" ? "and" : "or";
  const requested =
    typeof params.limit === "number" && Number.isFinite(params.limit)
      ? Math.floor(params.limit)
      : SEARCH_DEFAULT_LIMIT;
  const limit = Math.min(Math.max(requested, 1), SEARCH_MAX_LIMIT);
  const warnings: string[] = [];
  if (requested > SEARCH_MAX_LIMIT) {
    warnings.push(
      `limit ${requested} exceeds the Marengo maximum of ${SEARCH_MAX_LIMIT}; returning ${SEARCH_MAX_LIMIT}.`,
    );
  }

  const range =
    params.timeRange &&
    (typeof params.timeRange.start === "number" ||
      typeof params.timeRange.end === "number")
      ? params.timeRange
      : undefined;

  // Ask for more than we need when chunk overlaps can produce duplicates, and
  // for everything Marengo will give when a time window is in play: ranking is
  // global, so a narrow window can be filtered out of a small page entirely.
  const pageLimit = range
    ? SEARCH_MAX_LIMIT
    : Math.min(
        SEARCH_MAX_LIMIT,
        facts.chunks.length > 1 ? Math.min(limit * 2, SEARCH_MAX_LIMIT) : limit,
      );

  let response: { data?: unknown[] };
  try {
    response = (await withTimeout(
      client.search.create({
        indexId: facts.indexId,
        queryText: query,
        searchOptions: modalities,
        operator,
        pageLimit,
        filter: JSON.stringify({ id: videoIds }),
      }) as Promise<{ data?: unknown[] }>,
      SEARCH_TIMEOUT_MS,
    )) as { data?: unknown[] };
  } catch (err) {
    return classifySearchError(err);
  }

  const byVideoId = new Map(facts.chunks.map((c) => [c.videoId, c]));
  const hits: SearchHit[] = [];

  for (const raw of response.data ?? []) {
    const item = raw as Record<string, unknown>;
    const chunk = byVideoId.get(String(item.videoId ?? ""));
    if (!chunk) continue;
    const localStart = Number(item.start ?? 0);
    const localEnd = Number(item.end ?? localStart);
    if (!Number.isFinite(localStart) || !Number.isFinite(localEnd)) continue;

    // Marengo documents `score` on a hit but only `rank` is in the SDK's model,
    // so the response is read for either. Neither present means we have no
    // ordering to report, and inventing 0.0 would look like a real ranking.
    const score = firstNumber(item.score, item.confidenceScore);
    const rank = firstNumber(item.rank);

    hits.push({
      start: toSourceTime(chunk, localStart),
      end: toSourceTime(chunk, localEnd),
      score,
      rank,
      confidence:
        typeof item.confidence === "string" ? item.confidence : undefined,
      transcription:
        typeof item.transcription === "string" ? item.transcription : undefined,
    });
  }

  let results = dedupeHits(hits);
  const ranked = results.some((h) => h.score !== undefined || h.rank !== undefined);
  if (!ranked && results.length > 1) {
    warnings.push(
      "Marengo returned these matches without relevance scores, so they are listed in timeline order rather than by strength.",
    );
  }

  if (range) {
    const lo = typeof range.start === "number" ? range.start : 0;
    const hi = typeof range.end === "number" ? range.end : facts.duration;
    const before = results.length;
    results = results.filter((h) => h.end > lo && h.start < hi);
    if (results.length === 0 && before > 0) {
      warnings.push(
        `None of the ${before} strongest matches for this query fall inside ${fmtTimecode(lo)}–${fmtTimecode(
          hi,
        )}. Marengo ranks across the whole video, so a narrow window can come back empty even when something is there — try wording the query around what happens in that window, or drop timeRange and read the timeline yourself.`,
      );
    }
  }

  results = results
    .sort(byRelevance)
    .slice(0, limit)
    .sort((a, b) => a.start - b.start);

  if (results.length === 0) {
    return {
      ok: true,
      text: `No matches for "${query}"${
        range ? " in the requested window" : ""
      }. Try different phrasing, add the 'audio' modality, or search for what is said rather than what is seen.`,
      summary: `Searched "${truncate(query, 40)}" · no matches`,
      digest: { query, matches: 0 },
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  const rows = results.map((h, i) => {
    const duration = Math.max(0, h.end - h.start);
    const snippet = h.transcription
      ? ` · "${truncate(h.transcription.replace(/\s+/g, " ").trim(), 140)}"`
      : "";
    const strength =
      h.score !== undefined
        ? ` score ${h.score.toFixed(1)}`
        : h.rank !== undefined
          ? ` rank ${h.rank}`
          : "";
    return `${String(i + 1).padStart(2)}. ${fmtTimecode(h.start)}–${fmtTimecode(
      h.end,
    )} (${duration.toFixed(1)}s)${strength}${snippet}`;
  });

  const best = results.slice().sort(byRelevance)[0];

  return {
    ok: true,
    text: `${results.length} match(es) for "${query}" (source timeline):\n${rows.join("\n")}`,
    summary: `Searched "${truncate(query, 40)}" · ${results.length} match${
      results.length === 1 ? "" : "es"
    }`,
    digest: {
      query,
      matches: results.length,
      best: `${fmtTimecode(best.start)}–${fmtTimecode(best.end)}`,
    },
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function classifySearchError(err: unknown): ToolResult {
  const message = errorMessage(err);
  const status = errorStatus(err);

  if (status === 429) {
    return toolError(
      "rate_limited",
      "Marengo is rate limiting search requests.",
      "Wait for your next tool call, or use read_transcript to keep making progress without search.",
      { detail: message, retryable: true },
    );
  }

  if (status === 400 || status === 404) {
    return toolError(
      "search_unavailable",
      `Marengo rejected the search request: ${message}`,
      "This index may not have search enabled. Fall back to read_transcript for discovery and watch_clip to verify candidates.",
      { detail: message },
    );
  }

  if (/timed out/i.test(message)) {
    return toolError(
      "timeout",
      "The search request timed out.",
      "Try a shorter query, or use read_transcript to keep moving.",
      { detail: message, retryable: true },
    );
  }

  return toolError(
    "search_failed",
    `Search failed: ${message}`,
    "Try a different phrasing, or fall back to read_transcript and watch_clip.",
    { detail: message, retryable: true },
  );
}

export function errorStatus(err: unknown): number | undefined {
  const e = err as { status?: number; statusCode?: number };
  return e?.status ?? e?.statusCode;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err).slice(0, 400);
  } catch {
    return String(err);
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Request timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const n = Number(value);
    if (value !== null && value !== undefined && Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Higher score first, then lower rank (rank 1 is the strongest match). */
export function byRelevance(a: SearchHit, b: SearchHit): number {
  if (a.score !== undefined || b.score !== undefined) {
    return (b.score ?? -Infinity) - (a.score ?? -Infinity);
  }
  if (a.rank !== undefined || b.rank !== undefined) {
    return (a.rank ?? Infinity) - (b.rank ?? Infinity);
  }
  return a.start - b.start;
}
