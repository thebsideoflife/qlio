import type { CaptionWord } from "./transcript-format";
import {
  LEGACY_TRANSCRIPTION_VERSION,
  bucketFromS3Uri,
  isLegacyTranscriptKey,
  normalizeLanguageCode,
  languageNamedTranscriptKey,
  originalTranscriptKey,
  pickTranslationUri,
  translationTranscriptKey,
  translationUriMatchesVersion,
} from "./transcript-format";

/** Whisper input is always decoded to this rate. Chunk math is in samples. */
export const WHISPER_SAMPLE_RATE = 16_000;
/** ~45s of audio keeps STT under OpenRouter's 60s upstream timeout. */
export const WHISPER_CHUNK_SECONDS = 45;
/** Overlap in seconds; 0.5s at 16 kHz is an integer sample count. */
export const WHISPER_OVERLAP_SECONDS = 0.5;

export const WHISPER_CHUNK_SAMPLES = WHISPER_CHUNK_SECONDS * WHISPER_SAMPLE_RATE;
export const WHISPER_OVERLAP_SAMPLES =
  WHISPER_OVERLAP_SECONDS * WHISPER_SAMPLE_RATE;

export type AudioChunkPlan = {
  index: number;
  /** Inclusive sample index on the decoded PCM timeline. */
  startSample: number;
  /** Exclusive sample index on the decoded PCM timeline. */
  endSample: number;
  /** startSample / sampleRate (decoded-audio clock, not the container). */
  startSec: number;
  durationSec: number;
  /** Inbound overlap with the previous chunk (0 on the first). */
  overlapSamples: number;
  /** Outbound overlap with the next chunk (0 on the last). */
  outboundOverlapSamples: number;
};

/** Raw Whisper response for one slice, timestamps local to the chunk. */
export type StoredWhisperChunk = {
  index: number;
  model: string;
  audio: {
    startInVideo: number;
    sampleRate: number;
    totalSamples: number;
  };
  plan: {
    startSample: number;
    endSample: number;
    overlapSamples: number;
    outboundOverlapSamples: number;
  };
  language?: string;
  text: string;
  words: CaptionWord[];
};

export function storedChunkMatchesPlan(
  stored: StoredWhisperChunk,
  plan: AudioChunkPlan,
  audio: { startInVideo: number; sampleRate: number; totalSamples: number },
  model: string,
): boolean {
  return (
    stored.index === plan.index &&
    stored.model === model &&
    stored.plan.startSample === plan.startSample &&
    stored.plan.endSample === plan.endSample &&
    stored.audio.totalSamples === audio.totalSamples &&
    stored.audio.sampleRate === audio.sampleRate &&
    Math.abs(stored.audio.startInVideo - audio.startInVideo) < 1e-6
  );
}

export type FfmpegStreamProbe = {
  formatDurationSec: number;
  formatStartSec: number;
  /** Presentation timestamp of the first audio sample on the container/video clock. */
  audioStartSec: number;
  audioSampleRate?: number;
};

type FfprobeOutput = {
  streams?: Array<{
    start_time?: string | number;
    sample_rate?: string | number;
  }>;
  format?: {
    start_time?: string | number;
    duration?: string | number;
  };
};

function finiteNumber(value: unknown, fallback = 0): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** Parse JSON emitted by ffprobe for the first audio stream. */
export function parseFfprobeStreamProbe(stdout: string): FfmpegStreamProbe {
  const parsed = JSON.parse(stdout) as FfprobeOutput;
  const stream = parsed.streams?.[0];
  const formatStartSec = finiteNumber(parsed.format?.start_time);
  return {
    formatDurationSec: finiteNumber(parsed.format?.duration),
    formatStartSec,
    audioStartSec: finiteNumber(stream?.start_time, formatStartSec),
    audioSampleRate: stream?.sample_rate
      ? finiteNumber(stream.sample_rate) || undefined
      : undefined,
  };
}

