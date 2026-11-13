# Jockey v3 — Self-Directed Cutting (No Preprocess)

> **Status (Nov 2026):** Implemented as `jockey-v3-pipeline.ts`, but no UI reaches it. Superseded by the IQ Agent.

**Status:** Draft — direction for the next implementation round
**Companion docs:** `SPEC-jockey-v2-loop.md`, `SPEC-jockey-product-ux.md`, `SPEC-jockey-compact-recap.md`, `backend/EVAL-SUITE.md`
**Supersedes:** `SPEC-jockey-v2-loop.md` §14 (scene-boundary snapping from `scene-cache`) and the Claude-brief + windowed-Pegasus + enforcer post-processing chain for Jockey runs.

---

## 1. Why this round

The overnight July 2 run (`SPEC-jockey-v2-loop.md` §13) confirmed two things:

1. **Coverage is solved.** Jockey no longer clusters segments in the back half.
2. **Cut craft is not.** Shipped cuts land on arbitrary points — 180s enforcer splits and 10-min window edges — that **spill into the next scene** instead of ending where a scene ends. Recap "passed" only via the Claude-brief fallback.

The root cause is our architecture, not Jockey. We wrap Jockey/Pegasus in layers of **preprocessing** (a separate narrative brief) and **postprocessing** (`zeevee-detect-scenes` scene data, enforcer splits, quartile backfill, recap re-fit). Each layer re-cuts content that the model already understood, and none of them cut on real scene boundaries.

Scott's direct Agents-API experiments (Slack, June) show the opposite: given only the asset and a good instruction, Jockey **explores the content, finds natural scene boundaries, and returns clean, dialog-forward cuts** (e.g. `147.04→272.04`, `265→302`) — plus metadata and thumbnails — in one agentic pass.

**Decision for this round:** stop preprocessing and stop re-cutting. Let Jockey do the whole job.

---

## 2. North star

> **Give Jockey the asset and the producer's intent. Jockey explores the video, decides where the scenes are, and returns the final cuts. We ship what it returns.**

- **No `zeevee-detect-scenes`** in the Jockey path. We do not compute, cache, read, or snap to external scene data. Jockey finds scene boundaries itself.
- **No preprocessing brief step.** No separate Gemini/Claude "narrative brief" pass feeding Pegasus. The producer instruction is the only guidance, passed straight to Jockey.
- **No deterministic re-cutting.** No enforcer split/drop, no quartile backfill, no recap window narrowing. Cut points come from Jockey and are shipped as-is.
- **Jockey owns exploration → scene detection → cut selection → final segments** as a single responsibility.

A producer should be able to say *"tighten this 55-min doc to ~25 min, follow the narrative arc, favor scenes with dialog"* and get back segments whose edges land on scene changes, in one flow.

---

## 3. What changes

| Layer | v1 / v2 (today) | v3 (this round) |
|-------|-----------------|-----------------|
| Scene data | `zeevee-detect-scenes` → S3 `scene-cache`; v2 wanted to snap to it | **Removed from Jockey path.** Jockey infers scene boundaries |
| Preprocess | Claude Sonnet narrative brief → Pegasus enrichment | **Removed.** Producer instruction goes straight to Jockey |
| Segmentation | Windowed Pegasus `time_based_metadata` | Jockey self-directed exploration + cut selection |
| Boundaries | Raw Pegasus rows / enforcer 180s splits / brief timestamps | **Scene boundaries Jockey identifies itself** |
| Post-process | enforcer split/drop, quartile backfill, recap re-fit, title pass | **Removed** (safety clamps only — see §5) |
| Output | `ProposedSegment[]` | `ProposedSegment[]` — **unchanged** |

**Out of scope for this doc / unchanged:** the frontend IQ Editor, the export-metadata pipeline, sports/highlights/full_video paths, Remotion render. `zeevee-detect-scenes` may still serve non-Jockey features; this doc only removes it from the Jockey generation path.

---

## 4. Principles

1. **One brain.** Jockey is the single decision-maker for what to keep and where to cut. We don't second-guess its boundaries in code.
2. **Instruction in, cuts out.** The only guidance is the producer's instruction plus the format (compact / recap) and target runtime. No intermediate artifacts we then have to reconcile.
3. **Cuts land on scenes.** A segment ends because a scene ends — not because a timer hit 180s or a window edge arrived.
4. **Validate, don't repair.** Code may check the result and, on failure, **ask Jockey again** with feedback. Code may not reshape timestamps to force a pass.
5. **Fail loud.** After bounded retries, the job fails with an actionable error. No heuristic/legacy fallback while the v3 flag is on.
6. **Same output contract.** Editor and export must not notice a difference in shape.

### Allowed deterministic operations (safety only)

