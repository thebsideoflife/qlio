/**
 * Unit tests for Jockey v3 self-directed gates (no API keys required).
 *
 * Covers the allowed deterministic operations (clamp, dedupe, validate, map)
 * and asserts the gates catch each failure class the re-ask loop feeds back
 * to Jockey (SPEC-jockey-v3-self-directed-cuts.md §4/§6).
 */
import { isStaleKnowledgeStoreError } from "../services/jockey-agents-api";
import {
  applySafetyClamps,
  mapToProposedSegments,
  validateSelfDirectedCuts,
  quartileCounts,
  SelfDirectedCutsSchema,
  type SelfDirectedCut,
  type SelfDirectedCuts,
} from "../services/storyiq/jockey/self-directed";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function cut(
  startTime: number,
  endTime: number,
  title = "Scene",
): SelfDirectedCut {
  return { startTime, endTime, title, description: "why it stays" };
}

const DURATION = 3540; // 59-min source (quartile checks active)
const TARGET = 1770; // 50%

/** Boundaries that admit a valid full-spread compact for the tests below. */
const boundaries = [
  10, 300, 700, 1000, 1400, 1800, 2200, 2600, 3000, 3400, 3530,
];

const validCompact: SelfDirectedCuts = {
  segments: [
    cut(10, 300, "Opening arrest"),
    cut(700, 1000, "Detectives clash"),
    cut(1400, 1800, "The case cracks open"),
    cut(2200, 2600, "Trial begins"),
    cut(3000, 3400, "Verdict lands"),
  ],
  sceneBoundaries: boundaries,
};

const compactOpts = {
  purpose: "compact_video" as const,
  videoDurationSec: DURATION,
  targetSeconds: TARGET,
};

// --- Valid compact passes all gates ---
{
  const issues = validateSelfDirectedCuts(validCompact, compactOpts);
  assert(
    issues.length === 0,
    `valid compact should pass, got: ${issues.map((i) => i.code).join(", ")}`,
  );
}

// --- Safety clamps: out-of-bounds times and duplicate rows ---
{
  const { segments, notes } = applySafetyClamps(
    [cut(-5, 100), cut(200, 300), cut(200, 300), cut(3500, 9999)],
    DURATION,
  );
  assert(segments.length === 3, "duplicate row should be dropped");
  assert(segments[0].startTime === 0, "negative start should clamp to 0");
  assert(
    segments[2].endTime === DURATION,
    "end past duration should clamp to duration",
  );
  assert(notes.length >= 3, "clamp/dedupe notes should be recorded");
}

// --- Gate: zero/negative-length rows ---
{
  const issues = validateSelfDirectedCuts(
    { ...validCompact, segments: [...validCompact.segments, cut(500, 500)] },
    compactOpts,
  );
  assert(
    issues.some((i) => i.code === "cut_artifact"),
    "zero-length segment should raise cut_artifact",
  );
}

// --- Gate: overlaps ---
{
  const issues = validateSelfDirectedCuts(
    {
      ...validCompact,
      segments: [
        cut(10, 300),
        cut(250, 700, "Overlapper"),
        cut(1400, 1800),
        cut(2200, 2600),
        cut(3000, 3400),
      ],
      sceneBoundaries: [...boundaries, 250],
    },
    compactOpts,
  );
  assert(
    issues.some((i) => i.code === "overlap"),
    "overlapping segments should raise overlap",
  );
}

// --- Gate: compact duration band (45–55% of source at default target) ---
{
  const issues = validateSelfDirectedCuts(
    {
      segments: [cut(10, 300), cut(1400, 1800), cut(2200, 2600), cut(3000, 3400)],
      sceneBoundaries: boundaries,
    },
    compactOpts,
  );
  assert(
    issues.some((i) => i.code === "duration_band"),
    "under-target compact should raise duration_band",
  );
}

// --- Gate: quartile coverage on long sources ---
{
  const issues = validateSelfDirectedCuts(
    {
      segments: [
        cut(1800, 2200),
        cut(2200, 2600),
        cut(2600, 3000),
        cut(3000, 3400),
        cut(1400, 1800),
      ],
      sceneBoundaries: boundaries,
    },
    compactOpts,
  );
  assert(
    issues.some((i) => i.code === "quartile_coverage"),
    "back-half clustering should raise quartile_coverage",
  );
}

// --- Gate: edges must land on Jockey-reported scene boundaries ---
{
  const offBoundary = {
    ...validCompact,
    segments: [
      cut(10, 300),
      cut(700, 1000),
      cut(1400, 1807, "Spills into next scene"), // 7s past the 1800 boundary
      cut(2200, 2600),
      cut(3000, 3400),
    ],
  };
  const issues = validateSelfDirectedCuts(offBoundary, compactOpts);
  assert(
    issues.some((i) => i.code === "edge_off_scene_boundary"),
    "edge off scene boundary should be rejected",
  );
}

