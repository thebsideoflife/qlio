# AGENTS.md

Guidance for AI coding agents (Codex and others) working in this repository. Kept identical to CLAUDE.md. `README.md` has the human overview.

## Repository

Monorepo for **Qlio** (formerly ZeeVee), which turns long-form video into short vertical clips with captions.

- `zeevee/`: React/Vite frontend (package `qlio`) plus the Remotion compositions
- `backend/`: AWS Lambda handlers in TypeScript, one per file in `src/handlers/`, bundled by esbuild
- `infrastructure/`: OpenTofu for all AWS resources

## Commands

```bash
# Frontend (zeevee/)
npm run dev | npm test | npm run lint | npm run build

# Backend (backend/)
npm test                  # tsx test scripts; no framework
npx tsc --noEmit -p .     # type check
npm run build             # esbuild → dist/

# Deploy (CI runs this on push to main)
./deploy.sh [--skip-docker | --stitch-only]
./zeevee/deploy-remotion-site.sh
```

AWS profile `zeevee`, region `us-west-2`. Logs: `aws logs tail /aws/lambda/<function> --follow`.
CI: `.github/workflows/test.yml` runs on every PR; `deploy.yml` tests then deploys the backend; `deploy-remotion-site.yml` republishes the Remotion bundle.

## Architecture

**Domain:** Asset (uploaded master in S3) → Project (segments, caption settings, framing) → Render job (export).

**Ingest:** S3 `raw/` upload → `startIndexing` starts `transcribeAsset` (Whisper large-v3 on SporeLabs) and TwelveLabs indexing in parallel. Sources over 60 min are split by `splitVideo` (55-min chunks, 30 s overlap); `services/twelvelabs.ts` maps chunk times back to the master.

**Segment selection:** the IQ Agent (`backend/src/services/iq-agent/`, handlers `iqAgentApi` + `iqAgentWorker`, spec `SPEC-iq-agent.md`) is the only path the UI uses. Claude Sonnet 4.5 via SporeLabs calls tools (search, transcript, watch_clip, view_frames, edit_segments, …). The worker is stateless: state is in DynamoDB `agent-threads` / `agent-events`, and it self-invokes before the 15-min Lambda limit. `generateSegments` + `services/storyiq/` (Pegasus, sports, Jockey v1/v3) are legacy, kept for evals and rollback, and not called by the UI.

**Editor:** Redux (`editorSlice`), autosave via `syncMiddleware` every 10 s through one ordered save chain. The preview is a native `<video>` plus a caption overlay that shares modules with `src/remotion/` (caption timing and grouping, framing interpolation, segment frame bounds, fps snap). Preview must equal export.

**Framing:** `analyzeFraming` builds a 360p frame-exact proxy and submits all segments to the SporeLabs reframe service (one zoom/focus hold per camera shot, 9:16 only). `FRAMING_ENGINE=gemini` restores the legacy path.

**Export:** `renderVideo` (one export slot per project) → `cutSegments` (FFmpeg container Lambda, frame-exact re-encode, ≤1080 px short side) → Remotion Lambda per scene → `getRenderStatus` (retries, reaping) → `packageExport` (zip). Details in `backend/RENDERING.md`.

**Vendors:** TwelveLabs (index, Pegasus, Marengo, Jockey agents) and SporeLabs (Whisper, reframe, every LLM call). Nothing calls Anthropic directly. Secrets are in Secrets Manager under `zeevee/*` and are read at runtime.

## Rules that are easy to break

- **Render fingerprints are duplicated**: `zeevee/src/lib/segmentRenderFingerprint.ts` ↔ `backend/src/utils/segmentRenderFingerprint.ts`, and `zeevee/src/lib/segmentMetadataFingerprint.ts` ↔ `backend/src/services/export-metadata.ts`. Change both sides together. Bump `RENDER_PIPELINE_VERSION` when Remotion output changes.
- **Remotion changes need the site republished**, or exports keep the old captions; Vercel does not update it.
- **Grounded timestamps**: models pick from times returned by TwelveLabs or the transcript; code clamps and validates them. Durations are computed in code (`iq-agent/ledger.ts`), never by the model.
- **Long work must fit Lambda's 15 minutes**: follow the existing pattern of heartbeat + self-invoke continuation + stale-job reaping.
- `SCENE_RENDER_TIMEOUT_MS` (`backend/src/utils/renderReuse.ts`) must stay above the Remotion function timeout (`infrastructure/remotion.tf`).
- Prompts live in code (`iq-agent/prompts.ts`, `storyiq/jockey/*-prompts.ts`); keep them there as first-class artifacts.
