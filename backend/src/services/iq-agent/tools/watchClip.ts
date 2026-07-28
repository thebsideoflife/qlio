/**
 * watch_clip — Pegasus 1.5, always time-ranged.
 *
 * There is no code path here that calls Pegasus without a window. That is the
 * single most important cost control in the feature and it is structural, not a
 * convention: `planRange` produces chunk-local windows or nothing at all.
 *
 * There is deliberately no per-run spend cap. Waste is prevented by the cache,
 * overlap-aware repeat detection, bounded retries, and an advisory meter — a
 * hard cap would truncate a legitimately thorough run without touching the
 * actual failure mode, which is redundant calls.
 */

import { createHash } from "crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { TwelveLabs } from "twelvelabs-js";
import {
  CLIP_WINDOW_WARN_SEC,
  MAX_CLIP_WINDOW_SEC,
  MIN_CLIP_SEC,
  WATCH_CLIP_MAX_ATTEMPTS,
  WATCH_CLIP_TIMEOUT_MS,
  WATCH_REPEAT_OVERLAP,
} from "../config";
import { planRange, widenToMinimumClip, type RangePiece } from "../chunks";
import { fmtTimecode } from "../ledger";
import { toolError, type ToolResult, type VideoFacts } from "../types";
import { errorMessage, errorStatus, withTimeout } from "./search";

const s3Client = new S3Client({});

export interface WatchHistoryEntry {
  start: number;
  end: number;
  question: string;
  answer: string;
}

export interface WatchClipOutcome {
  result: ToolResult;
  videoSecondsWatched: number;
  cacheHit: boolean;
  /** Present when a real answer was produced, so the caller can record it. */
  recorded?: WatchHistoryEntry;
}

