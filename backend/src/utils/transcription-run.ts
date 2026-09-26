export type TranscriptionRunState = {
  pendingTranscriptionVersion?: unknown;
  transcriptionStatus?: unknown;
  transcriptionVersion?: unknown;
  transcriptionUrl?: unknown;
};

export type TranscriptionRunDisposition =
  | "current"
  | "committed"
  | "superseded";

/**
 * Duplicate async Lambda deliveries can observe the same run after another
 * invocation has committed it. That is success, not supersession.
 */
export function classifyTranscriptionRun(
  state: TranscriptionRunState,
  transcriptionVersion: string,
): TranscriptionRunDisposition {
  if (
    state.pendingTranscriptionVersion === transcriptionVersion &&
    state.transcriptionStatus === "pending"
  ) {
    return "current";
  }
  if (
    state.transcriptionVersion === transcriptionVersion &&
    state.transcriptionStatus === "ready"
  ) {
    return "committed";
  }
  return "superseded";
}

/** Audio facts a continuation needs to finish a run without the source or the WAV. */
export type SporeLabsRunAudio = {
  startInVideo: number;
  sampleRate: number;
  samples: number;
  duration: number;
};

/**
 * Written before the first SporeLabs POST of a run (see sporelabsSubmitIntentKey).
 * `request` is the exact JSON body; resubmitting it with `idempotencyKey` is
 * what lets SporeLabs recognise the retry and return the original job.
 */
export type SporeLabsSubmitIntent = {
  idempotencyKey: string;
  createdAt: string;
  audioKey: string;
  audio: SporeLabsRunAudio;
  level: { peakAmplitude: number; rmsAmplitude: number };
  request: {
    model: string;
    audio_url: string;
    duration_seconds?: number;
    options: Record<string, unknown>;
  };
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Validates a stored submit intent; null when the object is not one. */
export function parseSporeLabsSubmitIntent(raw: unknown): SporeLabsSubmitIntent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  const req = r.request;
  const audio = r.audio;
  const level = r.level;
  if (
    typeof r.idempotencyKey !== "string" ||
    !r.idempotencyKey ||
    typeof r.createdAt !== "string" ||
    typeof r.audioKey !== "string" ||
    !r.audioKey ||
    !req ||
    typeof req !== "object" ||
    typeof req.model !== "string" ||
    typeof req.audio_url !== "string" ||
    !req.audio_url ||
    !req.options ||
    typeof req.options !== "object" ||
    !audio ||
    !isFiniteNumber(audio.startInVideo) ||
    !isFiniteNumber(audio.sampleRate) ||
    !isFiniteNumber(audio.samples) ||
    !isFiniteNumber(audio.duration) ||
    !level ||
    !isFiniteNumber(level.peakAmplitude) ||
    !isFiniteNumber(level.rmsAmplitude)
  ) {
    return null;
  }
  return r as SporeLabsSubmitIntent;
}
