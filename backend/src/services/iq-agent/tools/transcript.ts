/**
 * read_transcript — free, instant, S3 only.
 *
 * The stored transcript is word-level. Sentences are grouped with the same
 * break rules the caption renderer uses, so what the agent reads matches what
 * the producer sees burned into the video.
 */

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { TRANSCRIPT_MAX_CHARS } from "../config";
import { fmtTimecode } from "../ledger";
import { toolError, type ToolResult } from "../types";

const s3Client = new S3Client({});

export interface TranscriptWord {
  start: number;
  end: number;
  value: string;
}

export interface TranscriptLine {
  start: number;
  end: number;
  text: string;
}

/** Caption break rules: >8 words, >3s, or a pause longer than 0.3s. */
const MAX_WORDS_PER_LINE = 8;
const MAX_LINE_SECONDS = 3;
const PAUSE_BREAK_SECONDS = 0.3;

/** A silence at least this long is a candidate for a clean cut edge. */
const CLEAN_EDGE_GAP_SECONDS = 0.35;

export function groupWordsIntoLines(words: TranscriptWord[]): TranscriptLine[] {
  if (words.length === 0) return [];

  const lines: TranscriptLine[] = [];
  let current: TranscriptWord[] = [];
  let lineStart = words[0].start;

  const flush = () => {
    if (current.length === 0) return;
    lines.push({
      start: lineStart,
      end: current[current.length - 1].end,
      text: current.map((w) => w.value).join(" "),
    });
    current = [];
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const prev = i > 0 ? words[i - 1] : null;
    const shouldBreak =
      current.length >= MAX_WORDS_PER_LINE ||
      (current.length > 0 && word.end - lineStart > MAX_LINE_SECONDS) ||
      (prev != null && word.start - prev.end > PAUSE_BREAK_SECONDS);

    if (shouldBreak && current.length > 0) {
      flush();
      lineStart = word.start;
    }
    current.push(word);
  }
  flush();

  return lines;
}

export function wordsInRange(
  words: TranscriptWord[],
  start: number,
  end: number,
): TranscriptWord[] {
  return words.filter((w) => w.end > start && w.start < end);
}

export interface EdgeReport {
  /** Silence containing or nearest to the requested boundary. */
  gapStart: number;
  gapEnd: number;
  seconds: number;
}

/**
 * The silence closest to a boundary. Gives the agent a concrete place to move
 * an edge to without the system snapping anything on its behalf.
 */
export function nearestSilence(
  words: TranscriptWord[],
  atTime: number,
  searchWindow = 12,
): EdgeReport | null {
  let best: EdgeReport | null = null;
  let bestDistance = Infinity;

  for (let i = 1; i < words.length; i++) {
    const gapStart = words[i - 1].end;
    const gapEnd = words[i].start;
    const seconds = gapEnd - gapStart;
    if (seconds < CLEAN_EDGE_GAP_SECONDS) continue;

    const distance =
      atTime < gapStart
        ? gapStart - atTime
        : atTime > gapEnd
          ? atTime - gapEnd
          : 0;
    if (distance > searchWindow) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { gapStart, gapEnd, seconds };
    }
  }

  return best;
}

function sideOf(edge: EdgeReport, at: number): string {
  if (edge.gapEnd <= at) return "before it";
  if (edge.gapStart >= at) return "after it";
  return "spanning it";
}

export async function loadTranscriptWords(
  s3Uri: string,
): Promise<TranscriptWord[]> {
  if (!s3Uri.startsWith("s3://")) {
    throw new Error(`Invalid transcript URI: ${s3Uri}`);
  }
  const withoutScheme = s3Uri.slice("s3://".length);
  const slash = withoutScheme.indexOf("/");
  if (slash <= 0 || slash === withoutScheme.length - 1) {
    throw new Error(`Invalid transcript URI: ${s3Uri}`);
  }
  const bucket = withoutScheme.slice(0, slash);
  const key = withoutScheme.slice(slash + 1);

  const response = await s3Client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  const body = await response.Body?.transformToString();
  if (!body) throw new Error("Transcript object is empty");

  const parsed: unknown = JSON.parse(body);
  const raw = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { data?: unknown }).data)
      ? ((parsed as { data: unknown[] }).data)
      : Array.isArray((parsed as { transcription?: unknown }).transcription)
        ? ((parsed as { transcription: unknown[] }).transcription)
        : [];

  return raw
    .map((entry) => {
      const e = entry as Record<string, unknown>;
      const start = Number(e.start ?? e.startTime ?? 0);
      const end = Number(e.end ?? e.endTime ?? start);
      const value = String(e.value ?? e.text ?? "").trim();
      return { start, end, value };
    })
    .filter(
      (w) =>
        w.value.length > 0 && Number.isFinite(w.start) && Number.isFinite(w.end),
    )
    .sort((a, b) => a.start - b.start);
}

