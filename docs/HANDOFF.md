# Qlio Handoff: How It Works and Tradeoffs

Written Nov 13, 2026 for the handoff to JT.

## Start here

Qlio turns a long video into short vertical clips with captions. A producer uploads a master, chats with the IQ Agent to pick the scenes, adjusts captions and framing in the editor, and exports a zip of MP4s plus metadata. Everything runs on AWS Lambda in `us-west-2`. The frontend is on Vercel.

| Folder | What it is | Deploys via |
| --- | --- | --- |
| `zeevee/` | React + Vite editor (package `qlio`), plus the Remotion caption compositions | Vercel (app); GitHub Actions publishes the Remotion site |
| `backend/` | About 30 TypeScript Lambda handlers in `src/handlers/`, bundled by esbuild | GitHub Actions on every push to `main` (runs `deploy.sh`) |
| `infrastructure/` | OpenTofu for API Gateway, Lambdas, DynamoDB, S3, CloudFront, ECR | Same workflow (`tofu apply`) |
| `docs/specs/`, root `SPEC-*.md` | Design specs written before each big feature | Not deployed |

What to read first, in order:

1. This doc.
2. `SPEC-iq-agent.md`: the current way segments are made. It replaced the earlier Jockey and StoryIQ designs.
3. `backend/src/services/iq-agent/loop.ts` and `zeevee/src/components/editor/ExportPanel.tsx`: the two hardest pieces of code.
4. `backend/RENDERING.md`: the export pipeline in more depth.

`ARCHITECTURE_REPORT.md` and the older SPEC files describe earlier designs. Each has a status line at the top. Where they disagree with this doc, the code and this doc are right.

## How the pieces fit

The browser talks to about 30 Lambdas through one API Gateway, except for uploads, which go straight to S3. The Lambdas fall into four stages: ingest, scene selection, editing and framing, and export. Every stage keeps its state in S3 and DynamoDB, so any Lambda can stop and pick up again in a fresh invocation.

TwelveLabs is the video brain (indexing, Pegasus clip analysis, Marengo search). SporeLabs handles everything else model-shaped. Remotion runs inside our AWS account as its own Lambda.

## Upload, indexing and transcripts

One S3 upload starts two independent jobs: Whisper transcription (for captions) and TwelveLabs indexing (for video understanding). They run in parallel so captions never wait on TwelveLabs.

1. **Upload.** `POST /upload` (`generateUploadCredentials.ts`) hands the browser one-hour STS credentials scoped to a single `raw/<uuid>.<ext>` key and writes the asset row as `UPLOADING`. The browser uploads directly to S3 with 64 MB multipart parts over Transfer Acceleration (`zeevee/src/services/s3Upload.ts`).
2. **Kick-off.** The S3 event on `raw/*.mp4|.mov|.m4v` calls `startIndexing.ts`. It async-invokes `transcribeAsset`, then creates a TwelveLabs task from a presigned URL.
3. **Long videos.** TwelveLabs caps a video at 60 min. Over that, `splitVideo.ts` (an FFmpeg container Lambda) cuts 55-min chunks with 30 s overlap using stream copy. Each chunk upload re-fires `startIndexing`. `services/twelvelabs.ts` maps chunk timestamps back to the master's timeline, so callers never see chunks.
4. **Indexing done.** TwelveLabs calls `POST /webhook` (`processWebhook.ts`, HMAC-checked). The asset becomes `READY`.
5. **Transcription.** `transcribeAsset.ts` extracts 16 kHz mono audio, then sends it to Whisper large-v3 hosted by SporeLabs. It polls and re-invokes itself in hops, for up to about 4 hours of runtime. Every submit carries an `Idempotency-Key`, so a Lambda retry is never billed twice.
6. **Clean-up of Whisper output.** Known Whisper hallucinations ("Thanks for watching" over music, repeat loops) are held out of the caption words but kept in a `hallucinations` list a producer can restore (`utils/sporelabs-transcript.ts`).
7. **Re-transcription.** `POST /assets/{id}/transcribe` re-runs Whisper. A producer's word edits move to the same spoken word within 1 s; edits that can't be placed are kept for review (`utils/word-edit-migration.ts`). Translations carry over too.

