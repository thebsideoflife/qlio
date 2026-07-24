# Framing toggle: "Square-Top Portrait" mode

## Context · persona · why now

- **Product:** zeevee (a.k.a. Qlio) — short-form video editor. Source video is 16:9; the editor reframes it into 9:16 / 1:1 / 16:9 outputs via Remotion.
- **Repository:** `ColemanIsner/zeevee`. Frontend in `zeevee/` (Vite + React 19 + Redux Toolkit + Remotion 4); serverless backend in `backend/` (Lambda + DynamoDB + Remotion Lambda). Frontend deploys via Vercel on merge to `main`; backend deploys via `./deploy.sh` (human-gated product — agents do not deploy).
- **Persona:** a producer who needs a fast, no-AI way to ship a portrait clip where the talking-head video sits as a square at the top of the frame (e.g. for a platform that wants 9:16 with a square video region up top and space below).
- **Why now:** today the only way to control framing/aspect is the "Dist. Platform" selector buried inside the AI generation (`MicroseriesGenerator` / "IQ") panel, which only maps to `9:16` vs `16:9` and offers no square-top layout. The operator asked for a clean, single-click toggle that wipes out all other framing. No new AI, no subject detection — just Remotion layout math.

## Intent

Add a new **framing toggle** — a simple one-click button in a clean settings location — that, when enabled, makes the portrait (9:16) output render the source video as a **square (1:1) crop, aligned with the top of the portrait frame**, and **wipes out all other framing** (no per-segment zoom/focus/keyframe reframing is applied while this mode is on). Uses basic Remotion layout settings; no AI.

Exact operator intent (verbatim, lightly typos corrected): *"We want to add a new framing toggle which should wipe out all other framing. Should be setting somewhere clean. Portrait orientation, but the actual video should be square and aligned with the top of the portrait view. Simple button click with basic remotion settings. No AI needed."*

## In scope

### Data model
1. **Add `squareTop?: boolean` to `GlobalFramingSettings`** in both places the type is declared:
   - `zeevee/src/remotion/types.ts` (`GlobalFramingSettings`, `DEFAULT_GLOBAL_FRAMING`) — keep `DEFAULT_GLOBAL_FRAMING.squareTop = false`.
   - `zeevee/src/services/api.ts` (`GlobalFramingSettings`) — mirror the field.
   - Backend type `GlobalFramingSettings` in `backend/src/handlers/renderVideo.ts` (and any sibling handler that declares it) — add `squareTop?: boolean` and set `DEFAULT_GLOBAL_FRAMING.squareTop = false`.
   - `squareTop` is only honored when `globalFraming.enabled === true` (consistent with existing `framingEnabled` gating in `CaptionedVideo`).

### State + reducer (`zeevee/src/store/editorSlice.ts`)
2. **Add a reducer `setSquareTopEnabled`** taking `boolean`:
   - Sets `state.globalFraming.squareTop = enabled`.
   - Calls `markEdited(state)` (so it syncs, like `setFramingEnabled`).
   - Does **not** mutate or delete any segment's `framing`/keyframes (see "Wipe-out semantics" below).
   - Export it from the slice and wire into `editorSlice.actions`.

### Rendering — Remotion (`zeevee/src/remotion/`)
3. **Square-top layout in the composition.** In `CaptionedVideo.tsx`, when `globalFraming?.squareTop` is true, render the square-top layout for every segment (and the no-segments full-video path), **ignoring `segment.framing` entirely**:
   - Canvas is the portrait composition (`CaptionedVideoPortrait`, 1080×1920). The source 16:9 video is center-cropped to a **1:1 square** and placed at the **top** of the frame: a 1080×1080 square anchored at `top: 0`, full width.
   - The remaining 840px below the square is background (`backgroundColor: "black"` via `AbsoluteFill`).
   - Captions (`CaptionDisplay`) still render over the square video region (unchanged caption settings). Keep captions within the top square, not the lower empty band.
   - Use only basic Remotion primitives (`AbsoluteFill`, `OffthreadVideo` with `objectFit: "cover"` + `objectPosition: "center center"` sized to the square, or an absolutely-positioned square wrapper). **No AI, no focus/zoom math, no `AutoFramedVideo` keyframe path.**
   - Recommended: extract a small `SquareTopVideo` component (or an inline branch in `CaptionedVideo`) so the layout is grep-able and reviewable. Keep it ≤ ~150 lines (see repo `modularization` skill).
