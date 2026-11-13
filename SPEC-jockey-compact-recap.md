# Implementation Spec: Jockey Pipeline for Compact & Episode Recap

**SOW:** `SOW-jockey-compact-recap.md`  
**Status:** Ready for implementation  
**Effort:** 40h across 4 milestones

---

## Goal

Replace direct Pegasus segmentation for `compact_video` and `episode_recap` with a **Jockey-style orchestration**: Gemini pre-processes transcript + producer prompt into structured narrative guidance, then Pegasus segments with enriched prompts and timeline windowing. Sports, highlights, and full_video stay on the existing Pegasus path.

**Do not** deploy LangGraph Jockey in Lambda. Port the pattern in TypeScript inside `backend/src/services/storyiq/`.

---

## Scope

| In | Out |
|----|-----|
| `compact_video`, `episode_recap` generation | Sports highlights (`sports-highlights-pipeline.ts`) |
| Feature flag + Pegasus rollback | `full_video`, `trailer`, `season_recap` |
| Long-form windowing (55–85 min) | `generate-export-metadata` Lambda |
| Fail loudly when Jockey enabled | Frontend UX changes |
| Local `jockey:eval` script | Thumbnail generation |

**Export metadata note:** mood/theme/tone/IAB are produced by the export-metadata pipeline, not generation. Generation must emit correct segment titles/descriptions (≤10 words) that export can use.

---

## Current State (read these first)

```
generateSegments Lambda
  → storyiq/index.ts :: generateWithStoryIQ()
    → Phase 1: transcript from S3 (tools.ts)
    → Phase 2: pegasus-pipeline.ts :: generateSegmentsWithPegasus()
         → classifyContent() — skipped when userInstructions set
         → sports → sports-highlights-pipeline.ts
         → else → createQlioPegasusSegmentationTask() per physical chunk
         → filter microseries_keep / recap_keep
         → selectSegmentsForTarget() (compact only)
```

**Key files**

| File | Role |
|------|------|
| `backend/src/services/storyiq/index.ts` | Entry — add Jockey routing here |
| `backend/src/services/storyiq/pegasus-pipeline.ts` | Current compact/recap path; extract shared helpers if needed |
| `backend/src/services/pegasus-segmentation.ts` | Segment defs, task create/poll |
| `backend/src/services/storyiq/pegasus-selection.ts` | Duration trim scoring |
| `backend/src/services/storyiq/sports-highlights-pipeline.ts` | **Reuse** virtual windowing via `limitAnalysisToWindow` |
| `backend/src/handlers/generateSegments.ts` | Maps `ProposedSegment` → DynamoDB; **silently falls back** on error |

**Output contract** — must not change (`types.ts`):

```typescript
interface ProposedSegment {
  startTime: number;
  endTime: number;
  title: string;           // 3–5 words → DynamoDB title
  reasoning: string;       // → description
  expectedContent: string; // transcript snippet → keyDialogue
  section?: string;        // e.g. "role-main_story", "role-setup"
}
```

Handler mapping: `generateSegments.ts` lines ~400–411.

**Defaults today**

| Purpose | Target if unset | Segment bounds (UI) | Keep field |
|---------|-----------------|---------------------|------------|
| `compact_video` | **50%** of source | 60–180s | `microseries_keep` |
| `episode_recap` | 75s | 10–20s | `recap_keep` (prompt asks for 4–6 yes) |

**Long-form:** Videos >60 min are split into 55-min physical chunks (`splitVideo.ts`). Pegasus runs one task per chunk with no sub-windowing — likely cause of second-half bias. Sports uses 10-min virtual windows with `limitAnalysisToWindow`; compact/recap do not.

**Secrets:** `coleman-jockey-12labs-key` exists in `infrastructure/secrets.tf` but is not wired to any Lambda. `GEMINI_SECRET_ARN` is already on `generateSegments`.

---

## Target Architecture

```
Transcript + userPrompt + metadata
  → [Phase 0] Claude preprocess (Bedrock) → NarrativeBrief
  → [Phase 1] Window planner → AnalysisWindow[]
  → [Phase 2] Parallel Pegasus tasks (enriched segment defs + time_ranges)
  → [Phase 3] Merge, dedupe, coverage check
  → [Phase 4] Keep filter + selectSegmentsForTarget (compact) → ProposedSegment[]
  → [Phase 5] applyNarrativeTitles (beat labels / transcript — no Part N)
```

**Routing** in `storyiq/index.ts`:

```typescript
if (useJockeyPipeline && (purpose === COMPACT_VIDEO || purpose === EPISODE_RECAP)) {
  return generateSegmentsWithJockey(twelvelabs, options);
}
return generateSegmentsWithPegasus(twelvelabs, options);
```

