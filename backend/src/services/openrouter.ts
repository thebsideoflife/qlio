/**
 * @deprecated Import from `./sporelabs` instead.
 *
 * Kept so existing transcription tests and handlers keep compiling while
 * Whisper, translation, and every other model call go through SporeLabs.
 */
export {
  WHISPER_MODEL,
  TRANSLATE_MODEL,
  STT_TIMEOUT_MS,
  STT_RETRIES,
  transcribeAudioChunk,
  translateCaptionLines,
  getSporeLabsApiKey as getOpenRouterApiKey,
  type WhisperTranscription,
} from "./sporelabs";