export function normalizeQuestion(question: string): string {
  return question.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

export function cacheKeyFor(
  assetId: string,
  start: number,
  end: number,
  question: string,
): string {
  const hash = createHash("sha256")
    .update(
      `${assetId}|${start.toFixed(2)}|${end.toFixed(2)}|${normalizeQuestion(question)}`,
    )
    .digest("hex");
  return `agent/clip-cache/${assetId}/${hash}.json`;
}

/**
 * A prior watch covering at least 90% of the requested window, in case the
 * exact-match cache missed because the window shifted by a second or the
 * question was reworded.
 *
 * A *different* question about the same window is a legitimate second look, so
 * that comes back as `sameQuestion: false` and the call goes through — the
 * prior answer is offered to the model as context, not as a refusal.
 */
export function findOverlappingWatch(
  history: WatchHistoryEntry[],
  start: number,
  end: number,
  question: string,
): { prior: WatchHistoryEntry; sameQuestion: boolean } | null {
  const span = end - start;
  if (span <= 0) return null;
  const normalized = normalizeQuestion(question);
  for (let i = history.length - 1; i >= 0; i--) {
    const prior = history[i];
    const overlap = Math.min(prior.end, end) - Math.max(prior.start, start);
    if (overlap / span >= WATCH_REPEAT_OVERLAP) {
      return {
        prior,
        sameQuestion: normalizeQuestion(prior.question) === normalized,
      };
    }
  }
  return null;
}

export async function runWatchClip(params: {
  client: TwelveLabs;
  facts: VideoFacts;
  cacheBucket?: string;
  start: number;
  end: number;
  question: string;
  history: WatchHistoryEntry[];
  /** Epoch-ms ceiling for this call; retries are trimmed to fit inside it. */
  deadlineAt?: number;
  onProgress?: (note: string) => void;
}): Promise<WatchClipOutcome> {
  const { client, facts, cacheBucket, history, onProgress } = params;
  const question = String(params.question ?? "").trim();
  const warnings: string[] = [];

  if (question.length === 0) {
    return fail(
      toolError(
        "bad_question",
        "question is empty.",
        "Ask something specific about the window, e.g. 'does the argument resolve before the cut?'",
      ),
    );
  }

  if (!Number.isFinite(params.start) || !Number.isFinite(params.end)) {
    return fail(
      toolError(
        "bad_range",
        "start and end must be numbers in seconds.",
        "Pass source-timeline seconds, e.g. {start: 412, end: 470}.",
      ),
    );
  }

  let start = Math.max(0, Math.min(params.start, params.end));
  let end = Math.max(params.start, params.end);

  // A window that lies entirely past the source is a mistake, not something to
  // quietly relocate: clamping it would answer a question about the last few
  // seconds of the video as though it were the moment that was asked about.
  if (facts.duration > 0 && start >= facts.duration) {
    return fail(
      toolError(
        "bad_range",
        `${fmtTimecode(start)} is past the end of the source, which runs ${fmtTimecode(facts.duration)}.`,
        `Pick a window inside 0–${fmtTimecode(facts.duration)}.`,
      ),
    );
  }

  if (facts.duration > 0 && end > facts.duration) {
    warnings.push(
      `Requested end ${fmtTimecode(end)} is past the end of the source (${fmtTimecode(facts.duration)}); clamped.`,
    );
    end = facts.duration;
  }

  if (end - start > MAX_CLIP_WINDOW_SEC) {
    return fail(
      toolError(
        "window_too_large",
        `A ${Math.round((end - start) / 60)}-minute window is not a question, it is the whole video.`,
        `Ask about a scene or a sequence instead, up to ${Math.round(MAX_CLIP_WINDOW_SEC / 60)} minutes. To find out what is in a stretch this long, read_transcript over it.`,
      ),
    );
  }

  if (end - start < MIN_CLIP_SEC) {
    const widened = Math.min(
      facts.duration > 0 ? facts.duration : start + MIN_CLIP_SEC,
      start + MIN_CLIP_SEC,
    );
    warnings.push(
      `Window was shorter than the ${MIN_CLIP_SEC}s Pegasus minimum; widened to ${fmtTimecode(start)}–${fmtTimecode(widened)}.`,
    );
    end = widened;
    start = Math.max(0, end - MIN_CLIP_SEC);
  }

  if (end - start > CLIP_WINDOW_WARN_SEC) {
    // Not about latency, which measures near-flat across window sizes — the call
    // is dominated by fixed overhead. It is about resolution: Pegasus returns an
    // answer of roughly constant length however much footage it is given, so a
    // very wide window buys breadth by spending detail.
    warnings.push(
      `This window is ${Math.round((end - start) / 60)} minutes long, and the answer will be about as long as it would be for one minute — so expect a summary with individual moments averaged out of it. Fine for the shape of a sequence. If you are after a specific moment or a boundary, ask about a window that brackets it.`,
    );
  }

  const repeat = findOverlappingWatch(history, start, end, question);
  if (repeat?.sameQuestion) {
    return {
      cacheHit: true,
      videoSecondsWatched: 0,
      result: {
        ok: true,
        text: `You already asked this about ${fmtTimecode(repeat.prior.start)}–${fmtTimecode(
          repeat.prior.end,
        )}, which covers this window. Here is what you found then:\n\n${repeat.prior.answer}\n\nAsk a different question, or widen the window, if you need more than this.`,
        summary: `Already watched ${fmtTimecode(start)}–${fmtTimecode(end)} · reused answer`,
        digest: { start, end, reused: true },
        warnings: warnings.length > 0 ? warnings : undefined,
      },
    };
  }
  if (repeat) {
    warnings.push(
      `You watched ${fmtTimecode(repeat.prior.start)}–${fmtTimecode(
        repeat.prior.end,
      )} earlier and found: ${truncateForNote(repeat.prior.answer)}`,
    );
  }

  const cacheKey = cacheBucket
    ? cacheKeyFor(facts.assetId, start, end, question)
    : null;
  if (cacheBucket && cacheKey) {
    const cached = await readCache(cacheBucket, cacheKey);
    if (cached) {
      return {
        cacheHit: true,
        videoSecondsWatched: 0,
        recorded: { start, end, question, answer: cached },
        result: {
          ok: true,
          text: `${windowHeader(start, end)}\n\n${cached}\n\n(Cached from an earlier watch of the identical window and question — no new footage was processed.)`,
          summary: `Watched ${fmtTimecode(start)}–${fmtTimecode(end)} (cached)`,
          digest: { start, end, cached: true },
          warnings: warnings.length > 0 ? warnings : undefined,
        },
      };
    }
  }

  const pieces = planRange(facts.chunks, start, end)
    .map((piece) => widenToMinimumClip(piece, MIN_CLIP_SEC))
    .filter((piece): piece is RangePiece => piece !== null);

  if (pieces.length === 0) {
    return fail(
      toolError(
        "range_unmapped",
        `No indexed video covers ${fmtTimecode(start)}–${fmtTimecode(end)}.`,
        facts.chunks.length === 0
          ? "This asset is not indexed with TwelveLabs, so watch_clip is unavailable. Use read_transcript and view_frames instead."
          : "Pick a window inside the source duration and try again.",
      ),
    );
  }

  if (pieces.length > 1) {
    warnings.push(
      `This window spans ${pieces.length} indexed chunks, so it was watched in ${pieces.length} passes and the answers concatenated.`,
    );
  }

  // What Pegasus actually watched, which can differ from what was asked for
  // once a piece is widened to the 4s minimum or clipped to the indexed
  // duration. Everything the model reads is labelled with these.
  const watchedStart = pieces[0].sourceStart;
  const watchedEnd = pieces[pieces.length - 1].sourceEnd;
  if (pieces.some((p) => p.clamped)) {
    warnings.push(
      `The indexed video only allows ${fmtTimecode(watchedStart)}–${fmtTimecode(
        watchedEnd,
      )}, so that is the window that was watched rather than ${fmtTimecode(start)}–${fmtTimecode(end)}.`,
    );
  }

  const answers: string[] = [];
  const failures: string[] = [];
  let secondsWatched = 0;

  for (const [index, piece] of pieces.entries()) {
    if (pieces.length > 1) {
      onProgress?.(
        `Watching part ${index + 1} of ${pieces.length}: ${fmtTimecode(piece.sourceStart)}–${fmtTimecode(piece.sourceEnd)}`,
      );
    }
    const outcome = await analyzePiece(client, piece, question, params.deadlineAt);
    if (outcome.ok) {
      secondsWatched += piece.localEnd - piece.localStart;
      answers.push(
        pieces.length > 1
          ? `[${fmtTimecode(piece.sourceStart)}–${fmtTimecode(piece.sourceEnd)}]\n${outcome.text}`
          : outcome.text,
      );
    } else {
      failures.push(
        `${fmtTimecode(piece.sourceStart)}–${fmtTimecode(piece.sourceEnd)}: ${outcome.message}`,
      );
    }
  }

  if (answers.length === 0) {
    const detail = failures.join("; ");
    const rateLimited = /rate limit|429/i.test(detail);
    return {
      cacheHit: false,
      videoSecondsWatched: 0,
      result: toolError(
        rateLimited ? "rate_limited" : "pegasus_failed",
        `Pegasus could not analyze this window. ${detail}`,
        rateLimited
          ? "Pegasus is rate limiting. Keep working with search_video, read_transcript and view_frames, and come back to watching later."
          : "Try a narrower window, or answer the question with read_transcript and view_frames instead.",
        { detail, retryable: true },
      ),
    };
  }

  const answer = answers.join("\n\n");
  if (failures.length > 0) {
    warnings.push(
      `${failures.length} of ${pieces.length} passes failed: ${failures.join("; ")}. The answer below covers only the parts that succeeded.`,
    );
  }

  if (cacheBucket && cacheKey && failures.length === 0) {
    await writeCache(cacheBucket, cacheKey, answer);
  }

  return {
    cacheHit: false,
    videoSecondsWatched: secondsWatched,
    recorded: { start: watchedStart, end: watchedEnd, question, answer },
    result: {
      ok: true,
      text: `${windowHeader(watchedStart, watchedEnd)}\n\n${answer}`,
      summary: `Watched ${fmtTimecode(watchedStart)}–${fmtTimecode(watchedEnd)} (${Math.round(secondsWatched)}s of footage)`,
      digest: {
        start: watchedStart,
        end: watchedEnd,
        question: question.slice(0, 80),
        answer: answer.slice(0, 200),
      },
      warnings: warnings.length > 0 ? warnings : undefined,
    },
  };
}

function truncateForNote(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 240 ? `${collapsed.slice(0, 239)}…` : collapsed;
}

function windowHeader(start: number, end: number): string {
  return `Watched ${fmtTimecode(start)}–${fmtTimecode(end)} (${(end - start).toFixed(
    1,
  )}s). Any elapsed times mentioned below are measured from ${fmtTimecode(
    start,
  )} (= ${start.toFixed(1)}s on the source timeline).`;
}

/** Below this there is no point starting another Pegasus attempt. */
const MIN_WATCH_ATTEMPT_MS = 30_000;

async function analyzePiece(
  client: TwelveLabs,
  piece: RangePiece,
  question: string,
  deadlineAt?: number,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  const prompt = `${question}

Answer only about the clip you were given. Be specific and concrete. If you refer to a moment, give it as seconds elapsed from the start of this clip. If the clip does not contain what was asked about, say so plainly rather than guessing.`;

  let lastMessage = "unknown error";
  const window = localWindow(piece);

  const remaining = () =>
    deadlineAt === undefined
      ? WATCH_CLIP_TIMEOUT_MS
      : Math.min(WATCH_CLIP_TIMEOUT_MS, deadlineAt - Date.now());

  for (let attempt = 1; attempt <= WATCH_CLIP_MAX_ATTEMPTS; attempt++) {
    const timeoutMs = remaining();
    if (timeoutMs < MIN_WATCH_ATTEMPT_MS) {
      return {
        ok: false,
        message:
          attempt === 1
            ? "there was not enough time left in this step to watch the clip"
            : `${lastMessage} (out of time for another attempt)`,
      };
    }

    // The SDK keeps working after a raced timeout, so an un-aborted attempt
    // would still be running — and still charging — while the retry starts.
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = (await withTimeout(
        client.analyze(
          {
            modelName: "pegasus1.5",
            video: { type: "asset_id", assetId: piece.chunk.videoId },
            prompt,
            startTime: window.start,
            endTime: window.end,
            maxTokens: 1500,
            temperature: 0.2,
          },
          {
            timeoutInSeconds: Math.ceil(timeoutMs / 1000),
            abortSignal: controller.signal,
            maxRetries: 0,
          },
        ) as Promise<{ data?: string }>,
        timeoutMs,
      )) as { data?: string };

      const text = (response.data ?? "").trim();
      if (text.length === 0) {
        lastMessage = "Pegasus returned an empty answer";
        continue;
      }
      return { ok: true, text };
    } catch (err) {
      lastMessage = errorMessage(err);
      const status = errorStatus(err);
      const isRateLimit = status === 429 || /rate limit/i.test(lastMessage);

      if (isRateLimit && attempt < WATCH_CLIP_MAX_ATTEMPTS) {
        await sleep(Math.min(retryAfterMs(err, attempt), backoffRoom(deadlineAt)));
        continue;
      }
      if (/timed out|abort/i.test(lastMessage) && attempt < WATCH_CLIP_MAX_ATTEMPTS) {
        await sleep(Math.min(2000 * attempt, backoffRoom(deadlineAt)));
        continue;
      }
      break;
    } finally {
      clearTimeout(abortTimer);
      controller.abort();
    }
  }

  return { ok: false, message: lastMessage };
}