---

## New Modules

```
backend/src/services/storyiq/
  jockey/
    types.ts           # NarrativeBrief, StoryBeat, AnalysisWindow
    prompts.ts         # Gemini + Pegasus prompt templates (Scott's patterns)
    preprocess.ts      # Gemini: transcript → NarrativeBrief
    window-planner.ts  # Brief + duration → windows
    coverage.ts        # Timeline distribution validator
  jockey-pipeline.ts   # Orchestrator
```

**Reuse (do not duplicate):**

- `createQlioPegasusSegmentationTask`, `pollPegasusAnalyzeTask`, `parsePegasusSegmentationData` — `pegasus-segmentation.ts`
- `rowsToProposedSegments`, `resolveVideoContextForPegasus`, `mergeChunkResults` — `pegasus-pipeline.ts`
- `selectSegmentsForTarget`, `buildPegasusMetadataMap` — `pegasus-selection.ts`
- Virtual window + offset mapping — `sports-highlights-pipeline.ts` (~lines 349–427)
- Transcript truncation — `utils/transcript.ts` / `export-metadata-enrich.ts`
- Gemini client pattern — `handlers/analyzeFraming.ts`

---

## Types

```typescript
interface StoryBeat {
  id: string;
  label: string;                  // ≤10 words
  approximateStartSec: number;    // from transcript timestamps only
  approximateEndSec: number;
  narrativeRole: "setup" | "escalation" | "pivot" | "payoff" | "main_story" | "secondary_story";
  characters: string[];
  dialogForward: boolean;
  producerTheme?: string;
}

interface NarrativeBrief {
  logline: string;
  arcs: Array<{ name: string; beats: StoryBeat[] }>;
  recapBeats?: StoryBeat[];       // episode_recap: ordered 4–6 candidates
  producerNotes: string;
  targetRuntimeSec: number;
}

interface AnalysisWindow {
  videoId: string;
  localStartSec: number;
  localEndSec: number;
  physicalOffsetSec: number;      // for original-timeline mapping
  chunkIndex: number;
  arcNames: string[];             // arcs overlapping this window
}
```

Validate with Zod. Reject beats whose timestamps don't align with transcript segment boundaries.

---

## Phase 0: Claude Preprocess (Bedrock Sonnet)

**Input:** transcript, `userInstructions`, title, `durationSec`, purpose, `targetDurationSec`  
**Model:** Claude Sonnet — now `anthropic/claude-sonnet-5.5` via SporeLabs (`SPORELABS_SONNET_MODEL`); originally Bedrock `us.anthropic.claude-sonnet-4-5-20250929-v1:0` with an Anthropic API fallback  
**Key rules in prompt:**

- Timestamps must come from ASR segments — never invent times
- `compact_video`: named narrative arcs when producer prompt names themes/scenes; dialog-forward beats
- `episode_recap`: exactly 4–6 ordered connected beats; "Previously on…" tone
- Target runtime guidance: compact `~{target}s from {duration}s` (default **50%**); recap `4–6 beats, ~60–90s`

**Not Gemini.** `GEMINI_SECRET_ARN` stays on Lambda for framing/classification only.

---

## Phase 1: Window Planner

| Duration | Strategy |
|----------|----------|
| ≤ 30 min | Single Pegasus task |
| > 30 min | Virtual windows: **15 min, 60s overlap** (tune on eval asset) |

For chunked assets: use each chunk's `videoId`, window in local coords, map to original timeline via `physicalOffsetSec` (same rule as sports pipeline comments).

Align window boundaries to nearest arc beat (±30s) when possible.

**Pegasus call per window:**

```typescript
createQlioPegasusSegmentationTask(client, {
  video: { type: "asset_id", assetId },
  segmentDefinitions: buildJockeySegmentDefinitions(brief, purpose, opts),
  limitAnalysisToWindow: { startTime: localStart, endTime: localEnd },
  minSegmentDuration,
  maxSegmentDuration,
});
```

Enrich existing defs from `pegasus-segmentation.ts` (`qlioMicroseriesSegmentDefinitionsForGeneration` / `episodeRecapSegmentDefinitionsForGeneration`) by appending brief content to the `description` field — do not change field schemas.

---

## Phase 2–3: Merge & Post-process

1. Merge window results — reuse `mergeChunkResults` dedup (>50% overlap)
2. **Coverage check** (`coverage.ts`) — fail if:
   - >70% of kept segment midpoints fall in latter 50% of video
   - No segment midpoint in first quartile `[0, duration/4]`
   - Compact on >45 min source with <3 segments
