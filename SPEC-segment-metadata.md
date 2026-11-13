# SPEC — Segment metadata at generation time

> **Status (Nov 2026):** Implemented in `backend/src/services/iq-agent/metadata.ts`.

Status: **Draft**
Scope: IQ Agent path (primary); all other generation paths unchanged as fallback

---

## 1. Problem

Metadata today is a separate, context-blind step. The cutting agent finishes with rich context — transcript reads, search results, watched clips, editorial reasoning — and then Export runs Pegasus cold on each segment as if none of that happened.

The result is metadata that doesn't match our delivery quality bar: wrong IAB categories (format labels instead of content topics), prose tags instead of structured tokens, longer descriptions than we want, and a user-visible wait in Export that shouldn't be necessary for agent-cut projects.

---

## 2. Goals

### G1 — Metadata at `finish_turn` (IQ Agent path)

When an IQ Agent run completes successfully, segment metadata must already be written. The agent produces it as part of `finish_turn`, using the full context of that run — not a later re-analysis pass.

Segment titles remain the editor narrative titles the agent set during cutting. We are not adding a separate delivery title field.

### G2 — Real IAB references

IAB tags must use **actual IAB Content Taxonomy 3.0 category IDs** from a curated allowlist — content-aboutness categories (e.g. Food & Drink, Travel, History), not form-factor labels (Clip, Documentary, Lifestyle).

The agent must pick from the provided reference list; free-form IAB strings are not acceptable output.

### G3 — Fallback for non-agent paths

Jockey, legacy StoryIQ, and any project without agent-generated metadata continue to use the existing export-metadata pipeline (Pegasus + Export panel). No regression for those paths.

If an IQ Agent project is missing or has stale metadata (e.g. user edited segment bounds after the run), the fallback path must still be able to fill gaps.

### G4 — Seamless, durable export

Export must work reliably regardless of timing or client state:

- User cannot initiate export while the agent run is still in progress.
- If the browser closes, refreshes, or crashes mid-run, reopening the project resumes cleanly — segments and metadata appear when the run finishes, with no duplicate work or lost state.
- When the user opens Export after a completed run, metadata is already there. No visible "generate metadata" step for agent-cut projects unless metadata is stale or incomplete.
- Stale metadata (segment bounds changed) should be detectable and recoverable through the existing fallback, without requiring a full re-cut.

### G5 — Metadata quality (content bar)

Use the Bourdain reference metadata as a **quality bar for field content**, not a schema to copy. We do not need to match its scene count, durations, or structure exactly. Geolocation is out of scope.

Target quality per segment:

| Field | Goal |
|-------|------|
| Short description | ≤10 words, scene-focused summary |
| Mood / theme / tone | 2–3 short tokens each, not prose sentences |
| Content advisory | Token list when applicable; empty when nothing applies |
| IAB | 2–3 content-aboutness categories from the real taxonomy |
| Thumbnail | Present for every segment at export time |

Editor segment `title` and `description` from the cut are unchanged.

---

## 3. Path summary

| Generation path | Metadata source | Export behavior |
|-----------------|-----------------|-----------------|
| IQ Agent | `finish_turn` (primary) | Ready when run completes; fallback if stale/missing |
| Jockey / legacy / manual | Export-metadata Lambda (unchanged) | Existing auto-generate on Export panel |

---

## 4. Out of scope

- Geolocation / Google Maps links
- Matching reference scene granularity or durations
- A separate delivery/catalogue title field
- Changing how segments are cut

---

## 5. Success criteria

1. Complete an IQ Agent run → every segment has metadata and thumbnails without opening Export or waiting on Pegasus.
2. IAB output uses content categories from IAB Content Taxonomy 3.0, not form-factor labels.
3. A Jockey or legacy project still generates metadata through Export exactly as today.
4. Export is blocked or clearly unavailable while the agent is running.
5. Close the browser mid-run, reopen → run completes, metadata is present, Export works immediately.
6. Edit a segment's bounds after an agent run → stale metadata is detected; fallback fills it without re-cutting.

---

## 6. Open questions

1. When metadata is stale after a manual segment edit, should fallback run automatically on Export open or require explicit user action?
2. Should the fallback export-metadata path also adopt the improved IAB allowlist and tag format (G5), or only the agent path for now?
