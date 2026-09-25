/**
 * Caption translation: max_tokens bound, split-on-failure and line alignment.
 *
 * Run: npx tsx src/services/translate-captions.test.ts
 */
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
  parseTranslationBatch,
  splitBatch,
  translateBatchAligned,
  translateCaptionLinesDetailed,
  translationMaxTokens,
  TranslationBatchError,
  TRANSLATE_BATCH_SIZE,
} from "./translate-captions";

let checks = 0;
let failures = 0;

function assert(condition: boolean, message: string): void {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}

process.env.SPORELABS_SECRET_ARN = "arn:aws:secretsmanager:us-west-2:1:secret:sl";
(SecretsManagerClient.prototype as unknown as { send: unknown }).send =
  async () => ({ SecretString: "sk-test" });

// A Whisper hallucination: 160 dashes separated by spaces, 319 characters.
const DASHES = Array.from({ length: 160 }, () => "-").join(" ");
assert(DASHES.length === 319, "fixture is 319 characters");

const T = (line: string) => `es:${line}`;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

{
  const small = translationMaxTokens(["Hello there.", "Bye."]);
  const big = translationMaxTokens([DASHES, "Hello there.", "Bye."]);
  assert(small === 16 + 2 * 8 + 64, "max_tokens = chars + 8/line + 64");
  assert(big - small === 319 + 8, "max_tokens grows with input size");
  assert(translationMaxTokens([]) === 64, "empty batch keeps the base budget");

  const [a, b] = splitBatch([1, 2, 3, 4, 5]);
  assert(a.length === 3 && b.length === 2, "odd batch splits 3 + 2");
  const [c, d] = splitBatch(Array.from({ length: 40 }, (_, i) => i));
  assert(c.length === 20 && d.length === 20 && c[19] === 19 && d[0] === 20, "40 splits 20 + 20 in order");
  const [e, f] = splitBatch(["only"]);
  assert(e.length === 1 && f.length === 0, "single line splits into itself and nothing");

  const good = parseTranslationBatch('{"lines":["a","b"]}', "stop", 2);
  assert(good.length === 2 && good[1] === "b", "parses a complete batch");
  const reasonOf = (fn: () => unknown) => {
    try {
      fn();
      return "none";
    } catch (err) {
      return err instanceof TranslationBatchError ? err.reason : "other";
    }
  };
  assert(reasonOf(() => parseTranslationBatch('{"lines":["a","b"]}', "length", 2)) === "truncated", "finish_reason=length is truncated even when parseable");
  assert(reasonOf(() => parseTranslationBatch('{"lines":["a","b', "stop", 2)) === "unparseable", "cut-off JSON is unparseable");
  assert(reasonOf(() => parseTranslationBatch('{"lines":["a"]}', "stop", 2)) === "length-mismatch", "wrong line count is a mismatch");
  assert(reasonOf(() => parseTranslationBatch('{"text":"x"}', "stop", 1)) === "unparseable", "missing lines array is unparseable");
  assert(reasonOf(() => parseTranslationBatch(null, "stop", 1)) === "unparseable", "null content is unparseable");
}

// ---------------------------------------------------------------------------
// Split-on-failure keeps every line in place
// ---------------------------------------------------------------------------

