/**
 * Caption translation on SporeLabs (gpt-4o-mini), line-aligned.
 *
 * Captions are translated in batches of 40 lines. Each request carries a
 * `max_tokens` bound proportional to the input so a runaway completion (a
 * Whisper hallucination such as 319 characters of "- - - -" makes the model
 * loop forever) is cut off instead of tripping the gateway's 60 s limit.
 *
 * A batch whose response times out, is truncated, cannot be parsed or comes
 * back with the wrong number of lines is split into halves and retried,
 * recursively down to single lines. A single line that still fails keeps its
 * source text and is logged; it never fails the whole asset. Output is always
 * aligned line by line with the input.
 */

import { languageLabel } from "../utils/transcript-format";
import {
  SPORELABS_TRANSLATE_MODEL,
  SporeLabsError,
  sporelabsChatCompletions,
} from "./sporelabs";

export const TRANSLATE_BATCH_SIZE = 40;
const TRANSLATE_TIMEOUT_MS = 55_000;
/** Total tries per request on a transient gateway error before splitting. */
const TRANSLATE_GATEWAY_ATTEMPTS = 2;

/**
 * Output token budget for a batch. Translations run a little longer than
 * their source and JSON quoting costs a few tokens per line, so allow one
 * token per source character plus a per-line and per-request overhead. That
 * is several times what a real translation needs, while a repetition loop
 * over a 40-line batch is stopped within a few seconds.
 */
export function translationMaxTokens(lines: string[]): number {
  const chars = lines.reduce((sum, line) => sum + line.length, 0);
  return chars + lines.length * 8 + 64;
}

/** Splits a batch into two halves; the first half gets the extra line. */
export function splitBatch<T>(lines: T[]): [T[], T[]] {
  const mid = Math.ceil(lines.length / 2);
  return [lines.slice(0, mid), lines.slice(mid)];
}

/** Why a batch could not be used as-is; each of these is retried by splitting. */
export class TranslationBatchError extends Error {
  constructor(
    readonly reason:
      | "timeout"
      | "truncated"
      | "unparseable"
      | "length-mismatch"
      | "empty-line"
      | "gateway",
    message: string,
  ) {
    super(message);
    this.name = "TranslationBatchError";
  }
}

/**
 * Parses `{"lines":[...]}` from the model. `finishReason === "length"` means
 * the completion hit `max_tokens`, so the JSON is incomplete or the last
 * line is cut mid-sentence; either way the batch is not trusted.
 */
export function parseTranslationBatch(
  content: string | null,
  finishReason: string,
  expected: number,
): string[] {
  if (finishReason === "length") {
    throw new TranslationBatchError(
      "truncated",
      `Translation hit max_tokens (${expected} lines)`,
    );
  }
  const text = (content ?? "").trim();
  let parsed: { lines?: unknown };
  try {
    parsed = JSON.parse(text) as { lines?: unknown };
  } catch {
    throw new TranslationBatchError(
      "unparseable",
      `Could not parse translation JSON: ${text.slice(0, 200)}`,
    );
  }
  if (!parsed || !Array.isArray(parsed.lines)) {
    throw new TranslationBatchError(
      "unparseable",
      "SporeLabs translation returned no lines",
    );
  }
  const lines = parsed.lines.map((line) => String(line ?? ""));
  if (lines.length !== expected) {
    throw new TranslationBatchError(
      "length-mismatch",
      `Translation length mismatch: got ${lines.length}, expected ${expected}`,
    );
  }
  return lines;
}

function translationLanguageName(code: string): string {
  const normalized = (code || "").trim().toLowerCase();
  if (!normalized || normalized === "und") {
    return "the original spoken language";
  }
  return languageLabel(normalized);
}

export function translationSystemPrompt(
  sourceLanguage: string,
  targetLanguage: string,
): string {
  const sourceName = translationLanguageName(sourceLanguage);
  const targetName = translationLanguageName(targetLanguage);
  return `You translate burnt-in video captions. Translate each line from ${sourceName} to ${targetName}. Keep proper names, numbers, and on-screen terms. Do not merge or split lines. Return JSON: {"lines":["..."]} with the same number of strings, same order.`;
}