| Allowed | Forbidden |
|---------|-----------|
| Clamp times to `[0, videoDuration]` | Split a segment because it's "too long" |
| Reject/return-for-revision on overlap or out-of-band totals | Auto-split overlaps or trim to a target |
| De-duplicate identical returned rows | Backfill empty quartiles from a candidate pool |
| Re-ask Jockey with structured feedback | Snap/move cuts to externally-detected scene data |
| Map Jockey output → `ProposedSegment[]` | Generate a separate preprocessing brief |

---

## 5. Target flow (behavioral, not prescriptive)

```
Producer instruction + format + target runtime + asset
  → Jockey explores the asset (its own scene understanding)
  → Jockey returns candidate final cuts (start/end on scene boundaries)
  → Validate (deterministic gates only)
      pass  → clamp/dedupe → map to ProposedSegment[] → ship
      fail  → re-ask Jockey with the specific issues (bounded retries)
  → exhausted → job fails with actionable error
```

- **Exploration and scene-finding happen inside Jockey**, however the Agents API best supports it (single instruction, knowledge-store reasoning, etc.). This doc intentionally does not prescribe the call shape — that's an implementation choice validated by eval (§7).
- **Long sources:** if the API can't take the full asset in one pass, any chunking/windowing is an *internal* concern of the Jockey step and must still return boundaries on real scene changes — not on the window seams. Window seams appearing as cuts is a **failure**, routed back to Jockey.
- **Metadata/thumbnails (optional, stretch):** Jockey can emit per-scene name / ≤10-word description / mood-theme-tone / IAB and thumbnails in the same pass (Scott's "Qlio Standard Metadata Prompt"). If included, it must not change `startTime`/`endTime`. Keep behind its own toggle; not required to ship v3.

---

## 6. Acceptance criteria

### Compact (`compact_video`)

| Criterion | Measurement |
|-----------|-------------|
| **Clean cut points** | 100% of segment edges sit on a scene change Jockey identified — no mid-scene, mid-gesture, or mid-word cuts (visual QA + edge check) |
| **No window-seam cuts** | No cut coincides with an internal chunk/window boundary |
| **Timeline spread** | ≥1 segment in each quartile on sources > 45 min |
| **Target runtime** | Total ∈ **[45%, 55%]** of source (default center 50%), achieved by Jockey selection — **not** by code trimming |
| **Coherence** | Each segment is watchable in isolation (critique/QA binary per segment) |
| **Dialog-forward** | When instructed, kept segments favor dialog that advances story |
| **Producer intent** | Named themes/scenes in the instruction appear in the output |
| **Clean titles** | Human-readable titles; no `(Part N)` / dedup `(N)` artifacts |

### Ep Recap (`episode_recap`)

| Criterion | Measurement |
|-----------|-------------|
| **Beat count** | 4–6 segments |
| **Total duration** | 60–90s |
| **Clean cut points** | Each beat opens and closes on a scene boundary — never mid-line |
| **Narrative flow** | Ordered beats read as a connected setup→payoff mini-story |
| **Self-sourced** | Beats come from Jockey's own exploration — **not** a brief-timestamp fallback |

### Universal

- **Zero preprocessing steps** in the Jockey path (no `detect-scenes`, no separate brief).
- **Zero deterministic re-cutting** for duration/coverage/beat targeting.
- **Bounded retries:** ≤ 3 Jockey passes, then `failed` with the collected issues.
- **Output contract unchanged:** `ProposedSegment[]` maps to the editor/export exactly as today.
- **Rollback:** flag off → prior pipeline behavior, unchanged.

---

## 7. How to test

### 7.1 Eval suite (primary gate)

Add a `jockey-v3-self-directed` approach to `backend/src/scripts/jockey-eval-suite/` and run the standard reference assets:

| Asset | Purpose | Must show |
|-------|---------|-----------|
| Law & Disorder in Philadelphia (~59 min) | Compact | Full-timeline spread, ~50%, cuts on scene changes |
| Murdoch Mysteries 101 (~48 min) | Recap | 4–6 beats, 60–90s, beats self-sourced (no fallback) |
| Production Sopranos episode (~57 min) | Compact | The asset that exposed v1 debt — no split artifacts |
| An ≥ 80-min asset | Compact | Internal chunking invisible in the cuts (no seam cuts) |

Automated checks to add to `EVAL-SUITE.md`:

| Check | Pass condition |
|-------|----------------|
| `no_preprocess` | Run trace shows no `detect-scenes` call and no separate brief step |
| `cuts_on_scene_boundaries` | Every edge aligns to a scene change reported by Jockey (within a small tolerance) |
| `no_window_seam_cuts` | No cut within ε of an internal chunk/window boundary |
| `duration_band` | Compact 45–55%; recap 60–90s — met by selection, not trimming |
| `timeline_coverage` | Quartile spread on long sources |
| `recap_self_sourced` | Recap beats not from a timestamp fallback |
| `no_cut_artifacts` | No `(Part N)` / `(N)` titles; no zero/negative-length or overlapping segments |
| `retry_efficiency` | ≤ 3 Jockey passes median across assets |

### 7.2 Head-to-head

Compare `jockey-v3-self-directed` against the current production path (`jockey-gemini-full`) and the raw Agents approaches (`agents-segments-direct`, `agents-brief-pegasus`) on the same assets. v3 must **win on cut quality** (edge placement, watchability) at acceptable **latency and cost**. Record the comparison in the eval report.

### 7.3 Visual QA (human)

For each reference asset, scrub each cut in the editor and confirm the edit lands on a scene change, not mid-shot. This is the ground-truth check the numeric edge-check approximates. A short producer review (Scott) on the Philadelphia doc is the bar: *"would you ship these cuts?"*

### 7.4 Regression

- Sports / highlights / full_video / framing unchanged with the v3 flag **on**.
- Flag **off** → identical to the current pipeline (including any remaining `detect-scenes` use outside Jockey).
- Editor and export consume v3 output with no changes.

---

## 8. Observability

Per job, log enough to debug a bad edit without re-running:

- Which Jockey pass produced the shipped cuts, and how many retries.
- Validation issues per pass and the feedback sent back.
- Final segment count, total duration, quartile spread.
- Latency and (if available) token/cost of the Jockey call(s).
- Explicit assertion in logs that **no** `detect-scenes` / brief preprocessing ran.

Store a compact summary on the `generationJob` (P2) so producers can see why a job failed after 3 passes.

---

## 9. Rollout & rollback

- New flag (e.g. `JOCKEY_V3_SELF_DIRECTED_ENABLED`), default **off**, layered above the existing `JOCKEY_COMPACT_RECAP_ENABLED`.
- Ship to eval first; flip on in production only after §7 passes on all reference assets and a producer visual-QA sign-off.
- Rollback is the flag → immediately reverts to the current path. No data migration.
- Because `detect-scenes` is only *bypassed* (not deleted) for Jockey runs, rollback restores prior behavior with no infra change.

---

## 10. Milestones

### M1 — Wire the self-directed path (behind flag)
- [ ] Jockey call that takes only instruction + format + target + asset and returns candidate cuts.
- [ ] Remove `detect-scenes` and the brief preprocess from this path.
- [ ] Map output → `ProposedSegment[]`; safety clamps only.

### M2 — Validate + re-ask loop
- [ ] Deterministic gates (§6) with typed issues.
- [ ] Bounded re-ask with structured feedback; fail loud after 3.

### M3 — Eval + tuning
- [ ] `jockey-v3-self-directed` eval approach + new `EVAL-SUITE.md` checks.
- [ ] Pass all reference assets; head-to-head vs. current path; producer visual QA.

### M4 — (Optional) inline metadata/thumbnails
- [ ] Jockey emits Qlio Standard Metadata + thumbnails in the same pass, behind its own toggle, without moving cut times.

### M5 — Ship
- [ ] Flag on in production; monitor; deprecate the v1/v2 post-processing for Jockey.

---

## 11. Open questions

1. **API shape for long sources** — can the Agents API reason over a full ~80-min asset in one pass, or is internal chunking required? If chunked, how do we guarantee no seam cuts?
2. **Determinism** — how stable are Jockey's cuts run-to-run at a given temperature? Do we pin settings for reproducible eval?
3. **Latency/cost** — is a self-directed multi-step pass within the 900s Lambda budget and acceptable cost vs. the current path?
4. **Beta stability** — the Agents API is private beta; what's our exposure if the surface changes? (Flag + rollback mitigates.)
5. **Metadata ownership** — if Jockey emits metadata inline (M4), do we retire the separate export-metadata pass or keep both?
6. **Content-kind routing** — JT's "Documentary / Procedural / Comedy changes the prompt" idea: does the single instruction absorb this, or do we template per content-kind? (Also flagged in v2-loop §16.)

---

## 12. Decision log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Scene data for Jockey | **Remove `detect-scenes`** | Jockey finds better boundaries itself; external snap was a workaround |
| Preprocessing brief | **Remove** | "Nothing preprocessed" — instruction goes straight to Jockey |
| Cut boundaries | **Jockey-identified scene changes** | Fixes the mid-scene spill; matches Scott's manual results |
| Duration/coverage/beats | **Jockey selection, re-ask on failure** | No deterministic re-cutting |
| Output contract | **Unchanged `ProposedSegment[]`** | Editor/export stability |
| Rollout | **New flag, off by default, eval + visual QA first** | Beta API; instant rollback |