async function splittingTests() {
  // A 40-line batch where line 27 is the 319-character caption. Any request
  // that includes it times out; everything else translates.
  const lines = Array.from({ length: TRANSLATE_BATCH_SIZE }, (_, i) =>
    i === 27 ? DASHES : `line ${i}`,
  );
  const logs: string[] = [];
  const sizes: number[] = [];
  const untranslated: number[] = [];
  const out = await translateBatchAligned(
    lines,
    0,
    {
      request: async (batch) => {
        sizes.push(batch.length);
        if (batch.includes(DASHES)) {
          throw new TranslationBatchError("timeout", "timed out");
        }
        return batch.map(T);
      },
      log: (m) => logs.push(m),
    },
    untranslated,
  );
  assert(out.length === lines.length, "output has one entry per input line");
  assert(lines.every((line, i) => (i === 27 ? out[i] === DASHES : out[i] === T(line))), "every translated line stays on its own index; the 319-char line keeps its source");
  assert(untranslated.length === 1 && untranslated[0] === 27, "only the failing line is reported untranslated");
  // Depth first: [0-39] fails, [0-19] ok, [20-39] fails, [20-29] fails,
  // [20-24] ok, [25-29] fails, [25-27] fails, [25-26] ok, [27] fails,
  // [28-29] ok, [30-39] ok.
  assert(sizes.join(",") === "40,20,20,10,5,5,3,2,1,2,10", `halves recursively down to the single failing line (got ${sizes.join(",")})`);
  assert(logs.some((m) => m.includes("line 27 kept source text after timeout")), "the kept line is marked in the logs");

  // Global offsets: a failure in the second batch is reported at its global index.
  const many = Array.from({ length: 90 }, (_, i) => (i === 63 ? DASHES : `l${i}`));
  const logs2: string[] = [];
  const result = await translateCaptionLinesDetailed(
    { sourceLanguage: "en", targetLanguage: "es", lines: many },
    {
      request: async (batch) => {
        if (batch.includes(DASHES)) {
          throw new TranslationBatchError("truncated", "hit max_tokens");
        }
        return batch.map(T);
      },
      log: (m) => logs2.push(m),
    },
  );
  assert(result.lines.length === 90, "multi-batch output keeps the input length");
  assert(result.untranslated.join(",") === "63", "untranslated index is global, not batch-relative");
  assert(result.lines[63] === DASHES && result.lines[62] === T("l62") && result.lines[64] === T("l64") && result.lines[89] === T("l89"), "neighbours of the failed line are not shifted");
  assert(logs2.some((m) => m.includes("1/90 lines kept source text: 63")), "summary log lists kept lines");

  // A request that answers with the wrong number of lines is split rather
  // than padded; the halves come back aligned.
  const shifted = ["a", "b", "c", "d"];
  const calls: string[][] = [];
  const out2 = await translateBatchAligned(
    shifted,
    100,
    {
      request: async (batch) => {
        calls.push(batch);
        if (batch.length === 4) return ["A", "C", "D"]; // dropped a line
        return batch.map((s) => s.toUpperCase());
      },
      log: () => undefined,
    },
    [],
  );
  assert(out2.join("") === "ABCD", "length mismatch is retried by splitting, never by shifting");
  assert(calls.length === 3, "mismatch costs one split (1 + 2 requests)");

  // A non-splittable error (bad request / bad key) fails the run.
  let threw = false;
  try {
    await translateBatchAligned(
      ["x", "y"],
      0,
      {
        request: async () => {
          throw new Error("SporeLabs chat 401");
        },
        log: () => undefined,
      },
      [],
    );
  } catch {
    threw = true;
  }
  assert(threw, "configuration errors are not swallowed by splitting");
}

// ---------------------------------------------------------------------------
// Through the SporeLabs client with a mocked gateway
// ---------------------------------------------------------------------------

type Captured = { body: Record<string, unknown> };
const calls: Captured[] = [];
let respond: (body: { lines: string[] }) => { status: number; body: unknown } = () => ({
  status: 500,
  body: {},
});

globalThis.fetch = (async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  calls.push({ body });
  const user = (body.messages as Array<{ content: string }>)[1].content;
  const next = respond(JSON.parse(user) as { lines: string[] });
  return new Response(JSON.stringify(next.body), { status: next.status });
}) as typeof fetch;

