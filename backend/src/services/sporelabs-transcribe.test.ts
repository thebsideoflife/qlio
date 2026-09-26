/**
 * SporeLabs transcription: client request shape, result -> original.json words,
 * and the cleanup rule that keeps raw SporeLabs responses.
 *
 * Run: npx tsx src/services/sporelabs-transcribe.test.ts
 */
import {
  REFERENCE_WHISPER_OPTIONS,
  buildTranscribeRequestBody,
  getTranscription,
  submitTranscription,
  submitTranscriptionBody,
  transcribeIdempotencyKey,
  type TranscribeResult,
} from "./sporelabs-transcribe";
import {
  SporeLabsError,
  isIdempotencyConflict,
  submitReframe,
  type ReframeClientOptions,
} from "./sporelabs-reframe";
import { wordsFromSporeLabsResult } from "../utils/sporelabs-transcript";
import {
  selectSupersededTranscriptKeys,
  sporelabsJobStateKey,
  sporelabsRawResponseKey,
  sporelabsSubmitIntentKey,
  originalTranscriptKey,
} from "../utils/transcript-format";
import {
  MAX_SPORELABS_HOPS,
  sporelabsPollWindowPerHopMs,
  sporelabsPollingBudgetMs,
} from "../utils/transcript-timing";
import { parseSporeLabsSubmitIntent } from "../utils/transcription-run";

let checks = 0;
let failures = 0;

function assert(condition: boolean, message: string): void {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}

const PRESIGNED =
  "https://media.s3.amazonaws.com/transcription-audio/a.wav?X-Amz-Signature=deadbeef";

type Call = { url: string; init: RequestInit };