/** One request for one batch. Throws TranslationBatchError when the batch should be split. */
async function requestTranslation(
  system: string,
  batch: string[],
): Promise<string[]> {
  let result;
  try {
    result = await sporelabsChatCompletions({
      model: SPORELABS_TRANSLATE_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify({ lines: batch }) },
      ],
      temperature: 0.2,
      maxTokens: translationMaxTokens(batch),
      responseFormat: { type: "json_object" },
      timeoutMs: TRANSLATE_TIMEOUT_MS,
      attempts: TRANSLATE_GATEWAY_ATTEMPTS,
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new TranslationBatchError(
        "timeout",
        `Translation timed out after ${TRANSLATE_TIMEOUT_MS} ms (${batch.length} lines)`,
      );
    }
    if (error instanceof SporeLabsError && error.status >= 500) {
      throw new TranslationBatchError("gateway", error.message);
    }
    // 4xx (bad key, bad request) is a configuration problem: fail the run.
    throw error;
  }

  const lines = parseTranslationBatch(
    result.content,
    result.finishReason,
    batch.length,
  );
  const emptyIndex = lines.findIndex(
    (line, index) => batch[index].trim().length > 0 && line.trim().length === 0,
  );
  if (emptyIndex >= 0) {
    throw new TranslationBatchError(
      "empty-line",
      `Translation returned an empty caption for a non-empty line (batch index ${emptyIndex})`,
    );
  }
  return lines;
}

export type TranslateCaptionsResult = {
  lines: string[];
  /** Zero-based indexes of lines that kept their source text. */
  untranslated: number[];
};

type TranslateDeps = {
  /** Translate one batch; throws TranslationBatchError to request a split. */
  request: (batch: string[]) => Promise<string[]>;
  log: (message: string) => void;
};

/**
 * Translates `lines` (a slice starting at global index `offset`) and returns
 * exactly `lines.length` strings in the same order.
 */
export async function translateBatchAligned(
  lines: string[],
  offset: number,
  deps: TranslateDeps,
  untranslated: number[],
): Promise<string[]> {
  if (lines.length === 0) return [];
  try {
    const translated = await deps.request(lines);
    if (translated.length !== lines.length) {
      throw new TranslationBatchError(
        "length-mismatch",
        `Translation length mismatch: got ${translated.length}, expected ${lines.length}`,
      );
    }
    return translated;
  } catch (err) {
    if (!(err instanceof TranslationBatchError)) throw err;
    if (lines.length === 1) {
      deps.log(
        `[translate] line ${offset} kept source text after ${err.reason}: ${err.message} :: ${JSON.stringify(lines[0].slice(0, 80))}`,
      );
      untranslated.push(offset);
      return [lines[0]];
    }
    const [head, tail] = splitBatch(lines);
    deps.log(
      `[translate] batch of ${lines.length} at ${offset} failed (${err.reason}); splitting into ${head.length} + ${tail.length}`,
    );
    const headOut = await translateBatchAligned(head, offset, deps, untranslated);
    const tailOut = await translateBatchAligned(
      tail,
      offset + head.length,
      deps,
      untranslated,
    );
    return [...headOut, ...tailOut];
  }
}

export async function translateCaptionLinesDetailed(
  params: {
    sourceLanguage: string;
    targetLanguage: string;
    lines: string[];
  },
  deps?: Partial<TranslateDeps>,
): Promise<TranslateCaptionsResult> {
  if (params.lines.length === 0) return { lines: [], untranslated: [] };

  const system = translationSystemPrompt(
    params.sourceLanguage,
    params.targetLanguage,
  );
  const resolved: TranslateDeps = {
    request: deps?.request ?? ((batch) => requestTranslation(system, batch)),
    log: deps?.log ?? ((message) => console.warn(message)),
  };

  const out: string[] = [];
  const untranslated: number[] = [];
  for (let i = 0; i < params.lines.length; i += TRANSLATE_BATCH_SIZE) {
    const batch = params.lines.slice(i, i + TRANSLATE_BATCH_SIZE);
    out.push(...(await translateBatchAligned(batch, i, resolved, untranslated)));
  }
  if (out.length !== params.lines.length) {
    // Cannot happen given translateBatchAligned's contract; guard anyway.
    throw new Error(
      `Translation produced ${out.length} lines for ${params.lines.length} inputs`,
    );
  }
  if (untranslated.length > 0) {
    resolved.log(
      `[translate] ${untranslated.length}/${params.lines.length} lines kept source text: ${untranslated.join(", ")}`,
    );
  }
  return { lines: out, untranslated };
}

export async function translateCaptionLines(params: {
  sourceLanguage: string;
  targetLanguage: string;
  lines: string[];
}): Promise<string[]> {
  return (await translateCaptionLinesDetailed(params)).lines;
}
