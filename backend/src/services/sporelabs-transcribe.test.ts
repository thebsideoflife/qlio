/**
 * SporeLabs transcription: client request shape, result -> original.json words,
 * and the cleanup rule that keeps raw SporeLabs responses.
 *
 * Run: npx tsx src/services/sporelabs-transcribe.test.ts
 */
import {
  REFERENCE_WHISPER_OPTIONS,
  getTranscription,
  submitTranscription,
  type TranscribeResult,
} from "./sporelabs-transcribe";
import { SporeLabsError, type ReframeClientOptions } from "./sporelabs-reframe";
import { wordsFromSporeLabsResult } from "../utils/sporelabs-transcript";
import {
  selectSupersededTranscriptKeys,
  sporelabsJobStateKey,
  sporelabsRawResponseKey,
  originalTranscriptKey,
} from "../utils/transcript-format";

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
        `transcriptions/${assetId}.json`,
      ],
      keepKeys: keep,
    });
    assert(!stale.includes(oldRaw), "an older run's raw response is never deleted");
    assert(stale.includes(originalTranscriptKey(assetId, "v1")), "an older original is deleted");
    assert(stale.includes(sporelabsJobStateKey(assetId, "v2")), "job state is deleted");
    assert(!stale.some((k) => keep.includes(k)), "keep keys survive");
  }

  console.log(`sporelabs-transcribe: ${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