Data lives in the `zeevee-media-<stage>` bucket (`raw/`, `chunks/`, `transcriptions/`, `proxy/`, `thumbnails/`) and three DynamoDB tables: `zeevee-assets`, `zeevee-projects`, `zeevee-chunk-tasks`. Media is served through CloudFront signed URLs (`infrastructure/cdn.tf`).

SporeLabs is the one gateway for every model call except TwelveLabs: Whisper, autoframing, Claude Sonnet 4.5, Haiku, gpt-4o-mini and Gemini. Nothing calls Anthropic directly.

## Choosing the scenes: the IQ Agent

The IQ Agent is the only way the UI makes segments today. It is a chat panel in the editor. Claude Sonnet 4.5 cuts the video, then revises the cut as the producer talks to it. Spec: `SPEC-iq-agent.md`.

**Tools the agent can call** (`backend/src/services/iq-agent/tools/`): `search_video` (TwelveLabs Marengo), `read_transcript`, `watch_clip` (Pegasus on a time range, cached in S3), `view_frames` (FFmpeg stills sent as images), `edit_segments`, `check_budget`, `ask_user`, `set_project_title`, `finish_turn`.

**How it stays grounded**

- The prompt requires every cut boundary to be checked visually before it is kept (`prompts.ts`).
- `ledger.ts` does the duration arithmetic in code and returns it with every edit. The model never adds up durations itself. This fixed the client's top complaint, cuts that missed the target length.
- `examined.ts` lists the stretches of video the agent never looked at before it finishes.
- `grounding.ts` warns, but doesn't block, when a title uses a proper noun that isn't in the transcript.

**How it runs**

- `iqAgentApi.ts` is thin. It dedupes the message by idempotency key, takes a per-project run lock, and async-invokes `iqAgentWorker`.
- The worker is stateless. It reloads state from DynamoDB every turn, writes a heartbeat every 20 s, and re-invokes itself when 150 s of its 15-minute limit remain. A run is capped at 60 iterations.
- State sits in two tables. `agent-threads` holds one row per project. `agent-events` is an append-only log, and the chat panel renders only from it. The frontend polls it every 1–20 s depending on activity (`zeevee/src/hooks/useIQAgent.ts`).
- A thread row must stay under DynamoDB's 400 KB item limit, so old turns are trimmed to fit. The event log keeps the full history (`iq-agent/thread.ts`).
- When a run completes, the agent writes delivery metadata (`iq-agent/metadata.ts`) and starts autoframing.

**Older pipelines that still exist.** `POST /projects/{id}/generate` (`generateSegments.ts`) is still deployed, but no UI calls it. Only eval scripts use it. It routes to one of four pipelines in `services/storyiq/`: Pegasus segment definitions (the default), sports-replay highlights, Jockey v1 (a Claude brief plus windowed Pegasus) and Jockey v3 (the TwelveLabs Agents API with deterministic gates and re-asks). We kept them for evals and as a rollback path. "Keep the code, hide the doors" was the call in SPEC-iq-agent §15.1.

## Editor, framing and captions

The editor's rule is that the preview must match the export frame for frame. Most of the editor's complexity serves that rule.

**Saving.** Redux holds all editor state (`zeevee/src/store/editorSlice.ts`). Every edit bumps `localVersion`. `syncMiddleware.ts` autosaves every 10 s when local is ahead of the server. All saves go through one promise chain, so they reach the server in order. Leaving the editor flushes with three retries, and closing the tab warns first. Autosave stands down while the IQ Agent owns the cut, so the two don't overwrite each other.

