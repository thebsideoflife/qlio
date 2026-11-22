/**
 * Producer-entered facts about the source video (series, season, episode…).
 *
 * The AEO generator treats these as ground truth instead of guessing, because a
 * model asked to identify an episode from its transcript is confidently wrong
 * often enough to matter. Stored on the asset row as `showInfo`.
 *
 * IMPORTANT: `normalizeShowInfo` and `computeShowInfoHash` MUST match
 * `backend/src/services/show-info.ts`. The hash is stored with generated AEO metadata
 * and compared on both sides to decide staleness; a mismatch makes each side
 * think the other's data is stale and requests loop.
 */

export interface ShowInfo {
  series?: string;
  season?: string;
  episode?: string;
  episodeTitle?: string;
  year?: string;
}

const SHOW_INFO_KEYS: Array<keyof ShowInfo> = [
  "series",
  "season",
  "episode",
  "episodeTitle",
  "year",
];

const MAX_FIELD_CHARS = 200;

/** Trimmed, length-capped strings in a fixed key order; empty fields dropped. */
export function normalizeShowInfo(raw: unknown): ShowInfo {
  const out: ShowInfo = {};
  if (!raw || typeof raw !== "object") return out;
  const record = raw as Record<string, unknown>;
  for (const key of SHOW_INFO_KEYS) {
    const value = record[key];
    if (typeof value !== "string" && typeof value !== "number") continue;
    const text = String(value).replace(/\s+/g, " ").trim().slice(0, MAX_FIELD_CHARS);
    if (text) out[key] = text;
  }
  return out;
}

export function hasShowInfo(info: ShowInfo): boolean {
  return SHOW_INFO_KEYS.some((key) => Boolean(info[key]));
}

function djb2Hex(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}

export function computeShowInfoHash(raw: unknown): string {
  const info = normalizeShowInfo(raw);
  return djb2Hex(
    JSON.stringify(SHOW_INFO_KEYS.map((key) => info[key] ?? "")),
  );
}

/** "S1 E28 · "The City on the Edge of Forever" · 1967" — only the parts known. */
export function formatEpisodeLabel(info: ShowInfo): string {
  const parts: string[] = [];
  const se = [
    info.season ? `S${info.season}` : "",
    info.episode ? `E${info.episode}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (se) parts.push(se);
  if (info.episodeTitle) parts.push(`"${info.episodeTitle}"`);
  if (info.year) parts.push(info.year);
  return parts.join(" · ");
}