4. **Composition selection stays correct.** `zeevee/src/remotion/Root.tsx` already defines `CaptionedVideoPortrait` (1080×1920); reuse it — **do not add a new composition**. The layout branch above is gated by the `globalFraming.squareTop` input prop, which is already part of `CaptionedVideoProps` (carries `globalFraming`).

### Editor preview (`zeevee/src/pages/Editor.tsx`)
5. **Preview mirrors the square-top layout.** The in-browser `<video>` preview (the `style={(() => {...})()}` block) needs a `squareTop` branch: portrait container (`aspectRatio: 9/16`) with the video rendered as a square crop at the top (object-fit cover, height = width, `top: 0`), black below. Reuse the existing `aspectRatioValue`/container logic; only add the square-top rendering case.
6. **Hide framing controls when squareTop is on.** When `globalFraming.squareTop` is true, the zoom slider badge (top-right), the `FramingSlider` components, and the drag-to-reposition cursor must be hidden/disabled — square-top wipes out all other framing, so those controls are meaningless. Toggling squareTop off restores them.

### Clean toggle UI ("setting somewhere clean")
7. **Add a clean one-click framing toggle** in the editor preview area — **not** inside the `MicroseriesGenerator` / IQ panel (the operator explicitly wants it out of the buried AI panel). Recommended placement: a small toggle button in the same top-right control cluster as the existing zoom badge (a sibling pill/button), labeled clearly (e.g. "Square Top"). Use existing UI primitives (`@/components/ui/button`, `@/components/ui/switch`, or the existing pill style). One click flips `setSquareTopEnabled`. Keep it visually distinct and discoverable.
   - This is a **framing** control; it must not be coupled to the "Dist. Platform" selector. `platformToAspectRatio` is unaffected.