export function runReadTranscript(params: {
  words: TranscriptWord[];
  start: number;
  end: number;
  granularity: "sentences" | "words";
  videoDuration: number;
}): ToolResult {
  const { words, granularity, videoDuration } = params;

  if (!Number.isFinite(params.start) || !Number.isFinite(params.end)) {
    return toolError(
      "bad_range",
      "start and end must be numbers in seconds.",
      "Pass numeric source-timeline seconds, e.g. {start: 412, end: 538}.",
    );
  }

  const start = Math.max(0, Math.min(params.start, params.end));
  const end = Math.min(
    videoDuration > 0 ? videoDuration : params.end,
    Math.max(params.start, params.end),
  );

  if (end - start < 0.5) {
    return toolError(
      "empty_range",
      `Range ${fmtTimecode(start)}–${fmtTimecode(end)} is effectively zero-length.`,
      "Widen the range to at least a couple of seconds.",
    );
  }

  if (words.length === 0) {
    return toolError(
      "no_transcript",
      "This asset has no word-level transcript.",
      "Use search_video and watch_clip instead — dialogue is not available for this source.",
    );
  }

  const inRange = wordsInRange(words, start, end);
  const warnings: string[] = [];

  if (inRange.length === 0) {
    const before = nearestSilence(words, start, 120);
    return {
      ok: true,
      text:
        `No speech between ${fmtTimecode(start)} and ${fmtTimecode(end)} — this stretch is silent or non-verbal.` +
        (before
          ? ` Nearest silence boundary: ${fmtTimecode(before.gapStart)}–${fmtTimecode(before.gapEnd)}.`
          : ""),
      summary: `No dialogue ${fmtTimecode(start)}–${fmtTimecode(end)}`,
      // Silence is a real observation about the whole range, not a short read.
      digest: { start, end, coveredEnd: end, words: 0 },
    };
  }

  const rendered: Array<{ text: string; end: number }> =
    granularity === "words"
      ? inRange.map((w) => ({
          text: `${w.start.toFixed(2)}–${w.end.toFixed(2)} ${w.value}`,
          end: w.end,
        }))
      : groupWordsIntoLines(inRange).map((line) => ({
          text: `[${fmtTimecode(line.start)}] ${line.text}`,
          end: line.end,
        }));

  // Truncation has to report the timestamp it stopped at, not just that it
  // happened. The caller credits this range as examined, and crediting a range
  // whose second half was cut off would let a long source pass the coverage
  // gate on a read nobody actually saw the end of.
  const kept: string[] = [];
  let chars = 0;
  let coveredEnd = end;
  for (const line of rendered) {
    if (chars + line.text.length + 1 > TRANSCRIPT_MAX_CHARS) {
      coveredEnd = kept.length > 0 ? rendered[kept.length - 1].end : start;
      break;
    }
    kept.push(line.text);
    chars += line.text.length + 1;
  }

  const truncated = kept.length < rendered.length;
  let body = kept.join("\n");
  if (truncated) {
    body = `${body}\n… (truncated)`;
    warnings.push(
      `Output truncated at ${TRANSCRIPT_MAX_CHARS} characters — this covers ${fmtTimecode(
        start,
      )}–${fmtTimecode(coveredEnd)}, not the full range you asked for. Read from ${fmtTimecode(
        coveredEnd,
      )} onward for the rest.`,
    );
  }

  const edges: string[] = [];
  const openEdge = nearestSilence(words, start);
  const closeEdge = nearestSilence(words, end);
  // The search runs in both directions, so the label says "closest to", not
  // "before" or "after" — an editor moving an edge needs to know which side.
  if (openEdge) {
    edges.push(
      `silence closest to the opening edge: ${fmtTimecode(openEdge.gapStart)}–${fmtTimecode(openEdge.gapEnd)} (${openEdge.seconds.toFixed(2)}s, ${sideOf(openEdge, start)})`,
    );
  }
  if (closeEdge) {
    edges.push(
      `silence closest to the closing edge: ${fmtTimecode(closeEdge.gapStart)}–${fmtTimecode(closeEdge.gapEnd)} (${closeEdge.seconds.toFixed(2)}s, ${sideOf(closeEdge, end)})`,
    );
  }

  const header = `Dialogue ${fmtTimecode(start)}–${fmtTimecode(coveredEnd)} (${
    kept.length
  } of ${rendered.length} ${granularity === "words" ? "words" : "lines"}):`;
  const footer = edges.length > 0 ? `\n\nEdges — ${edges.join("; ")}.` : "";

  return {
    ok: true,
    text: `${header}\n${body}${footer}`,
    summary: `Read dialogue ${fmtTimecode(start)}–${fmtTimecode(coveredEnd)} · ${inRange.length} words`,
    digest: {
      start,
      end,
      /** How far the output actually reaches, which truncation can cut short. */
      coveredEnd,
      words: inRange.length,
      firstLine: groupWordsIntoLines(inRange)[0]?.text?.slice(0, 90),
    },
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