function mockFetch(responses: Array<() => Response>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return responses[Math.min(i++, responses.length - 1)]();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function header(call: Call, name: string): string | undefined {
  return (call.init.headers as Record<string, string> | undefined)?.[name];
}

async function rejects(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return null;
}

function json(status: number, body: unknown) {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

function opts(fetchImpl: typeof fetch): ReframeClientOptions {
  return {
    apiKey: "sk-test",
    baseUrl: "https://sporelabs.test/v1",
    fetchImpl,
    sleep: async () => undefined,
  };
}

function segment(
  id: number,
  text: string,
  words: Array<[string, number, number]>,
  flag: string | null = null,
  at?: number,
) {
  return {
    id,
    seek: 0,
    start: words[0]?.[1] ?? at ?? 0,
    end: words[words.length - 1]?.[2] ?? at ?? 0,
    text,
    temperature: 0,
    avg_logprob: -0.2,
    compression_ratio: 1.3,
    no_speech_prob: 0.01,
    hallucination_flag: flag,
    words: words.map(([word, start, end]) => ({ word, start, end, probability: 0.9 })),
  };
}

async function main() {
  // Submit: path, model, the reference options, duration hint; never the key in the body.
  {
    const { fetchImpl, calls } = mockFetch([
      json(202, { id: "tr_1", object: "audio.transcription", status: "queued" }),
    ]);
    const res = await submitTranscription(
      { audio_url: PRESIGNED, duration_seconds: 2543.85 },
      opts(fetchImpl),
    );
    assert(res.id === "tr_1", "submit returns job id");
    assert(calls[0].url === "https://sporelabs.test/v1/audio/transcribe", "POST {base}/audio/transcribe");
    const body = JSON.parse(String(calls[0].init.body));
    assert(body.model === "large-v3", "asks for full large-v3");
    assert(body.audio_url === PRESIGNED, "audio_url passes through");
    assert(body.duration_seconds === 2543.85, "duration hint for the wallet preflight");
    assert(body.options.language === "en", "language en");
    assert(body.options.word_timestamps === true, "word timestamps");
    assert(body.options.condition_on_previous_text === false, "no conditioning on previous text");
    assert(body.options.hallucination_silence_threshold === 2, "hallucination silence threshold 2");
    assert(body.options.compression_ratio_threshold === 2.0, "compression ratio threshold 2.0");
    assert(
      JSON.stringify(body.options) === JSON.stringify(REFERENCE_WHISPER_OPTIONS),
      "sends exactly the reference options",
    );
    assert(!String(calls[0].init.body).includes("sk-test"), "key stays in the header");
  }

  // Language: the asset's known language overrides "en"; null asks SporeLabs to detect.
  {
    const { fetchImpl, calls } = mockFetch([
      json(202, { id: "tr_2", object: "audio.transcription", status: "queued" }),
    ]);
    await submitTranscription({ audio_url: PRESIGNED, language: "es" }, opts(fetchImpl));
    await submitTranscription({ audio_url: PRESIGNED, language: null }, opts(fetchImpl));
    assert(JSON.parse(String(calls[0].init.body)).options.language === "es", "known language sent");
    assert(JSON.parse(String(calls[1].init.body)).options.language === null, "null = detect");
    assert(JSON.parse(String(calls[1].init.body)).options.word_timestamps === true, "other options unchanged");
  }

  // Submit without an id is an error, not a silent success.
  {
    const { fetchImpl } = mockFetch([json(202, { status: "queued" })]);
    let err: unknown = null;
    try {
      await submitTranscription({ audio_url: PRESIGNED }, opts(fetchImpl));
    } catch (e) {
      err = e;
    }
    assert(err instanceof SporeLabsError, "missing job id throws SporeLabsError");
  }

  // Poll: GET {base}/audio/transcribe/{id}; ids are validated before any request.
  {
    const { fetchImpl, calls } = mockFetch([
      json(200, { id: "tr_1", object: "audio.transcription", status: "in_progress" }),
    ]);
    const job = await getTranscription("tr_1", opts(fetchImpl));
    assert(job.status === "in_progress", "status read back");
    assert(calls[0].url === "https://sporelabs.test/v1/audio/transcribe/tr_1", "GET by id");
    let err: unknown = null;
    try {
      await getTranscription("../reframe/rf_1", opts(fetchImpl));
    } catch (e) {
      err = e;
    }
    assert(err instanceof SporeLabsError && calls.length === 1, "bad id rejected locally");
  }

  // Result -> words: video-clock offset, trimmed values, flagged loops held out but kept.
  {
    const note = '4x repeated "I\'m sorry." — hallucination loop (compression_ratio 6.95, single raw decode block, seek=56332).';
    const result = {
      language: "en",
      text: "Oh, I can hear them playing.",
      segments: [
        segment(0, "Oh, I can hear.", [["Oh,", 6.76, 7.26], ["I", 7.26, 7.76], [" hear.", 7.76, 8.32]]),
        segment(1, "", [], note, 563.32), // zero-length opener, as in the reference
        segment(2, "I'm sorry.", [["I'm", 563.32, 564.02], ["sorry.", 564.02, 564.46]], note),
        segment(3, "I'm sorry.", [["I'm", 564.64, 565.48], ["sorry.", 565.48, 568.08]], note),
        segment(4, "Where to?", [["Where", 570.0, 570.3], ["to?", 570.3, 570.3]]),
      ],
    } as unknown as TranscribeResult;
    const { words, hallucinations } = wordsFromSporeLabsResult(result, 0.042);
    assert(words.length === 5, `clean words kept (${words.length})`);
    assert(words[0].start === 6.802 && words[0].end === 7.302, "offset by the audio start in the video");
    assert(words[2].value === "hear.", "values trimmed");
    assert(words[4].end >= words[4].start, "zero-length word kept, end >= start");
    assert(!words.some((w) => w.value === "sorry."), "flagged loop kept out of words");
    assert(hallucinations.length === 1, "one flagged stretch");
    assert(hallucinations[0].note === note, "stretch carries the note");
    assert(hallucinations[0].words.length === 4, "stretch keeps its words for restore");
    assert(hallucinations[0].start === 563.362, "stretch start on the video clock");
  }


  // Idempotency key: one per run, stable across hops/retries.
  {
    const key = transcribeIdempotencyKey("asset-1", "v-123");
    assert(key === "zeevee-transcribe:asset-1:v-123", `key format (${key})`);
    assert(
      (await rejects(async () => transcribeIdempotencyKey("asset-1", ""))) instanceof Error,
      "key needs a version",
    );
  }

  // Submit sends Idempotency-Key; polls never do.
  {
    const key = transcribeIdempotencyKey("a1", "v1");
    const { fetchImpl, calls } = mockFetch([
      json(202, { id: "tr_1", object: "audio.transcription", status: "queued" }),
      json(200, { id: "tr_1", object: "audio.transcription", status: "queued" }),
    ]);
    await submitTranscription({ audio_url: PRESIGNED }, opts(fetchImpl), key);
    await getTranscription("tr_1", opts(fetchImpl));
    assert(header(calls[0], "Idempotency-Key") === key, "submit carries Idempotency-Key");
    assert(header(calls[1], "Idempotency-Key") === undefined, "poll has no Idempotency-Key");
    assert(!String(calls[0].init.body).includes(key), "key is a header, not in the body");
  }

  // HTTP retries (timeout, 503, 429) resend the same key and the same body.
  {
    const key = transcribeIdempotencyKey("a1", "v1");
    let n = 0;
    const calls: Call[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      n++;
      if (n === 1) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      if (n === 2) return json(503, { error: { message: "busy" } })();
      if (n === 3) return json(429, { error: { message: "slow down" } })();
      return json(202, { id: "tr_9", object: "audio.transcription", status: "queued" })();
    }) as unknown as typeof fetch;
    const res = await submitTranscription(
      { audio_url: PRESIGNED, duration_seconds: 10800, language: "en" },
      opts(fetchImpl),
      key,
    );
    assert(res.id === "tr_9", "retried submit returns the job");
    assert(calls.length === 4, `four attempts (${calls.length})`);
    assert(
      calls.every((c) => header(c, "Idempotency-Key") === key),
      "every attempt carries the same Idempotency-Key",
    );
    assert(
      calls.every((c) => c.init.body === calls[0].init.body),
      "every attempt sends the identical body",
    );
  }

  // 409 with a key: fatal idempotency conflict, never retried.
  {
    const { fetchImpl, calls } = mockFetch([
      json(409, { error: { message: "key reused with a different body", type: "invalid_request_error" } }),
      json(202, { id: "tr_dup", object: "audio.transcription", status: "queued" }),
    ]);
    const origError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => void logged.push(args.join(" "));
    let err: unknown;
    try {
      err = await rejects(() =>
        submitTranscription({ audio_url: PRESIGNED }, opts(fetchImpl), transcribeIdempotencyKey("a1", "v1")),
      );
    } finally {
      console.error = origError;
    }
    assert(isIdempotencyConflict(err), "409 with key is an idempotency conflict");
    assert(err instanceof SporeLabsError && err.status === 409 && !err.retryable, "409 not retryable");
    assert(calls.length === 1, `409 is not retried (${calls.length} calls)`);
    assert(
      logged.some((l) => l.includes("zeevee-transcribe:a1:v1") && l.includes("different request body")),
      "409 conflict is logged with the key",
    );
    assert(!logged.some((l) => l.includes("X-Amz-Signature")), "presigned URL not logged");
  }

  // 409 without a key is an ordinary error (not tagged as an idempotency conflict).
  {
    const { fetchImpl, calls } = mockFetch([json(409, { error: { message: "conflict" } })]);
    const err = await rejects(() => submitTranscription({ audio_url: PRESIGNED }, opts(fetchImpl)));
    assert(err instanceof SporeLabsError && err.status === 409, "keyless 409 throws");
    assert(!isIdempotencyConflict(err), "keyless 409 is not an idempotency conflict");
    assert(calls.length === 1, "keyless 409 not retried");
  }

  // A malformed key is rejected before any request.
  {
    const { fetchImpl, calls } = mockFetch([json(202, { id: "tr_1", status: "queued" })]);
    const err = await rejects(() =>
      submitTranscription({ audio_url: PRESIGNED }, opts(fetchImpl), "has space\n"),
    );
    assert(err instanceof SporeLabsError && calls.length === 0, "bad key rejected locally");
  }

  // Reframe submits are unchanged: no Idempotency-Key.
  {
    const { fetchImpl, calls } = mockFetch([
      json(202, { id: "rf_1", object: "video.reframe", status: "queued" }),
    ]);
    await submitReframe(
      {
        video_url: PRESIGNED,
        asset_key: "zeevee/a/e",
        fps: 24,
        source_aspect: 16 / 9,
        target_aspect: "9:16",
        segments: [{ id: "s1", start: 0, end: 1 }],
      },
      opts(fetchImpl),
    );
    assert(header(calls[0], "Idempotency-Key") === undefined, "reframe has no Idempotency-Key");
  }

  // Crash recovery: the recorded intent round-trips through S3 JSON and a resubmit
  // sends byte-identical body + key to the first attempt.
  {
    const key = transcribeIdempotencyKey("a1", "v1");
    const intent = {
      idempotencyKey: key,
      createdAt: "2026-09-25T00:00:00.000Z",
      audioKey: "transcription-audio/a1/v1.wav",
      audio: { startInVideo: 0.042, sampleRate: 16000, samples: 172_800_000, duration: 10800 },
      level: { peakAmplitude: 0.5, rmsAmplitude: 0.05 },
      request: buildTranscribeRequestBody({ audio_url: PRESIGNED, duration_seconds: 10800, language: null }),
    };
    const stored = parseSporeLabsSubmitIntent(JSON.parse(JSON.stringify(intent)));
    assert(stored !== null, "valid intent parses");
    const { fetchImpl, calls } = mockFetch([
      json(202, { id: "tr_7", object: "audio.transcription", status: "queued" }),
    ]);
    const first = await submitTranscriptionBody(intent.request, key, opts(fetchImpl));
    const again = await submitTranscriptionBody(stored!.request, key, opts(fetchImpl));
    assert(first.id === "tr_7" && again.id === "tr_7", "idempotent server returns the same job");
    assert(calls[0].init.body === calls[1].init.body, "resubmit body identical to the first");
    assert(
      header(calls[0], "Idempotency-Key") === key && header(calls[1], "Idempotency-Key") === key,
      "resubmit uses the same key",
    );
    const sameAsHelper = mockFetch([json(202, { id: "tr_8", status: "queued" })]);
    await submitTranscription(
      { audio_url: PRESIGNED, duration_seconds: 10800, language: null },
      opts(sameAsHelper.fetchImpl),
    );
    assert(
      sameAsHelper.calls[0].init.body === calls[0].init.body,
      "buildTranscribeRequestBody matches what submitTranscription sends",
    );

    assert(parseSporeLabsSubmitIntent(null) === null, "null is not an intent");
    assert(
      parseSporeLabsSubmitIntent({ ...intent, request: { ...intent.request, audio_url: "" } }) === null,
      "intent without audio_url rejected",
    );
    assert(
      parseSporeLabsSubmitIntent({ jobId: "tr_1", submittedAt: "x" }) === null,
      "a job-state file is not an intent",
    );
  }

  // Polling budget: 3 h of audio at ~2.5x realtime plus cold start, with 2x headroom.
  {
    const threeHoursAudioMs = 3 * 60 * 60 * 1000;
    const needMs = threeHoursAudioMs / 2.5 + 15 * 60 * 1000;
    const budgetMs = sporelabsPollingBudgetMs();
    assert(sporelabsPollWindowPerHopMs() >= 12 * 60 * 1000, "each hop polls >= 12 min");
    assert(
      budgetMs >= 2 * needMs,
      `hop budget ${(budgetMs / 3.6e6).toFixed(2)} h covers 2x ${(needMs / 3.6e6).toFixed(2)} h`,
    );
    assert(budgetMs <= 8 * 60 * 60 * 1000, "a stuck job still stops within 8 h");
    assert(MAX_SPORELABS_HOPS === 20, "hop cap unchanged for invocations already mid-run");
  }

  // Cleanup: raw SporeLabs responses survive every later run; job state and old originals do not.
  {
    const assetId = "a1";
    const oldRaw = sporelabsRawResponseKey(assetId, "v1");
    const keep = [originalTranscriptKey(assetId, "v2"), sporelabsRawResponseKey(assetId, "v2")];
    const stale = selectSupersededTranscriptKeys({
      assetId,
      listedKeys: [
        ...keep,
        oldRaw,
        originalTranscriptKey(assetId, "v1"),
        sporelabsJobStateKey(assetId, "v2"),
        sporelabsSubmitIntentKey(assetId, "v2"),
        `transcriptions/${assetId}.json`,
      ],
      keepKeys: keep,
    });
    assert(!stale.includes(oldRaw), "an older run's raw response is never deleted");
    assert(stale.includes(originalTranscriptKey(assetId, "v1")), "an older original is deleted");
    assert(stale.includes(sporelabsJobStateKey(assetId, "v2")), "job state is deleted");
    assert(
      stale.includes(sporelabsSubmitIntentKey(assetId, "v2")),
      "submit record (holds a presigned URL) is deleted",
    );
    assert(
      sporelabsSubmitIntentKey(assetId, "v2") === "transcriptions/a1/versions/v2/sporelabs-submit.json",
      "submit record lives next to the job state",
    );
    assert(!stale.some((k) => keep.includes(k)), "keep keys survive");
  }

  console.log(`sporelabs-transcribe: ${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
