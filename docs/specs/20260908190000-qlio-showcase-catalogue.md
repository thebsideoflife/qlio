# Qlio Showcase catalogue

## Context

`qlio-showcase` is a sales-demo Expo app that plays Qlio cuts as vertical micro-series. It already has a `ContentProvider` seam and a `QlioApiProvider` skeleton. Today it only shows fixtures: stock clips, invented episode notes, guessed `/showcase/*` paths.

Qlio DynamoDB has the real cuts. There is no playlist flag, no persisted Export selection, and `GET /projects` without `assetId` returns `[]`. The app must not dump all 196 `DRAFT` projects onto a prospect's phone.

## Intent

1. Serve a live catalogue from two hardcoded, already-rendered projects. Changing the demo later is editing that ID list and redeploying.
2. One read-only endpoint: `GET /showcase/catalogue` → `{ assets, series }` in the mobile `Catalogue` shape. The app derives series-by-id, asset-by-id, and the interleaved feed on device.
3. Auth with a dedicated showcase read secret (`Authorization: Bearer` / `EXPO_PUBLIC_QLIO_API_KEY`), not the dashboard `x-api-password`.

## Non-goals

- DynamoDB schema changes, GSIs, playlist tables
- Persisting Export checkboxes (`exportSegmentIds`) or an `inShowcase` flag
- Export-panel UI ("Show in Qlio app")
- Four REST resources (`/showcase/series`, `/assets`, `/feed`)
- Public/unauthenticated CloudFront for MP4s
- Returning the whole Qlio catalogue

## Hardcoded projects

Episodes = that project's `segments` that have a `segmentRenders` row with an object. No checkbox subset.

| Series | `projectId` | Why |
| --- | --- | --- |
| Nashville **Lionsgate Cut 081926** | `dc1a5723-6142-40ea-89b6-4cf257c56501` | 26 rendered parts; featured |
| Bourdain **Why the French don't suck** | `36e52c4c-220f-4223-9831-e0387604eb85` | 6 parts on `zeevee-renders-dev` |

## API

New Lambda `backend/src/handlers/showcase.ts`, route in a small `infrastructure/networking_showcase.tf` (or sibling).

`BatchGet` the two projects and their assets. Map at read time. Presign `segmentRenders` (prefer `zeevee-renders-dev` over Remotion-Lambda keys) and thumbnails. 12h TTL; the app fetches on launch.

Do not reuse `GET /projects`.

### Mapping

| Showcase field | Source |
| --- | --- |
| `MicroSeries.id` | `projectId` |
| `title` | `project.title` |
| `tagline` / `Episode.note` | segment `description`, else short metadata |
| `hue` | `hash(projectId) % 360` |
| `featured` | Nashville |
| `Episode.sourceIn` / `sourceOut` | `startTime` / `endTime` |
| `Episode.durationSec` | `endTime - startTime` |
| `Episode.videoUrl` | presigned `segmentRenders[].bucket/key` |
| `Episode.posterUrl` | presigned segment or project thumbnail |
| `SourceAsset` | `originalName`, `duration`, map `assetType` → `kind` |

Response matches `qlio-showcase/src/data/types.ts` (`Catalogue`, `MicroSeries`, `Episode`, `SourceAsset`).

## App

`QlioApiProvider.getCatalogue()` calls `GET /showcase/catalogue` once. `getSeries` / `getSourceAsset` / `getFeed` use that payload (feed interleave already lives in `src/data/provider.ts`). Set `EXPO_PUBLIC_QLIO_API_URL` and `EXPO_PUBLIC_QLIO_API_KEY`. Keep `ResilientProvider` fixture fallback.

The showcase app is a separate repo (zip from JT). This spec is the Qlio-side contract; wiring the Expo `.env` happens there.

## Ship

Backend + infra via the usual `./deploy.sh` / GHA path. No frontend (Vercel) change in this repo.