// --- Gate: empty sceneBoundaries is a failure (cannot verify edges) ---
{
  const issues = validateSelfDirectedCuts(
    { ...validCompact, sceneBoundaries: [] },
    compactOpts,
  );
  assert(
    issues.some((i) => i.code === "missing_scene_boundaries"),
    "empty sceneBoundaries should be rejected",
  );
}

// --- Gate: no cuts on internal window seams ---
{
  const issues = validateSelfDirectedCuts(validCompact, {
    ...compactOpts,
    seamTimestampsSec: [1400], // a kept cut edge sits exactly on this seam
  });
  assert(
    issues.some((i) => i.code === "seam_cut"),
    "cut on an internal window seam should be rejected",
  );
}

// --- Gate: title artifacts ---
{
  const issues = validateSelfDirectedCuts(
    {
      ...validCompact,
      segments: validCompact.segments.map((s, i) =>
        i === 0 ? { ...s, title: "Opening arrest (Part 2)" } : s,
      ),
    },
    compactOpts,
  );
  assert(
    issues.some((i) => i.code === "title_artifact"),
    "(Part N) title should raise title_artifact",
  );
}

// --- Recap gates: beat count + 60–90s band ---
{
  const recapOpts = {
    purpose: "episode_recap" as const,
    videoDurationSec: DURATION,
    targetSeconds: 75,
  };
  const recapBoundaries = [100, 118, 900, 916, 1800, 1815, 2600, 2618, 3300, 3316];
  const validRecap: SelfDirectedCuts = {
    segments: [
      cut(100, 118, "Cold open twist"),
      cut(900, 916, "Suspect emerges"),
      cut(1800, 1815, "Alibi collapses"),
      cut(2600, 2618, "Confession"),
      cut(3300, 3316, "Cliffhanger"),
    ],
    sceneBoundaries: recapBoundaries,
  };
  let issues = validateSelfDirectedCuts(validRecap, recapOpts);
  assert(
    issues.length === 0,
    `valid recap should pass, got: ${issues.map((i) => i.code).join(", ")}`,
  );

  issues = validateSelfDirectedCuts(
    { segments: validRecap.segments.slice(0, 3), sceneBoundaries: recapBoundaries },
    recapOpts,
  );
  assert(
    issues.some((i) => i.code === "beat_count"),
    "3-beat recap should raise beat_count",
  );
  assert(
    issues.some((i) => i.code === "duration_band"),
    "short recap should raise duration_band",
  );
}

// --- Mapping preserves the ProposedSegment contract ---
{
  const mapped = mapToProposedSegments([
    { ...cut(10, 300, "Opening arrest"), narrativeRole: "setup" },
  ]);
  assert(mapped[0].startTime === 10 && mapped[0].endTime === 300, "times map 1:1");
  assert(mapped[0].title === "Opening arrest", "title maps");
  assert(mapped[0].reasoning === "why it stays", "description maps to reasoning");
  assert(mapped[0].section === "role-setup", "narrativeRole maps to section");
}

// --- Schema tolerates missing optional fields, rejects missing required ---
{
  const ok = SelfDirectedCutsSchema.safeParse({
    segments: [{ startTime: 0, endTime: 10, title: "A", description: "" }],
    sceneBoundaries: [0, 10],
  });
  assert(ok.success, "minimal valid response should parse");

  const bad = SelfDirectedCutsSchema.safeParse({ segments: [] });
  assert(!bad.success, "response without sceneBoundaries should fail parsing");
}

// --- Quartile counts helper ---
{
  const counts = quartileCounts(validCompact.segments, DURATION);
  assert(
    counts.every((c) => c >= 1),
    `full-spread compact should hit all quartiles, got ${counts.join("/")}`,
  );
}

// --- Stale knowledge-store error detection (private-beta purge recovery) ---
{
  assert(
    isStaleKnowledgeStoreError(
      new Error(
        `[Agents] POST /responses → 404: {"code":"resource_not_exists","message":"The requested knowledge_store with ID 'ks_abc' does not exist."}`,
      ),
    ),
    "404 resource_not_exists for knowledge_store should be stale",
  );
  assert(
    isStaleKnowledgeStoreError(
      new Error(`[Agents] GET /knowledge-stores/ks_abc → 404: {"code":"resource_not_exist"}`),
    ),
    "GET /knowledge-stores 404 must count as stale (existence probe)",
  );
  assert(
    !isStaleKnowledgeStoreError(new Error("[Agents] POST /responses → 500: boom")),
    "500 should not be treated as stale store",
  );
  assert(
    !isStaleKnowledgeStoreError(
      new Error(`[Agents] GET /knowledge-stores/ks_abc → 503: upstream unavailable`),
    ),
    "5xx on store probe must NOT look stale (avoids re-cache loops)",
  );
  assert(
    !isStaleKnowledgeStoreError(
      new Error(`[Agents] GET /assets/xyz → 404: {"code":"resource_not_exists"}`),
    ),
    "404 on an asset should not be treated as stale store",
  );
}

console.log("test-jockey-v3-gates: all assertions passed");