function ok(lines: string[], finish = "stop") {
  return {
    status: 200,
    body: {
      choices: [{ finish_reason: finish, message: { content: JSON.stringify({ lines }) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  };
}

async function gatewayTests() {
  // Every request carries max_tokens proportional to its own batch.
  calls.length = 0;
  respond = ({ lines }) => ok(lines.map(T));
  const plain = Array.from({ length: 45 }, (_, i) => `caption ${i}`);
  const res = await translateCaptionLinesDetailed({ sourceLanguage: "en", targetLanguage: "es", lines: plain });
  assert(res.lines.length === 45 && res.lines[44] === T("caption 44"), "45 lines translate over two batches");
  assert(calls.length === 2, "two requests for 45 lines");
  assert(calls[0].body.max_tokens === translationMaxTokens(plain.slice(0, 40)), "batch 1 max_tokens matches its input");
  assert(calls[1].body.max_tokens === translationMaxTokens(plain.slice(40)), "batch 2 max_tokens matches its input");
  assert(calls[0].body.model === "openai/gpt-4o-mini", "translation stays on gpt-4o-mini");
  assert(calls[0].body.temperature === 0.2, "temperature kept");
  assert((calls[0].body.response_format as { type: string }).type === "json_object", "JSON mode kept");

  // The 319-char line makes the model loop; with max_tokens it comes back
  // truncated (finish_reason=length) or as cut-off JSON. Both split.
  calls.length = 0;
  let truncations = 0;
  respond = ({ lines }) => {
    if (lines.includes(DASHES)) {
      truncations++;
      // Alternate between a truncated-but-parseable body and cut-off JSON.
      return truncations % 2 === 1
        ? ok(lines.map(T), "length")
        : {
            status: 200,
            body: {
              choices: [{ finish_reason: "length", message: { content: '{"lines":["- - - - - -' } }],
            },
          };
    }
    return ok(lines.map(T));
  };
  const batch = Array.from({ length: 40 }, (_, i) => (i === 10 ? DASHES : `c${i}`));
  const logs: string[] = [];
  const out = await translateCaptionLinesDetailed(
    { sourceLanguage: "en", targetLanguage: "es", lines: batch },
    { log: (m) => logs.push(m) },
  );
  assert(out.lines.length === 40, "truncated batch resolves to 40 lines");
  assert(batch.every((line, i) => (i === 10 ? out.lines[i] === DASHES : out.lines[i] === T(line))), "after truncation splits, every line is aligned and the 319-char line keeps its source");
  assert(out.untranslated.join(",") === "10", "the 319-char line is the only untranslated one");
  assert(calls.every((c) => typeof c.body.max_tokens === "number" && (c.body.max_tokens as number) > 64), "every retry request still sends max_tokens");
  const dashOnly = calls.filter((c) => (JSON.parse((c.body.messages as Array<{ content: string }>)[1].content) as { lines: string[] }).lines.join("") === DASHES);
  assert(dashOnly.length === 1 && dashOnly[0].body.max_tokens === 319 + 8 + 64, "the single 319-char line is tried once with a 391-token bound");
  assert(logs.some((m) => /line 10 kept source text after (truncated|unparseable)/.test(m)), "single-line truncation is logged");

  // A timeout on the gateway (abort) also splits instead of failing the asset.
  calls.length = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const user = JSON.parse((body.messages as Array<{ content: string }>)[1].content) as { lines: string[] };
    if (user.lines.includes(DASHES)) {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    }
    return realFetch(url, init);
  }) as typeof fetch;
  respond = ({ lines }) => ok(lines.map(T));
  const out3 = await translateCaptionLinesDetailed(
    { sourceLanguage: "en", targetLanguage: "es", lines: ["one", DASHES, "three"] },
    { log: () => undefined },
  );
  assert(out3.lines.join("|") === `${T("one")}|${DASHES}|${T("three")}`, "abort splits down to the line and keeps its source");
  globalThis.fetch = realFetch;

  // An empty translation for a non-empty line is a batch failure, and at
  // the single-line level the source is kept, so the asset never fails
  // on the handler's empty-line check.
  calls.length = 0;
  respond = ({ lines }) => ok(lines.map((l) => (l === "drop me" || l === "" ? "" : T(l))));
  const out4 = await translateCaptionLinesDetailed(
    { sourceLanguage: "en", targetLanguage: "es", lines: ["keep", "drop me", "", "also"] },
    { log: () => undefined },
  );
  assert(out4.lines.join("|") === `${T("keep")}|drop me||${T("also")}`, "empty output for a non-empty line keeps the source; empty source stays empty");
  assert(out4.untranslated.join(",") === "1", "only the emptied line is reported");

  // A 4xx from the gateway fails the run (misconfiguration, not content).
  calls.length = 0;
  respond = () => ({ status: 401, body: { error: { message: "bad key" } } });
  let threw = false;
  try {
    await translateCaptionLinesDetailed({ sourceLanguage: "en", targetLanguage: "es", lines: ["x"] });
  } catch (err) {
    threw = /401/.test(String((err as Error).message));
  }
  assert(threw && calls.length === 1, "401 fails without splitting");
}

async function main() {
  await splittingTests();
  await gatewayTests();
  if (failures > 0) {
    console.error(`translate-captions: ${failures}/${checks} checks failed`);
    process.exit(1);
  }
  console.log(`translate-captions: ${checks} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