/** How long we can afford to wait and still have room for another attempt. */
function backoffRoom(deadlineAt?: number): number {
  if (deadlineAt === undefined) return 90_000;
  return Math.max(0, deadlineAt - Date.now() - MIN_WATCH_ATTEMPT_MS);
}

function retryAfterMs(err: unknown, attempt: number): number {
  const e = err as {
    headers?: Record<string, string>;
    rawResponse?: { headers?: { get?: (name: string) => string | null } };
  };
  const header =
    e?.rawResponse?.headers?.get?.("retry-after") ?? e?.headers?.["retry-after"];
  const parsed = header ? Number.parseInt(header, 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(parsed * 1000 + 2000, 90_000);
  }
  return Math.min(5000 * 2 ** (attempt - 1), 45_000);
}

async function readCache(bucket: string, key: string): Promise<string | null> {
  try {
    const response = await s3Client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    const body = await response.Body?.transformToString();
    if (!body) return null;
    const parsed = JSON.parse(body) as { answer?: string };
    return typeof parsed.answer === "string" ? parsed.answer : null;
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name !== "NoSuchKey" && name !== "NotFound") {
      console.warn(`[IQAgent] clip cache read failed: ${errorMessage(err)}`);
    }
    return null;
  }
}

async function writeCache(
  bucket: string,
  key: string,
  answer: string,
): Promise<void> {
  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify({ answer, cachedAt: new Date().toISOString() }),
        ContentType: "application/json",
      }),
    );
  } catch (err) {
    console.warn(`[IQAgent] clip cache write failed: ${errorMessage(err)}`);
  }
}

function fail(result: ToolResult): WatchClipOutcome {
  return { result, videoSecondsWatched: 0, cacheHit: false };
}

/**
 * The chunk-local window to send, rounded inward so a value that was clamped to
 * the indexed duration cannot round back past the cap — TwelveLabs rejects a
 * start or end beyond what it indexed. The 4s minimum still has to hold after
 * rounding, so the window is nudged back out inside the chunk when it doesn't.
 */
export function localWindow(piece: RangePiece): { start: number; end: number } {
  const limit = piece.chunk.indexedDuration;
  let start = Math.ceil(piece.localStart * 100) / 100;
  let end = Math.floor(piece.localEnd * 100) / 100;

  if (end - start < MIN_CLIP_SEC) {
    end = Math.min(Math.floor(limit * 100) / 100, start + MIN_CLIP_SEC);
    if (end - start < MIN_CLIP_SEC) {
      start = Math.max(0, Math.ceil((end - MIN_CLIP_SEC) * 100) / 100);
    }
  }

  return { start, end };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
