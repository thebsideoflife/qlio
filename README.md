# Qlio

Qlio (formerly ZeeVee) turns long-form video into short vertical clips with captions. A producer uploads a master, works with the IQ Agent to choose scenes, tunes captions and framing in the editor, and exports a zip of MP4s plus metadata.

New to the codebase? Start with [docs/HANDOFF.md](docs/HANDOFF.md): how the system works, the tradeoffs we made, how to run it, and known issues.

| Folder | What it is | Deployed by |
| --- | --- | --- |
| `zeevee/` | React + Vite editor (package `qlio`) and the Remotion caption compositions | Vercel (app); GitHub Actions publishes the Remotion site |
| `backend/` | TypeScript AWS Lambda handlers (`src/handlers/*.ts`), bundled by esbuild | GitHub Actions on push to `main` via `deploy.sh` |
| `infrastructure/` | OpenTofu for API Gateway, Lambda, DynamoDB, S3, CloudFront, ECR | Same workflow (`tofu apply`) |

## How it fits together

1. **Upload**: the browser uploads straight to S3 (`raw/`) with short-lived STS credentials.
2. **Transcribe and index in parallel**: Whisper large-v3 on SporeLabs produces caption words (`transcribeAsset`). TwelveLabs indexes the video (`startIndexing`, with `splitVideo` for sources over 60 minutes).
3. **Choose scenes**: the IQ Agent (`backend/src/services/iq-agent/`) is a chat-driven Claude Sonnet agent. It searches, reads and watches the video, then edits the segment list. Spec: `SPEC-iq-agent.md`.
4. **Edit**: the editor previews with a native `<video>` element and shares caption, framing and frame-bound code with the Remotion compositions, so the preview matches the export.
5. **Autoframe**: `analyzeFraming` builds a 360p proxy and asks the SporeLabs reframe service for one 9:16 crop hold per camera shot.
6. **Export**: `renderVideo`, then `cutSegments` (FFmpeg, frame-exact clips), then Remotion Lambda (captions and framing), then `packageExport` (zip). See `backend/RENDERING.md`.

All model calls except TwelveLabs go through SporeLabs, an OpenAI-compatible gateway. Secrets live in AWS Secrets Manager under `zeevee/*`.

## Commands

```bash
# Frontend
cd zeevee && npm install && npm run dev   # uses VITE_API_URL from .env.local
npm test && npm run lint && npm run build

# Backend
cd backend && npm install
npm test
npx tsc --noEmit -p .
npm run build

# Deploy (normally done by CI on push to main)
./deploy.sh                 # backend build + FFmpeg image + tofu apply
./deploy.sh --skip-docker   # skip the FFmpeg image rebuild
./zeevee/deploy-remotion-site.sh   # Remotion bundle (CI runs this on remotion changes)
```

AWS profile `zeevee`, region `us-west-2`. The Remotion render function itself is deployed by hand; the command is at the top of `infrastructure/remotion.tf`.

## Known sharp edges

- Auth is a shared password per user (`x-api-password`, mapped in the `zeevee/api-password` secret). Projects are not scoped per user. Replace this before wider access.
- `generateSegments` and the StoryIQ/Jockey pipelines in `backend/src/services/storyiq/` are deployed, but the UI no longer calls them. They are kept for evals and rollback.
- `detectScenes` and `indexChunks` are deployed but nothing invokes them.
- The render fingerprint is computed in both `zeevee/src/lib/segmentRenderFingerprint.ts` and `backend/src/utils/segmentRenderFingerprint.ts`. Change them together.
- Root `SPEC-*.md`, `ARCHITECTURE_REPORT.md` and `COST_ESTIMATE.md` are design history. Each has a status line saying how it relates to current code.