function parseHms(h: string, m: string, s: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/**
 * Parse `ffmpeg -i` stderr (no ffprobe required). Uses the first audio stream's
 * `start` when present; otherwise the container start.
 */
export function parseFfmpegStreamProbe(stderr: string): FfmpegStreamProbe {
  const durationMatch = stderr.match(
    /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/,
  );
  const formatDurationSec = durationMatch
    ? parseHms(durationMatch[1], durationMatch[2], durationMatch[3])
    : 0;

  const formatStartMatch = stderr.match(/Duration:.*?\bstart:\s*([\d.]+)/);
  const formatStartSec = formatStartMatch ? Number(formatStartMatch[1]) : 0;

  let audioStartSec = Number.NaN;
  let audioSampleRate: number | undefined;
  for (const line of stderr.split(/\r?\n/)) {
    if (!/\bAudio:/.test(line)) continue;
    const startM = line.match(/\bstart[:\s]+([\d.]+)/);
    if (startM) audioStartSec = Number(startM[1]);
    const rateM = line.match(/(\d+)\s*Hz/);
    if (rateM) audioSampleRate = Number(rateM[1]);
    break;
  }

  return {
    formatDurationSec,
    formatStartSec,
    audioStartSec: Number.isFinite(audioStartSec)
      ? audioStartSec
      : formatStartSec,
    audioSampleRate,
  };
}

/**
 * Plan PCM chunks from the *actual* decoded sample count. Never uses a
 * nominal duration or keyframe-aligned cut time.
 */
export function planAudioChunks(params: {
  totalSamples: number;
  sampleRate: number;
  chunkSamples?: number;
  overlapSamples?: number;
}): AudioChunkPlan[] {
  const {
    totalSamples,
    sampleRate,
    chunkSamples = WHISPER_CHUNK_SAMPLES,
    overlapSamples = WHISPER_OVERLAP_SAMPLES,
  } = params;
  if (!(totalSamples > 0) || !(sampleRate > 0)) return [];
  if (!(chunkSamples > overlapSamples) || overlapSamples < 0) {
    throw new Error("Invalid chunk/overlap sample counts");
  }

  const step = chunkSamples - overlapSamples;
  const plans: AudioChunkPlan[] = [];
  let startSample = 0;
  let index = 0;
  while (startSample < totalSamples) {
    const endSample = Math.min(startSample + chunkSamples, totalSamples);
    if (endSample - startSample < 1) break;
    plans.push({
      index,
      startSample,
      endSample,
      startSec: startSample / sampleRate,
      durationSec: (endSample - startSample) / sampleRate,
      overlapSamples: index === 0 ? 0 : overlapSamples,
      outboundOverlapSamples: 0,
    });
    if (endSample >= totalSamples) break;
    startSample += step;
    index += 1;
  }
  for (let i = 0; i < plans.length - 1; i++) {
    plans[i].outboundOverlapSamples = overlapSamples;
  }
  return plans;
}

export function videoOriginForChunk(params: {
  audioStartInVideoSec: number;
  chunkStartSample: number;
  sampleRate: number;
}): number {
  return (
    params.audioStartInVideoSec + params.chunkStartSample / params.sampleRate
  );
}

/**
 * Map Whisper's chunk-local timestamps onto the video/container clock using
 * the exact PCM sample origin of this chunk. Each side of an overlap keeps
 * only its half so neighboring chunks do not double-emit the same word.
 */
export function mapChunkWordsToVideoClock(params: {
  words: CaptionWord[];
  audioStartInVideoSec: number;
  chunkStartSample: number;
  chunkEndSample: number;
  sampleRate: number;
  overlapSamples: number;
  outboundOverlapSamples?: number;
}): CaptionWord[] {
  const {
    words,
    audioStartInVideoSec,
    chunkStartSample,
    chunkEndSample,
    sampleRate,
    overlapSamples,
    outboundOverlapSamples = 0,
  } = params;
  const origin = videoOriginForChunk({
    audioStartInVideoSec,
    chunkStartSample,
    sampleRate,
  });
  const chunkDur = (chunkEndSample - chunkStartSample) / sampleRate;
  const keepAfterLocal =
    overlapSamples > 0 ? overlapSamples / 2 / sampleRate : 0;
  const dropAfterLocal =
    outboundOverlapSamples > 0
      ? chunkDur - outboundOverlapSamples / 2 / sampleRate
      : chunkDur;
  const videoChunkEnd =
    audioStartInVideoSec + chunkEndSample / sampleRate;

  const out: CaptionWord[] = [];
  for (const word of words) {
    if (word.start < keepAfterLocal) continue;
    if (word.start >= dropAfterLocal) continue;
    const start = origin + word.start;
    const end = origin + word.end;
    if (!(start < videoChunkEnd)) continue;
    out.push({
      start,
      end: Math.min(Math.max(end, start), videoChunkEnd),
      value: word.value,
    });
  }
  return out;
}

export function mergeChunkWords(words: CaptionWord[]): CaptionWord[] {
  return [...words].sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Re-map a stored raw chunk with the current overlap rules (no Whisper call). */
export function mapStoredChunkToVideoClock(
  stored: StoredWhisperChunk,
  plan: AudioChunkPlan,
): CaptionWord[] {
  return mapChunkWordsToVideoClock({
    words: stored.words,
    audioStartInVideoSec: stored.audio.startInVideo,
    chunkStartSample: plan.startSample,
    chunkEndSample: plan.endSample,
    sampleRate: stored.audio.sampleRate,
    overlapSamples: plan.overlapSamples,
    outboundOverlapSamples: plan.outboundOverlapSamples,
  });
}

/**
 * Self-invoke cap. Each hop re-downloads and re-extracts audio, then skips
 * chunks already on S3. 40 hops is far above a normal film; the hard stop is
 * so a no-progress chain cannot run overnight.
 */
export const MAX_TRANSCRIBE_HOPS = 40;

export type TranscribeContinuation =
  | "run"
  | "continue"
  | "abort-no-progress"
  | "abort-max-hops";

export function parseTranscribeHop(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Decide whether to transcribe the next missing chunk, Event-invoke a
 * continuation, or fail closed. Continuations are allowed only after this
 * invocation persisted at least one new chunk — otherwise download/extract
 * would loop forever on a long source.
 */
export function transcribeContinuationDecision(params: {
  remainingMs: number;
  budgetMs: number;
  wroteChunks: number;
  hop: number;
  maxHops?: number;
}): TranscribeContinuation {
  const maxHops = params.maxHops ?? MAX_TRANSCRIBE_HOPS;
  if (params.hop >= maxHops) return "abort-max-hops";
  if (params.remainingMs >= params.budgetMs) return "run";
  if (params.wroteChunks < 1) return "abort-no-progress";
  if (params.hop + 1 >= maxHops) return "abort-max-hops";
  return "continue";
}

export const ORIGINAL_CAPTION_LANGUAGE = "original";

export function isOriginalCaptionLanguage(
  activeLanguage: string | undefined | null,
  originalLanguage: string | undefined | null,
): boolean {
  if (!activeLanguage) return true;
  if (activeLanguage === ORIGINAL_CAPTION_LANGUAGE) return true;
  if (!originalLanguage) return false;
  const active = normalizeLanguageCode(activeLanguage);
  const original = normalizeLanguageCode(originalLanguage);
  if (active === "und" || original === "und") return false;
  return active === original;
}

function whisperOriginalUri(params: {
  assetId?: string;
  transcriptionVersion?: string | null;
  transcriptionUrl?: string | null;
}): string | null {
  const version = params.transcriptionVersion;
  const assetId = params.assetId;
  if (
    !assetId ||
    !version ||
    version === LEGACY_TRANSCRIPTION_VERSION
  ) {
    return null;
  }
  const bucket = bucketFromS3Uri(params.transcriptionUrl);
  if (!bucket) return null;
  return `s3://${bucket}/${originalTranscriptKey(assetId, version)}`;
}

function asS3Uri(uri: string | null | undefined): string | null {
  return uri && uri.startsWith("s3://") ? uri : null;
}

function languageNamedWhisperUri(
  params: ResolveRenderTranscriptParams,
): string | null {
  const assetId = params.assetId || undefined;
  const language = params.originalLanguage
    ? normalizeLanguageCode(params.originalLanguage)
    : "";
  if (!assetId || !language || language === "und") return null;
  const bucket = bucketFromS3Uri(params.transcriptionUrl);
  if (!bucket) return null;
  return `s3://${bucket}/${languageNamedTranscriptKey(assetId, language)}`;
}

export type ResolveRenderTranscriptParams = {
  assetId?: string | null;
  activeLanguage?: string | null;
  originalLanguage?: string | null;
  transcriptionVersion?: string | null;
  translations?: Record<string, string> | null;
  transcriptionUrl?: string | null;
};

function currentTranslationUri(
  params: ResolveRenderTranscriptParams,
): string | null {
  const activeRaw = params.activeLanguage?.trim() || "";
  const activeNorm = activeRaw ? normalizeLanguageCode(activeRaw) : "";
  const originalNorm = params.originalLanguage
    ? normalizeLanguageCode(params.originalLanguage)
    : undefined;
  const wantTranslation =
    !!activeRaw &&
    activeRaw !== ORIGINAL_CAPTION_LANGUAGE &&
    activeNorm !== "und" &&
    !isOriginalCaptionLanguage(activeNorm, originalNorm);
  if (!wantTranslation || !activeNorm) return null;

  const version =
    typeof params.transcriptionVersion === "string" &&
    params.transcriptionVersion &&
    params.transcriptionVersion !== LEGACY_TRANSCRIPTION_VERSION
      ? params.transcriptionVersion
      : null;
  const assetId = params.assetId || undefined;
  const mapped = pickTranslationUri(params.translations, activeNorm);
  const bucket =
    bucketFromS3Uri(mapped) || bucketFromS3Uri(params.transcriptionUrl);
  if (mapped && assetId && version && bucket) {
    const canonical = `s3://${bucket}/${translationTranscriptKey(assetId, version, activeNorm)}`;
    if (translationUriMatchesVersion(mapped, assetId, version, activeNorm)) {
      return asS3Uri(mapped) || canonical;
    }
    // Stale map entry from a previous Whisper run — this version's file only.
    return canonical;
  }
  return asS3Uri(mapped);
}

/**
 * Ordered S3 URIs to try when burning captions.
 *
 * 1. Translation for the toggled language, if it belongs to this Whisper run
 * 2. Versioned Whisper original (`versions/{run}/original.json`)
 * 3. Stored transcriptionUrl when it is already a Whisper path
 * 4. Older language-named Whisper file (`/{en}.json`)
 * 5. TwelveLabs flat `transcriptions/{id}.json` only if those are missing
 */
export function resolveRenderTranscriptCandidates(
  params: ResolveRenderTranscriptParams,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (uri: string | null | undefined) => {
    if (!uri || !uri.startsWith("s3://") || seen.has(uri)) return;
    seen.add(uri);
    out.push(uri);
  };

  add(currentTranslationUri(params));

  add(
    whisperOriginalUri({
      assetId: params.assetId || undefined,
      transcriptionVersion: params.transcriptionVersion,
      transcriptionUrl: params.transcriptionUrl,
    }),
  );

  const stored = asS3Uri(params.transcriptionUrl);
  const storedIsTwelveLabs = !!(
    params.assetId && isLegacyTranscriptKey(params.assetId, stored)
  );
  if (stored && !storedIsTwelveLabs) add(stored);

  add(languageNamedWhisperUri(params));

  if (storedIsTwelveLabs) add(stored);

  return out;
}

/**
 * Preferred URI for the job record. Same order as
 * `resolveRenderTranscriptCandidates` — first entry wins.
 */
export function resolveRenderTranscriptUri(
  params: ResolveRenderTranscriptParams,
): string | null {
  return resolveRenderTranscriptCandidates(params)[0] ?? null;
}