3. On coverage fail: retry once with halved window size; then throw
4. Keep filter: `microseries_keep` / `recap_keep` (existing logic)
5. Compact: `selectSegmentsForTarget` if over target
6. Recap: if kept count ∉ [4,6], use recap scoring in `selectSegmentsForTarget` to trim/pad
7. Map via `rowsToProposedSegments`

Optional: call `enforceConstraints()` from `verify.ts` as final safety net.

---

## Infrastructure

Add to `generateSegments` Lambda in `infrastructure/compute.tf`:

| Env var | Purpose | Default |
|---------|---------|---------|
| `JOCKEY_COMPACT_RECAP_ENABLED` | Feature flag | **`true` on deploy** (rollback: `false`) |
| `JOCKEY_TWELVE_LABS_SECRET_ARN` | Beta key if needed | Falls back to `SECRET_ARN` |

`GEMINI_SECRET_ARN` already present. Lambda timeout is 900s — parallel windows (max ~8) must fit within `maxAsyncWaitMs` (`getRemainingTimeInMillis() - 60_000`). Cap concurrent Pegasus tasks at 4 if rate-limited.

---

## Handler Fix (required)

In `generateSegments.ts`, when Jockey is enabled, **do not** swallow errors into heuristic fallback:

```typescript
} catch (err) {
  if (process.env.JOCKEY_COMPACT_RECAP_ENABLED === "true") {
    throw err;
  }
  // existing fallback for Pegasus path
}
```

---

## Milestones

### M1 — Compact POC (~16h)

- [ ] `jockey/types.ts`, `prompts.ts`, `preprocess.ts`
- [ ] `jockey-pipeline.ts` (compact only)
- [ ] Routing + feature flag in `storyiq/index.ts`
- [ ] `coverage.ts` validator
- [ ] `npm run jockey:eval -- compact --from-asset <uuid>` script
- [ ] Pass: Louis Theroux Philadelphia (~55 min) — segments across full timeline

### M2 — Episode Recap (~12h)

- [ ] Recap preprocess prompt + `recapBeats` handling
- [ ] Beat count enforcement (4–6, ~60–90s)
- [ ] Validate vs Scream 7 / Murdoch reference outputs

### M3 — Long-form reliability (~8h, can overlap M2 QA)

- [ ] Virtual windowing for 55–85 min
- [ ] Chunked asset support (physical chunk + sub-windows)
- [ ] Coverage retry logic
- [ ] Pass: 85-min asset completes without fallback

### M4 — Deploy & rollback (~4h)

- [ ] Set `JOCKEY_COMPACT_RECAP_ENABLED=true` in `compute.tf`
- [ ] Claude preprocess + 50% default + title pass shipped
- [ ] Run eval suite on Philadelphia + Murdoch
- [ ] **No staging soak** — monitor production; rollback via flag if needed
- [ ] Regression: sports/highlights/full_video unchanged with flag on

---

## Acceptance Criteria

| Criterion | How to verify |
|-----------|---------------|
| 55-min doc, full timeline | `coverage.ts` quartile check on Louis Theroux asset |
| Producer prompt parity | Named themes appear in segment titles/reasoning |
| Recap 4–6 beats, 60–90s | Beat count + total duration after keep filter |
| 55–85 min no silent failure | Job `failed` on error, not heuristic fallback |
| Feature flag rollback | Flag off → identical to current Pegasus behavior |

---

## Eval Assets

- Louis Theroux Philadelphia doc (~55 min) — compact
- Episode recap test content
- Scream 7 / Murdoch — prompt parity references
- 85-min asset — timeout/windowing

---

## Testing

Add `assertAcceptanceCriteria(segments, durationSec, purpose)` in `coverage.ts`.

**Regression with flag off:** sports highlights, full_video, existing compact behavior unchanged.

**Regression with flag on:** only compact + recap use Jockey; everything else unchanged.

---

## Open Questions

1. Scott's exact Gemini/Jockey prompt text — needed for `prompts.ts`
2. Org `12labs-key` vs `coleman-jockey-12labs-key` — test both; use Jockey key only if org lacks beta features
3. Hosted Jockey API vs local orchestration — spec assumes local TypeScript orchestration unless a stable hosted endpoint is confirmed

---

## File Change Checklist

| File | Action |
|------|--------|
| `storyiq/jockey/*` | Create |
| `storyiq/jockey-pipeline.ts` | Create |
| `storyiq/index.ts` | Add routing |
| `handlers/generateSegments.ts` | Fail loudly when Jockey enabled; optional Jockey API key |
| `infrastructure/compute.tf` | Env vars |
| `pegasus-segmentation.ts` | Add `buildJockeySegmentDefinitions(brief, ...)` helper |
| `backend/package.json` | `jockey:eval` script |

**No changes:** `zeevee/*`, `sports-highlights-pipeline.ts`, `generateExportMetadata.ts`
