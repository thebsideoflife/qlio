# Statement of Work — Qlio Platform: Jockey Migration for Compact & Recap

**Prepared for:** Qlio  
**Date:** June 27, 2026  
**Estimated Effort:** 40 hours  
**Engagement Type:** Fixed-scope sprint

---

## 1. Overview

This statement of work covers migrating **Compact Video** and **Episode Recap** segment generation from direct TwelveLabs Pegasus segmentation to a **Jockey-orchestrated pipeline**. Recent testing shows Pegasus works in the 12Labs Playground but underperforms in Qlio on long-form content (e.g., compact pulling only from the second half of a video; 55-min docs not compacting reliably). Scott's Jockey experiments demonstrate better results when narrative context is pre-processed and passed to TwelveLabs as structured guidance. This sprint replaces the compact/recap generation path while keeping the existing editor, export, and sports-highlights pipelines unchanged.

---

## 2. Deliverables

### 2.1 Jockey Pipeline for Compact & Recap

- Replace direct Pegasus segmentation (`pegasus-pipeline.ts`) with a Jockey agent flow for `compact_video` and `episode_recap` purposes only.
- Pre-processing step: extract story beats from transcript + user prompt before TwelveLabs analysis (per Scott's Gemini pre-process workflow).
- Map Jockey output to existing Qlio segment model (start/end times, titles, metadata) so the editor and export flows require no redesign.

### 2.2 Prompt & Metadata Parity

- Port Scott's validated prompt patterns: named narrative arcs, dialog-forward scene selection, target runtime guidance.
- Align export metadata with Qlio Standard Metadata schema (scene numbering, ≤10-word descriptions, mood/theme/tone/content_advisory/IAB taxonomy 3.0).
- Preserve existing recap prompt behavior (4–6 connected "Previously on…" beats, ~75s default).

### 2.3 Long-Form Reliability

- Fix full-timeline segment coverage (address compact second-half bias).
- Support 55–85 min assets without silent failure (job splitting or extended async polling as needed).
- Feature flag to roll back to Pegasus if Jockey is unavailable.

---

## 3. Out of Scope

- Sports highlights / instant replays pipeline (stays on Pegasus)
- Full video, trailer, and season recap modes
- Export metadata generation (`generate-export-metadata` Lambda)
- Thumbnail image generation (separate workstream)
- Frontend editor UX changes beyond what existing metadata fields require
- Infrastructure migration from AWS or TwelveLabs org account changes

---

## 4. Assumptions

- Access to the existing codebase, deployment pipeline, and AWS services continues as-is.
- Jockey API access via the existing `coleman-jockey-12labs-key` secret (or org key when available).
- Testing against team evaluation assets: Louis Theroux Philadelphia doc (~55 min), episode recap test content, and Scott's Scream 7 / Murdoch reference outputs.
- TwelveLabs video indexing and transcript pipeline remain in place — only the compact/recap *generation* layer changes.

---

## 5. Timeline

| Milestone | Deliverables |
|-----------|--------------|
| Milestone 1 | Jockey pipeline POC — compact generation end-to-end on evaluation asset |
| Milestone 2 | Episode recap via Jockey + prompt/metadata schema parity |
| Milestone 3 | Long-form reliability (full-timeline coverage, timeout fixes) |
| Milestone 4 | QA, feature flag deploy, Pegasus rollback path |

Milestones 1 and 2 are sequential. Milestone 3 can overlap with Milestone 2 QA.

---

## 6. Acceptance Criteria

- 55-min Louis Theroux doc compacts with segments distributed across the **full timeline**, not just the second half.
- Producer prompt with named themes/scenes is reflected in output (Playground ↔ Qlio parity).
- Episode recap produces 4–6 connected beats (~60–90s) with narrative flow.
- Export JSON includes mood, theme, tone, content_advisory, and IAB taxonomy fields per Qlio Standard Metadata schema.
- Compact and recap generation complete on 55–85 min assets without silent failure.
- Feature flag allows rollback to Pegasus within one deploy.

---

## Signatures

**Total Hours:** 40  
**Rate:** $100/hr  
**Total Agreement:** $4,000

| | |
|---|---|
| **Client Signature:** ______________________ | **Date:** __________ |
| Scott Maddux, Founder & CEO | |
| | |
| **Vendor Signature:** ______________________ | **Date:** __________ |
| Coleman Isner | |