**Preview equals export.** The preview is a native `<video>` (`hooks/useSeamlessPlayback.ts`) with a caption overlay, not the Remotion Player. Parity comes from sharing code with the Remotion compositions in `zeevee/src/remotion/`: caption timing and grouping, framing interpolation, segment frame bounds, and one canonical fps snap (`lib/sourceFps.ts`). The export cuts clips on the same snapped frame grid.

**Framing (autoframe).** `analyzeFraming.ts` builds a 360p, every-frame proxy of the master. Long masters are encoded in up to 40 parallel slices. It then sends all segments to the SporeLabs reframe service in one job. SporeLabs finds camera cuts and returns one hold (zoom, focusX, focusY) per shot. Only 9:16 is requested; 16:9 output gets a plain fit. Setting `FRAMING_ENGINE=gemini` brings back the older per-segment Gemini path. Producers can override any hold in the timeline.

**Captions.** Words come from Whisper. Producers can correct a word, retime it, or add a missing one. Edits are stored on the project as `captionSettings.wordEdits`, keyed by the original word's start and end time. A typed-in word gets estimated timing and an `estimated` flag so it gets reviewed. Captions hold 3.5 s after the last word. English and Spanish translation runs through gpt-4o-mini (`translateCaptions.ts`).

**Fingerprints.** A render fingerprint hashes everything that changes a scene's pixels: bounds, framing, captions, word edits and `RENDER_PIPELINE_VERSION`. It decides when a stored scene MP4 is stale and can be skipped on the next export. The same hash is computed in `zeevee/src/lib/segmentRenderFingerprint.ts` and `backend/src/utils/segmentRenderFingerprint.ts`. If you change one, change the other. Bump the version when the Remotion output changes.

## Export: from button to zip

An export is two stages. FFmpeg cuts frame-exact clips, then Remotion burns in captions and framing one scene at a time. Scenes whose fingerprint hasn't changed are reused rather than re-rendered. `backend/RENDERING.md` has more depth.

1. **Flush and start.** `ExportPanel.tsx` queues a save, then calls `POST /projects/{id}/render`. `renderVideo.ts` snapshots the editor inputs and claims the project's single export slot with a conditional write. A second click gets a 409 with the running job, and the UI attaches to it. Limits: 60 scenes and 2 hours of total footage.
2. **Cut.** `cutSegments.ts` runs in the FFmpeg container Lambda `zeevee-stitch-segments` (3 GB memory, 15 min, 10 GB disk). It downloads the master once, re-encodes each scene with 10 workers, honours the source's edit list, and caps output at 1080 px on the short side. 4K sources made this cap necessary.
3. **Render.** For each clip it calls `renderMediaOnLambda` with 300 frames per Lambda. The Remotion function is `remotion-render-4-0-387-mem3008mb-disk10240mb-900sec`, the account's maximum memory, disk and timeout. It is deployed by hand with the Remotion CLI; the exact command is in the comment at the top of `infrastructure/remotion.tf`.
4. **Track.** The UI polls `GET /renders/{jobId}`. `utils/renderJobProgress.ts` retries a failed scene up to 4 times, backs off on AWS capacity errors, and ends the job after 2 hours. Finished scenes are kept even when others fail, and the slot is always released. `GET /projects/{id}/job` also reaps jobs whose heartbeat went stale.
5. **Package.** `packageExport.ts` streams scene MP4s (`scene_NN_Title.mp4`), metadata JSON and thumbnails into a zip in the renders bucket. Download links last 12 hours. A matching zip is reused.

**Metadata** for each scene (description, tags, IAB content categories) comes from the IQ Agent when it made the cut. Otherwise `generateExportMetadata.ts` makes it at export time: Pegasus describes the clip, and Sonnet rewrites the description using the transcript.

The Remotion bundle is a separate deploy from the app. `zeevee/deploy-remotion-site.sh` publishes it, and GitHub Actions runs that script when `zeevee/src/remotion/**` changes. Vercel never updates it, so a caption-styling change shows in the preview but not in exports until that workflow has run.

## Tradeoffs we made

