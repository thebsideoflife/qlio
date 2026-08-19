import {
  LEGACY_TRANSCRIPTION_VERSION,
  bucketFromS3Uri,
  isLegacyTranscriptKey,
  languageNamedTranscriptKey,
  normalizeLanguageCode,
  originalTranscriptKey,
  pickTranslationUri,
  translationTranscriptKey,
  translationUriMatchesVersion,
} from "./transcript-format";

export const ORIGINAL_CAPTION_LANGUAGE = "original";

export type TranscriptSourceParams = {
  assetId?: string | null;
  activeLanguage?: string | null;
  originalLanguage?: string | null;
  transcriptionVersion?: string | null;
  translations?: Record<string, string> | null;
  transcriptionUrl?: string | null;
};

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

function asS3Uri(uri: string | null | undefined): string | null {
  return uri && uri.startsWith("s3://") ? uri : null;
}

function versionedOriginalUri(params: TranscriptSourceParams): string | null {
  const version = params.transcriptionVersion;
  const assetId = params.assetId || undefined;
  if (!assetId || !version || version === LEGACY_TRANSCRIPTION_VERSION) {
    return null;
  }
  const bucket = bucketFromS3Uri(params.transcriptionUrl);
  if (!bucket) return null;
  return `s3://${bucket}/${originalTranscriptKey(assetId, version)}`;
}

function languageNamedOriginalUri(
  params: TranscriptSourceParams,
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

/**
 * Canonical original-language source policy used by every consumer.
 * Versioned Whisper wins, then a stored/language-named Whisper object, with
 * the flat TwelveLabs object retained only as a last-resort legacy fallback.
 */
export function resolveOriginalTranscriptCandidates(
  params: TranscriptSourceParams,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (uri: string | null | undefined) => {
    if (!uri || !uri.startsWith("s3://") || seen.has(uri)) return;
    seen.add(uri);
    out.push(uri);
  };

  add(versionedOriginalUri(params));

  const stored = asS3Uri(params.transcriptionUrl);
  const storedIsTwelveLabs = !!(
    params.assetId && isLegacyTranscriptKey(params.assetId, stored)
  );
  if (stored && !storedIsTwelveLabs) add(stored);

  add(languageNamedOriginalUri(params));

  if (storedIsTwelveLabs) add(stored);

  return out;
}

function selectedTranslationUri(params: TranscriptSourceParams): string | null {
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
    return canonical;
  }
  return asS3Uri(mapped);
}

/**
 * Render selection adds only the explicitly selected translation ahead of the
 * canonical original fallbacks. Translation phrases never enter the original
 * candidate list.
 */
export function resolveRenderTranscriptCandidates(
  params: TranscriptSourceParams,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (uri: string | null | undefined) => {
    if (!uri || !uri.startsWith("s3://") || seen.has(uri)) return;
    seen.add(uri);
    out.push(uri);
  };

  add(selectedTranslationUri(params));
  for (const uri of resolveOriginalTranscriptCandidates(params)) add(uri);

  return out;
}

export function resolveRenderTranscriptUri(
  params: TranscriptSourceParams,
): string | null {
  return resolveRenderTranscriptCandidates(params)[0] ?? null;
}
