# Jockey Evaluation Suite

> **Status (Nov 2026):** Retired. The suite in `src/scripts/jockey-eval-suite/` no longer builds against current code and is not in the repo. `npm run jockey:eval` still works.

Local comparison of segment-generation approaches. **No deploy required.**

## Setup

```bash
cd backend
export AWS_PROFILE=zeevee
export TABLE_NAME=zeevee-assets
export BUCKET_NAME=zeevee-media-dev
export TWELVE_LABS_INDEX_ID=6934df867a1ec630b5fb65bd

# Pegasus (Models API) — required
export TWELVE_LABS_SECRET_ID=zeevee/12labs-key
export TWELVE_LABS_INDEX_ID=6934df867a1ec630b5fb65bd

# Agents API jockey1.0 — for agents-* approaches
export JOCKEY_TWELVE_LABS_SECRET_ID=zeevee/coleman-jockey-12labs-key

# Jockey preprocess uses Claude Sonnet 4.5 via SporeLabs
export SPORELABS_SECRET_ARN=$(aws secretsmanager describe-secret \
  --secret-id zeevee/sporelabs-api-key --query ARN --output text)
```

## Quick start tomorrow

```bash
# 1. Verify Agents API key works
npm run jockey:eval:suite -- smoke

# 2. List all approaches
npm run jockey:eval:suite -- list

# 3. Fast comparison (baseline + Gemini Jockey) on one asset
npm run jockey:eval:suite -- run \
  --from-asset <uuid> \
  --purpose compact

# 4. Agents approach (re-upload required — Jockey key cannot read org-indexed assets)
npm run jockey:eval:suite -- run \
  --from-asset <uuid> \
  --purpose compact \
  --approaches agents-brief-only \
  --agents-reupload
npm run jockey:eval:suite -- run \
  --from-asset <uuid> \
  --purpose compact \
  --all

# 5. Batch from manifest (edit eval-manifest.example.json first)
cp eval-manifest.example.json eval-manifest.json
npm run jockey:eval:suite -- run --manifest eval-manifest.json
```

## Approaches

| ID | What it tests |
|----|----------------|
| `pegasus-baseline` | Legacy production path (flag off) |
| `jockey-gemini-full` | **Production Jockey**: Claude (SporeLabs) brief + 10min windowed Pegasus. Id kept for eval-history compat — Gemini is no longer used. |
| `jockey-gemini-narrow-windows` | 7.5min windows (Claude brief) |
| `jockey-pegasus-windowed-no-brief` | Windowing only (no LLM brief) |
| `agents-brief-only` | jockey1.0 narrative brief diagnostic |
| `agents-brief-pegasus` | Official hybrid: Agents brief → Pegasus |
| `agents-segments-direct` | jockey1.0 returns segments (no Pegasus) |
| `jockey-v3-self-directed` | **v3 spec path**: Jockey explores + cuts itself; deterministic gates + ≤3-pass re-ask; no brief, no detect-scenes, no re-cutting |

## Output

Reports land in `backend/eval-results/<runId>/`:

- `summary.json` — full run metadata
- `report.md` — comparison table + acceptance notes
- `<approach>.json` — per-approach segments + timeline metrics

## Metrics

Each segment-producing approach reports:

- Quartile distribution of segment midpoints (Q1–Q4)
- Latter-half ratio (compact bias detector)
- Acceptance criteria from `coverage.ts`
- Wall-clock duration

## Jockey v3 automated checks (`jockey-v3-self-directed`)

Recorded in the approach's `artifacts.checks` and enforced by the pipeline's
deterministic gates (`services/storyiq/jockey/self-directed.ts`):

| Check | Pass condition |
|-------|----------------|
| `no_preprocess` | Run trace shows no `detect-scenes` call and no separate brief step (true by construction on the v3 path) |
| `cuts_on_scene_boundaries` | Every edge aligns to a scene change reported by Jockey (±2s tolerance) |
| `no_window_seam_cuts` | No cut within ε (1s) of an internal chunk/window boundary (validated in-pipeline via `seamTimestampsSec`) |
| `duration_band` | Compact 45–55% of source; recap 60–90s — met by Jockey selection, never by code trimming |
| `timeline_coverage` | ≥1 segment per quartile on compact sources > 45 min |
| `recap_self_sourced` | Recap beats come from Jockey's own pass — the v3 path has no brief-timestamp fallback |
| `no_cut_artifacts` | No `(Part N)` / `(N)` titles; no zero/negative-length or overlapping segments |
| `retry_efficiency` | ≤ 3 Jockey passes (`artifacts.checks.retry_passes`) |

v3 reference assets (SPEC §7.1): Law & Disorder in Philadelphia (compact),
Murdoch Mysteries 101 (recap), production Sopranos episode (compact), and one
≥80-min asset (compact, seam-cut check).

Head-to-head (SPEC §7.2): run `jockey-v3-self-directed` alongside
`jockey-gemini-full`, `agents-segments-direct`, and `agents-brief-pegasus` on
the same assets and record cut quality, latency, and pass counts in the report.

## Notes

- Agents approaches require `coleman-jockey-12labs-key` (org key lacks `/v1.3` Agents endpoints).
- Org-indexed `twelveLabsVideoId` values are **not readable** under the Jockey key — use `--agents-reupload` to upload via presigned S3 first (~minutes for indexing).
- First Agents run per asset creates a knowledge store and waits for indexing.
- Use `--approaches` to run a subset; skipped approaches need missing API keys.