Most of these were deliberate calls for a fast-moving client project. Each one has a cost, and the costs are listed plainly so you can decide which to pay down.

| Decision | Why we made it | What it costs |
| --- | --- | --- |
| All-serverless: Lambda, DynamoDB, S3, no servers or queues | No idle cost, nothing to patch, scales to zero between client sessions | Every long job has to fit in 15-minute Lambda hops. That means self-invocation, heartbeats and reapers in transcribe, framing, agent and export. That code is the hardest to reason about. |
| An LLM agent picks the scenes (IQ Agent) instead of a fixed pipeline | The fixed pipelines (Jockey v1, Pegasus) made "(Part N)" fragments and cuts that ran into the next scene; producers wanted to steer the cut in conversation | Results vary run to run and are hard to regression-test. Cost has no hard cap, only a meter and structural limits (time-ranged Pegasus, a clip cache). |
| Old pipelines kept but hidden ("keep the code, hide the doors") | Cheap rollback and eval baselines | About 8,000 lines in `services/storyiq/` and `generateSegments` that the product doesn't use. `detectScenes.ts` and `indexChunks.ts` are deployed but nothing calls them. |
| SporeLabs as the one model gateway | One key, one bill, one retry policy; it also hosts Whisper and the shot-hold reframer | A single vendor dependency for captions, framing and every LLM call. If SporeLabs is down, most of the product is down. |
| Whisper for captions instead of TwelveLabs transcripts | Much better word timing; captions no longer wait on indexing | A second transcription vendor path, plus hallucination clean-up and edit-migration logic to maintain |
| Native `<video>` preview with shared code instead of the Remotion Player | Smooth scrubbing and playback on long sources | Parity depends on discipline. The shared modules, and the fingerprint duplicated in frontend and backend, must change together. |
| Re-encode every export clip; FFmpeg in a container Lambda | Frame-exact cuts that match the editor; stream copy snaps to keyframes | Slower and costlier cuts. 4K sources needed the 10 GB disk and 1080 px cap. Renders now use the account's maximum Lambda memory, disk and timeout, so the next size step means leaving Lambda. |
| Shared-password auth (`x-api-password` mapped to a user id) | Enough for a closed pilot with one client team | No real accounts or sessions. Projects aren't scoped per user, only assets. This must be replaced before any wider access. |
| Manual steps outside OpenTofu | Speed | The Remotion function deploy, secret values, and the FFmpeg `:latest` image tag sit outside state. A fresh account cannot be stood up from `tofu apply` alone. |
| Tests are plain `tsx` scripts, no framework | Low ceremony | Coverage is thinner than it looks. CI now runs the tests on every PR and before each deploy. |

## Running it

**Deploys are meant to be automatic, but CI deploys are broken today.** A push to `main` that touches `backend/`, `infrastructure/` or `deploy.sh` runs `.github/workflows/deploy.yml`. It runs the tests, builds, and calls `./deploy.sh`. The FFmpeg image is rebuilt only when its inputs change. A push that touches `zeevee/src/remotion/**` republishes the Remotion site. Vercel deploys the app from Git on its own.

Every `Deploy backend` run since at least October 6 has failed on its first AWS call ("The security token included in the request is invalid"). The key in the `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` repo secrets doesn't match any active key in the AWS account, so it was most likely deleted or rotated in IAM. A repo admin has to set a valid key. Until then, the backend is deployed by hand with `./deploy.sh` from a machine that has the `zeevee` profile. The `Test` workflow needs no AWS access and runs normally.

As of the handoff, `main` is one fix ahead of production: the 17-minute scene-render timeout. The next `./deploy.sh --skip-docker` ships it.

**Manual deploy:** `./deploy.sh` (full), `./deploy.sh --skip-docker` (no FFmpeg image rebuild), `./deploy.sh --stitch-only` (just the cutting Lambda). Every command uses the AWS profile `zeevee` in `us-west-2`. OpenTofu state is in S3 bucket `zeevee-tfstate-730898501390` with a DynamoDB lock.

