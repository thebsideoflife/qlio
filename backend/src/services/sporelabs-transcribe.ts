/**
 * SporeLabs transcription client (`POST/GET {base}/audio/transcribe`).
 *
 * Full Whisper large-v3 over the whole file on a SporeLabs GPU, with targeted
 * passes by that same model over audible gaps to recover missed words. Uses the
 * options of the reference mlx_whisper run (Scott's local pipeline):
 *   --word-timestamps True --language en --condition-on-previous-text False
 *   --hallucination-silence-threshold 2 --compression-ratio-threshold 2.0
 * plus the standard temperature fallback ladder. (The mlx CLI passes a single
 * temperature 0, so it never retries a failed window. On the Nashville pilot the
 * ladder matched Scott's words more closely than temperature 0 alone, and had no
 * "I'm sorry." x13 loop.) SporeLabs fills these in by default; we send them anyway
 * so the request records exactly what we asked for.
 *
 * Never log the presigned `audio_url` or the API key.
 */

import {
  requestJson,
  SporeLabsError,
  type ReframeClientOptions,
} from "./sporelabs-reframe";

export const TRANSCRIBE_MODEL = "large-v3" as const;
/** What we record in original.json's `model` field. */
export const TRANSCRIBE_MODEL_ID = "openai/whisper-large-v3" as const;

export const REFERENCE_WHISPER_OPTIONS = {
  language: "en",
  word_timestamps: true,
  condition_on_previous_text: false,
  hallucination_silence_threshold: 2,
  compression_ratio_threshold: 2.0,
  temperature: [0, 0.2, 0.4, 0.6, 0.8, 1.0],
  best_of: 5,
} as const;

export type TranscribeStatus = "queued" | "in_progress" | "completed" | "failed";

export interface TranscribeWord {
  word: string;
  start: number;
  end: number;
  probability: number;
}

export interface TranscribeSegment {
  id: number;
  seek: number;
  start: number;
  end: number;
  text: string;
  temperature: number;
  avg_logprob: number;
  compression_ratio: number;
  no_speech_prob: number;
  hallucination_flag: string | null;
  words: TranscribeWord[];
}

export interface HallucinationFlag {
  start: number;
  end: number;
  segment_ids: number[];
  kind: string;
  note: string;
}

export interface TranscribeResult {
  model: string;
  engine: string;
  options: Record<string, unknown>;
  language: string;
  duration: number;
  num_segments: number;
  num_words: number;
  hallucination_flags: HallucinationFlag[];
  text: string;
  segments: TranscribeSegment[];
}

export interface TranscribeJob {
  id: string;
  object: "audio.transcription";
  model?: string;
  status: TranscribeStatus;
  created_at?: number;
  progress?: { stage?: string };
  error?: { message?: string; code?: string };
  result?: TranscribeResult;
  usage?: Record<string, number>;
}

/**
 * `language`: the asset's known language, or null to let Whisper detect it. The
 * reference run forces "en"; we do the same whenever the asset is known to be English.
 */
export async function submitTranscription(
  request: { audio_url: string; duration_seconds?: number; language?: string | null },
  opts: ReframeClientOptions = {},
): Promise<TranscribeJob> {
  const res = await requestJson<TranscribeJob>(
    "POST",
    "/audio/transcribe",
    {
      model: TRANSCRIBE_MODEL,
      audio_url: request.audio_url,
      ...(request.duration_seconds && request.duration_seconds > 0
        ? { duration_seconds: request.duration_seconds }
        : {}),
      options: {
        ...REFERENCE_WHISPER_OPTIONS,
        ...(request.language !== undefined ? { language: request.language } : {}),
      },
    },
    opts,
  );
  if (typeof res.id !== "string" || !res.id) {
    throw new SporeLabsError(502, "SporeLabs transcribe submit returned no job id");
  }
  return res;
}

export async function getTranscription(
  id: string,
  opts: ReframeClientOptions = {},
): Promise<TranscribeJob> {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new SporeLabsError(400, `Invalid SporeLabs transcription id: ${id}`);
  }
  return requestJson<TranscribeJob>(
    "GET",
    `/audio/transcribe/${encodeURIComponent(id)}`,
    undefined,
    opts,
  );
}
