# Whisper transcripts and on-demand caption translation

## Context

TwelveLabs word transcripts are unreliable (duplicate tracks, stretched clocks, weak Spanish). Captions need the spoken language stored as the original, with translation only when a producer asks for it.

Diarization is out of scope for this change.

## Intent

1. Replace TwelveLabs transcription with OpenRouter Whisper (`openai/whisper-large-v3`). Autodetect language. Store the original under its ISO-639-1 code (`en`, `es`, …).
2. Translate captions only on user request. Store the translation as caption *lines* (start/end/text), not word timings. Switch display language in the Captions tab.
3. Stop writing the legacy S3 key `transcriptions/{assetId}.json`. Readers already follow `asset.transcriptionUrl`; existing objects stay valid until the asset is re-transcribed or deleted.

## Non-goals

- Speaker diarization / WhisperX
- Dual-write of the old flat JSON key
- Migrating existing TwelveLabs files in place
- Word-level translation alignment or karaoke on translated lines
- Self-hosted GPU / fal.ai / DeepL

## Data

Raw Whisper slice (chunk-local times), S3 `transcriptions/{assetId}/chunks/{i}.json`:

```json
{
  "index": 0,
  "model": "openai/whisper-large-v3",
  "audio": { "startInVideo": 0, "sampleRate": 16000, "totalSamples": 720000 },
  "plan": { "startSample": 0, "endSample": 720000, "overlapSamples": 0, "outboundOverlapSamples": 8000 },
  "language": "es",
  "text": "Hola",
  "words": [{ "start": 0.2, "end": 0.5, "value": "Hola" }]
}
```

Original (merged, video clock), S3 `transcriptions/{assetId}/{lang}.json`:

```json
{
  "language": "es",
  "model": "openai/whisper-large-v3",
  "words": [{ "start": 12.4, "end": 12.7, "value": "Hola" }]
}
```

Translation (line-level), same prefix, different lang:

```json
{
  "language": "en",
  "sourceLanguage": "es",
  "model": "openai/gpt-4o-mini",
  "lines": [{ "start": 12.4, "end": 15.1, "text": "Hello, how are you?" }]
}
```

Asset (DynamoDB):

- `transcriptionUrl` — S3 URI of the **original** word file (new layout or legacy array)
- `originalLanguage` — `en` / `es` / …
- `transcriptionStatus` — `pending` | `ready` | `failed`
- `translations` — `{ "en": "s3://…" }` map of line-level files

Project `captionSettings.activeLanguage` — which language the overlay and export burn. Defaults to original.

Readers accept both a bare word array (legacy) and `{ words: [...] }`.

## Pipeline

Upload → `startIndexing` (TwelveLabs **index only**, unchanged) **and** async `transcribeAsset`.

TwelveLabs is never a transcript source — not on the webhook, not as a StoryIQ/IQ fallback.

1. Download source from S3, extract 16 kHz mono PCM with the FFmpeg layer.
2. Split into ~45 s chunks. Sequential, not parallel: OpenRouter's upstream STT providers time out around 60 s per request. A single long WAV would fail that timeout even if we only made one call. Chunking is a provider limit, not a concurrency strategy.
3. `POST https://openrouter.ai/api/v1/audio/transcriptions` with no `language` hint, `verbose_json` + word timestamps.
4. Persist each raw Whisper response at `transcriptions/{assetId}/chunks/{i}.json` (chunk-local timestamps + the PCM plan/fingerprint). Resume skips matching chunks. If the Lambda is low on time, it Event-invokes itself and keeps `pending`.
5. Offset-merge with half-overlap on each side. Write `{lang}.json`. Set `transcriptionUrl`, `originalLanguage`, `transcriptionStatus=ready`. Clear `translations` — they belong to the previous original.

`POST /projects/{projectId}/captions/translate` `{ targetLanguage }`:

1. Load original words, group with existing caption break rules (8 words / 3 s / 0.3 s pause).
2. Translate line batches via OpenRouter chat. Keep source start/end.
3. Store `{target}.json`, add to `asset.translations`, return lines.

Captions tab: show detected language; Translate to English/Spanish; switch Original vs translated. Translated overlay has no per-word highlight. Script tab stays on original words.

Export (`renderVideo` / `cutSegments`) uses `captionSettings.activeLanguage`: original → group words; translation → use stored lines.

## Legacy path

Safe to drop dual-write. Every runtime reader uses `asset.transcriptionUrl`, not a hardcoded key. Old assets keep working. `deleteAsset` also removes the `transcriptions/{assetId}/` prefix.

## Secrets

`zeevee/openrouter-api-key` in Secrets Manager (put the value once; Terraform does not store it).