**Local:** `cd zeevee && npm run dev` runs the editor against the live API (`VITE_API_URL` in `.env.local`). Tests: `npm test` in `zeevee/` and in `backend/`. `backend/src/scripts/live-api-smoke.ts` is a smoke test against production; it needs `API_PASSWORD` set.

**Logs:** `aws logs tail /aws/lambda/<function> --follow --profile zeevee`. The functions you'll read most are `zeevee-iq-agent-worker`, `zeevee-transcribe-asset`, `zeevee-analyze-framing`, `zeevee-stitch-segments` and `zeevee-get-render-status`.

**Where secrets live.** Runtime secrets live in AWS Secrets Manager. Lambdas read them at runtime, and none are in the repo or its history.

| Secret | Used for | Notes |
| --- | --- | --- |
| `zeevee/12labs-key` | TwelveLabs indexing, Pegasus, Marengo | Org key |
| `zeevee/12labs-signing-secret` | Verifying TwelveLabs webhooks | |
| `zeevee/coleman-jockey-12labs-key` | Jockey v3 Agents API only | A personal key. Replace it with an org key. |
| `zeevee/sporelabs-api-key` | Whisper, reframe, all LLM calls | The most critical key |
| `zeevee/api-password` | App sign-in: JSON map of password to user id | Add a password here to give someone access |
| `zeevee/showcase-read-key` | Bearer key for the showcase catalogue endpoint | |
| `zeevee-cloudfront-private-key` | Signing media URLs | Generated by OpenTofu |
| `zeevee/anthropic-api-key`, `zeevee/openrouter-api-key` | Nothing at runtime | Leftovers, safe to delete |

GitHub Actions holds only `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for deploys. Vercel holds `VITE_API_URL`. The IAM user `jt-white-s3` has S3-only access; full deploy access needs its own IAM user or an admin key.

## Known issues and what we'd do next

Nothing below is on fire. These are the places most likely to bite, roughly in the order we'd tackle them.

- [ ] **CI deploy key.** Put a valid AWS key in the GitHub secrets (see Running it).
- [ ] **Auth.** Replace the shared password with real accounts (Cognito or similar), and scope projects per user. `POST /webhook` and header-less invocations skip the password check by design.
- [ ] **Webhook hardening.** `processWebhook.ts` compares signatures without constant-time equality or a timestamp window. Concurrent chunk webhooks do a non-conditional read-modify-write of the `chunks` array and can race.
- [ ] **Uploads with other extensions.** Only `.mp4`, `.mov` and `.m4v` fire the S3 trigger. Anything else uploads and then sits in `UPLOADING` forever.
- [ ] **Long-video split relies on the client.** Splitting only happens when the browser reported a duration over 60 min. If it didn't, a long video goes to TwelveLabs whole and fails.
- [ ] **Dead code.** `detectScenes.ts`, `indexChunks.ts` and `services/openrouter.ts` are unused. Removing them takes an infra change, since the first two are deployed. Decide whether the legacy `storyiq/` pipelines (about 8,000 lines) are still worth keeping as a rollback.
- [ ] **Personal TwelveLabs key.** Jockey v3 uses `zeevee/coleman-jockey-12labs-key`. Move it to an org key, or drop it with Jockey.
- [ ] **Unused secrets and IAM grants.** `zeevee/anthropic-api-key` and `zeevee/openrouter-api-key` can be deleted, along with the OpenRouter grant in `infrastructure/compute.tf`.
- [ ] **Manual infra.** Bring the Remotion function deploy and the FFmpeg image tag under OpenTofu, so a new environment comes up from `tofu apply`.
- [ ] **Single-vendor risk.** SporeLabs sits in the path of captions, framing and the agent. Add a status check or alert, and keep the Gemini framing fallback working.
- [ ] **Agent spend.** The IQ Agent has a cost meter but no hard cap. Add a per-run ceiling if usage grows beyond the pilot.
