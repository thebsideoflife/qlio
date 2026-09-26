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
import {
  isStockPhraseHallucination,
  wordsFromSporeLabsResult,
} from "../utils/sporelabs-transcript";
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

  // --- stock phrases over music: held out only when Whisper doubts speech AND they sit alone
  {
    const seg = (start: number, end: number, text: string, nsp: number, ws: string[]) => ({
      id: 0, seek: 0, start, end, text, temperature: 0, avg_logprob: -0.5, compression_ratio: 1,
      no_speech_prob: nsp, hallucination_flag: null,
      words: ws.map((w, i) => ({ word: w, start: start + i * 0.2, end: start + i * 0.2 + 0.2, probability: 0.5 })),
    });
    const result: any = {
      model: "large-v3", engine: "x", options: {}, language: "en", duration: 3000,
      num_segments: 6, num_words: 0, hallucination_flags: [], text: "",
      segments: [
        seg(1000, 1003, "Get away from the car.", 0.1, ["Get", "away", "from", "the", "car."]),
        seg(1003.2, 1003.8, "I'm sorry.", 0.02, ["I'm", "sorry."]),
        seg(1751.3, 1752.5, "Thanks for watching!", 0.74, ["Thanks", "for", "watching!"]),
        seg(2053.6, 2055, "© BF -WATCH TV 2021", 0.86, ["©", "BF", "-WATCH", "TV", "2021"]),
        seg(2272, 2272.6, "Thank you.", 0.55, ["Thank", "you."]),
        seg(2300, 2302, "Thank you, Rico.", 0.9, ["Thank", "you,", "Rico."]),
      ],
    };
    const { words, hallucinations } = wordsFromSporeLabsResult(result, 0);
    const text = words.map((w) => w.value).join(" ");
    assert(text.includes("I'm sorry."), "a stock phrase inside dialogue is kept");
    assert(!text.includes("watching") && !text.includes("WATCH"), "alone + doubted stock phrases are held out");
    assert(text.includes("Thank you.") && text.includes("Rico."), "low no-speech or non-stock lines are kept");
    assert(
      hallucinations.length === 2 && hallucinations.every((h) => h.note.startsWith("stock phrase")),
      "held-out stock phrases are listed with a note",
    );
    assert(isStockPhraseHallucination({ text: "Thank you. Thank you.", no_speech_prob: 0.9 }, 20), "repeated stock phrase matches");
    assert(!isStockPhraseHallucination({ text: "Thank you.", no_speech_prob: 0.9 }, 1), "not alone: kept");
  }

  // --- SporeLabs PR #256: server-suppressed stock phrases are ingested as restorable stretches
  {
    // Shapes as SporeLabs #256 returns them (default suppression and keep_suppressed).
    const w = (word: string, start: number, end: number, probability = 0.29) => ({ word, start, end, probability });
    const speech = (id: number, seek: number, start: number, end: number, text: string) => ({
      id, seek, start, end, text, temperature: 0, avg_logprob: -0.25, compression_ratio: 1.3,
      no_speech_prob: 0.05, hallucination_flag: null,
      words: text.split(" ").map((t, i, a) => w(t, start + ((end - start) * i) / a.length, start + ((end - start) * (i + 1)) / a.length, 0.95)),
    });
    const reason =
      "stock phrase over music/silence: no_speech_prob 0.94 > 0.6, the text is a known Whisper " +
      "hallucination, and nothing else was decoded from its 30 s window";
    const suppressedFlag = {
      start: 141.22, end: 144.02, segment_ids: [], kind: "stock_phrase", text: "I'm sorry.",
      no_speech_prob: 0.9356, avg_logprob: -0.8975, mean_word_probability: 0.2874, window_alone: true,
      reason, suppressed: true, words: [w("I'm", 141.22, 142.6), w("sorry.", 142.6, 144.02)],
      note: `"I'm sorry." — ${reason} (suppressed).`,
    };
    const loopNote = '3x repeated "Help!" — hallucination loop (compression_ratio 4.1, seek=30000).';
    const defaultResult: any = {
      model: "large-v3", engine: "openai-whisper==20250625", options: {}, language: "en", duration: 400,
      num_segments: 4, num_words: 0, text: "",
      hallucination_flags: [
        suppressedFlag,
        { start: 300, end: 303, segment_ids: [1, 2], kind: "repeated_segment", note: loopNote },
      ],
      segments: [
        speech(0, 9600, 96.0, 99.0, "Get away from the car."),
        { ...speech(1, 30000, 300, 301.5, "Help!"), hallucination_flag: loopNote },
        { ...speech(2, 30000, 301.5, 303, "Help!"), hallucination_flag: loopNote },
        speech(3, 30300, 310, 312, "Where did he go?"),
      ],
    };
    const { words, hallucinations } = wordsFromSporeLabsResult(defaultResult, 0.042);
    const text = words.map((x) => x.value).join(" ");
    assert(!text.includes("sorry"), "suppressed stock line stays out of words");
    assert(text.includes("car.") && text.includes("go?"), "speech is kept");
    assert(hallucinations.length === 2, "stock stretch listed next to the loop");
    const stock = hallucinations[0];
    assert(stock.start === 141.262 && stock.end === 144.062, "stock stretch on the video clock");
    assert(stock.note.startsWith("stock phrase") && stock.note.includes("SporeLabs"), "stock stretch note names SporeLabs");
    assert(stock.words.map((x) => x.value).join(" ") === "I'm sorry.", "stock stretch keeps its words for restore");
    assert(stock.words[0].start === 141.262, "restorable words on the video clock");
    assert(hallucinations[1].note === loopNote && hallucinations[1].words.length === 2, "loop still grouped by its note");

    // keep_suppressed: the segment stays, with its own stock_phrase verdict (no hallucination_flag).
    const keepResult: any = {
      ...defaultResult,
      hallucination_flags: [
        { ...suppressedFlag, suppressed: false, segment_ids: [1], note: suppressedFlag.note.replace("suppressed", "kept") },
      ],
      segments: [
        speech(0, 9600, 96.0, 99.0, "Get away from the car."),
        {
          ...speech(1, 12000, 141.22, 144.02, "I'm sorry."),
          no_speech_prob: 0.9356, words: suppressedFlag.words,
          stock_phrase: { reason, no_speech_prob: 0.9356, window_alone: true, mean_word_probability: 0.2874, note: "x" },
        },
        speech(2, 30300, 310, 312, "Where did he go?"),
      ],
    };
    const kept = wordsFromSporeLabsResult(keepResult, 0);
    assert(!kept.words.some((x) => x.value === "sorry."), "keep mode: stock_phrase segment held out of words");
    assert(kept.hallucinations.length === 1, "keep mode: listed once (segment verdict, flag entry not re-added)");
    assert(kept.hallucinations[0].words.length === 2 && kept.hallucinations[0].note.includes("SporeLabs"), "keep mode: restorable");

    // A stretch both SporeLabs and ZeeVee's #125 filter would flag is listed once.
    const both: any = {
      ...defaultResult,
      hallucination_flags: [suppressedFlag],
      segments: [
        speech(0, 9600, 96.0, 99.0, "Get away from the car."),
        { ...speech(1, 12000, 141.22, 144.02, "I'm sorry."), no_speech_prob: 0.9356, words: suppressedFlag.words },
      ],
    };
    const once = wordsFromSporeLabsResult(both, 0);
    assert(once.hallucinations.length === 1, "server + client flag: one stretch");
    assert(once.hallucinations[0].words.length === 2, "server + client flag: words not doubled");
    assert(once.hallucinations[0].note.includes("SporeLabs"), "server note wins");
    assert(!once.words.some((x) => x.value === "sorry."), "server + client flag: out of words");

    // Older responses: no stock_phrase flags, no stock_phrase field -> unchanged behaviour.
    const old: any = { ...defaultResult, hallucination_flags: [], segments: defaultResult.segments };
    const before = wordsFromSporeLabsResult(old, 0.042);
    assert(before.hallucinations.length === 1 && before.hallucinations[0].note === loopNote, "no flags: only the loop");
    assert(before.words.length === words.length, "no flags: same words");
    // A kept (suppressed: false) flag without a stock_phrase field is not ingested on its own.
    const stray: any = { ...defaultResult, hallucination_flags: [{ ...suppressedFlag, suppressed: false }] };
    assert(wordsFromSporeLabsResult(stray, 0).hallucinations.length === 1, "unsuppressed flag alone: not ingested");

    // Two suppressed lines with the same start (e.g. a zero-length line): both are listed.
    const sameStart: any = {
      ...defaultResult,
      hallucination_flags: [
        { ...suppressedFlag, start: 20, end: 20, text: "Thank you.", words: [w("Thank", 20, 20), w("you.", 20, 20)] },
        { ...suppressedFlag, start: 20, end: 21, text: "Bye.", words: [w("Bye.", 20, 21)] },
      ],
    };
    const both2 = wordsFromSporeLabsResult(sameStart, 0).hallucinations.filter((h) => h.note.startsWith("stock phrase"));
    assert(both2.length === 2, "same-start suppressed flags: neither overwrites the other");
    assert(
      both2.map((h) => h.words.map((x) => x.value).join(" ")).sort().join("|") === "Bye.|Thank you.",
      "same-start suppressed flags: both keep their words",
    );
    // A flag without a numeric start is skipped, not placed at 0 s.
    const nullStart: any = { ...defaultResult, hallucination_flags: [{ ...suppressedFlag, start: null }] };
    assert(
      !wordsFromSporeLabsResult(nullStart, 0).hallucinations.some((h) => h.start === 0),
      "flag with null start is not ingested at 0 s",
    );
  }

  console.log(`sporelabs-transcribe: ${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