### Render fingerprint (cache invalidation) — TWO files in lockstep
8. **Include `squareTop` in the render fingerprint** so existing renders are correctly marked stale when the toggle changes. Update **both** mirrored copies:
   - `zeevee/src/lib/segmentRenderFingerprint.ts` — add `squareTop: globalFraming.squareTop` to the hashed `payload` (the fingerprint already hashes `aspectRatio`; add the sibling field).
   - `backend/src/utils/segmentRenderFingerprint.ts` — mirror the exact same change (this file's header explicitly says *"Mirrors zeevee/src/lib/segmentRenderFingerprint.ts"*). The two must stay byte-identical in logic or renders/`ExportPanel` staleness checks will disagree.

### Backend render path (`backend/src/handlers/`)
9. **`renderVideo.ts`**: when `globalFraming.squareTop` is true, **force the portrait composition** regardless of `aspectRatio`:
   - Update `getCompositionId` (or the call site at line ~232) so that `squareTop` ⇒ `"CaptionedVideoPortrait"`. `aspectRatio` is otherwise unchanged in state.
   - `globalFraming` is persisted wholesale to DynamoDB by `updateProject.ts` (`exprValues[":gf"] = globalFraming`) and passed to the Remotion render as `inputProps.globalFraming` by `cutSegments.ts` (`globalFraming: { ...globalFraming, enabled: true }`). Because both **spread** the object, `squareTop` flows through with **no schema/serialization change**. Confirm no handler strips unknown fields.
   - `cutSegments.ts` builds `segmentFraming` from `segment.framing` (lines ~253–259); with squareTop on, `CaptionedVideo` ignores it anyway, but do **not** rely on that silently — leave `segmentFraming` construction as-is (the composition branch is the source of truth for "wipe out").

### Sync / persistence
10. **No backend schema migration.** DynamoDB is schemaless and `globalFraming` is stored as a map; `syncMiddleware.ts` already sends `globalFraming` in `updateProject`. A `squareTop: false` default must be applied on read for projects created before this feature (i.e. when loading a project, treat missing `squareTop` as `false`). Find where `setGlobalFraming` is dispatched from the API response (e.g. `useProjectData.ts`) and ensure a defaulted value (or default at the type read site).

## Out of scope
- Any new Remotion composition (reuse `CaptionedVideoPortrait`).
- AI-based reframing, subject/face tracking, or any ML. The whole point is "no AI".
- Changing the existing `AspectRatio` enum or `platformToAspectRatio` mapping.
- Changing the export-metadata pipeline, ad settings, or captioning model (captions continue to render unchanged).
- Persisting square-top as a destructive clear of segment keyframes (see "Wipe-out semantics" — non-destructive by design).
- Backend deploy / Vercel deploy / running `./deploy.sh` (human-gated product; agent does not deploy).
- Unrelated refactors, dependency bumps, or product work outside this feature.

## Constraints · deploy policy · safety

- **Preserve existing behavior outside this feature:** `squareTop` defaults to `false` everywhere; every code path that doesn't set/read it is unchanged.
- **Non-destructive wipe-out (chosen design, with rationale):** enabling `squareTop` **overrides/ignores** segment keyframe framing during render — it does **not** delete stored `segment.framing`/keyframes. Toggling it off restores prior framing. Rationale: reversible, matches "simple button click", and avoids surprising data loss. The framing UI controls are hidden while on so the user cannot fight the mode. (Alternative considered: actually clearing keyframes on enable — rejected as destructive and not required by "simple toggle" intent.)
- **Human-gated deploy:** zeevee is a human-gate product. Do **not** merge the PR or run `./deploy.sh`/Vercel deploy. Leave the PR open for the operator.
- **Backend type mirror discipline:** the two `segmentRenderFingerprint.ts` files must agree. A mismatch silently breaks the `ExportPanel` stale-detection cache.
- **File-size / layering:** follow repo `modularization` + `layered-architecture` skills — keep new components small; framing render logic stays in `remotion/`, state in `store/`, UI in `components/` / `pages/`.
- **No raw-SQL / dynamic-import concerns** for this change (frontend-only layout + Redux + Remotion).
- **Backward compatibility for old projects:** missing `squareTop` on load ⇒ `false`.

## Acceptance criteria
- A clean, one-click "Square Top" framing toggle exists in the editor preview area (not the IQ panel).
- When enabled: preview and Remotion render show a 9:16 portrait frame with the source video as a 1:1 square aligned to the **top**, black below; captions render over the square.
- When enabled: all other framing controls (zoom slider, FramingSliders, drag-to-reposition) are hidden/disabled, and no per-segment keyframe framing is applied to the render.
- When disabled: behavior is byte-for-byte identical to today (existing framing + aspect-ratio modes fully restored; stored keyframes untouched).
- `squareTop` syncs to the backend and is selected by `renderVideo.ts` (forces `CaptionedVideoPortrait`); old projects default to `squareTop: false` on load.
- Both `segmentRenderFingerprint.ts` copies include `squareTop` and agree.
- Repo static checks pass (`lint`, `tsc -b`), relevant tests pass, production build (`tsc -b && vite build`) succeeds.
- A PR exists from `factory/mission-45b8fa40-8cd` into `main`, is mergeable, and stays open (human gate).

## Verify contract (exact commands / probes)

Run from repo root. Paste outputs as evidence. Skip-with-reason anything that needs AWS/external credentials.

**Static checks — frontend:**
```bash
cd zeevee && npm ci && npm run lint
```
**Static checks — backend (esbuild bundle):**
```bash
cd backend && npm ci && npm run build
```
**Relevant automated tests:**
```bash
# Frontend fingerprint self-test (documented in zeevee/package.json test:fingerprint)
cd zeevee && npm run test:fingerprint
# Backend test scripts hit AWS/external services (export-metadata, jockey coverage, v3 gates)
# — run only if credentials/env are present; otherwise SKIP with reason and cite the script names.
cd backend && npm run test 2>/dev/null || echo "SKIP: backend npm run test requires AWS/external credentials (test:export-metadata, test:jockey-coverage, test:jockey-v3-gates)"
```
**Production build (frontend supports one):**
```bash
cd zeevee && npm run build   # = tsc -b && vite build
```
**PR / ship close-out (human gate — do NOT merge or deploy):**
```bash
gh pr view <PR_NUMBER> --repo ColemanIsner/zeevee --json url,mergeable,state,baseRefName,headRefName
```
- Confirm a PR is open from `factory/mission-45b8fa40-8cd` → `main`, `mergeable` is not `CONFLICTING`, and `state` is `OPEN`.
- Cite the PR URL. Do not merge. Do not run `./deploy.sh` or trigger Vercel deploy.

**Skipped checks** (report explicitly): backend `npm run test` when AWS/external creds are unavailable; no staging deploy (human gate).
