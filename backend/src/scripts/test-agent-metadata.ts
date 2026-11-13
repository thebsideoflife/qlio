/**
 * Contract tests for agent-written delivery metadata.
 *
 * The two things that go quietly wrong here are worth pinning down:
 *
 * 1. **Staleness drift.** The agent and the Pegasus fallback both write to the
 *    same `segmentMetadata` list and both decide "is this entry good enough" by
 *    the same function with different options. If the agent's bar and the
 *    Export panel's bar disagree, one of them regenerates forever.
 * 2. **Taxonomy drift.** IAB IDs the frontend does not recognise are silently
 *    dropped from the export JSON, so the backend allowlist growing without the
 *    frontend mirror looks like the agent just did not assign topics.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  computeSegmentMetadataFingerprint,
  isSegmentMetadataIncomplete,
  mergeSegmentMetadataEntry,
  type ExportMetadataOptions,
} from "../services/export-metadata";
import {
  IAB_CONTENT_TOPICS,
  IAB_TOPIC_IDS,
  iabAllowlistPromptBlock,
  iabHasFormFactor,
  iabHasGenre,
  iabHasTopic,
  normalizeIabTags,
} from "../services/iab-content-taxonomy";
import { AGENT_METADATA_OPTIONS } from "../services/iq-agent/metadata";

let failures = 0;

function check(condition: boolean, message: string): void {
  if (condition) return;
  console.error(`FAIL: ${message}`);
  failures++;
}

// What the Export panel asks for on the non-agent path. Notably no topics.
const PEGASUS_OPTIONS: ExportMetadataOptions & { includeThumbnails?: boolean } = {
  includeDescriptions: true,
  descriptionLengths: ["short", "two_sentences", "paragraph"],
  descriptiveTags: { contentAdvisory: true, mood: true, theme: true, tone: true },
  includeIab: true,
  iabFields: { formFactor: true, genres: true },
  includeThumbnails: true,
};

const BOUNDS = { startTime: 12.5, endTime: 45 };
const HASH = computeSegmentMetadataFingerprint(BOUNDS.startTime, BOUNDS.endTime);

function entry(overrides: Record<string, unknown> = {}) {
  return {
    segmentId: "seg-1",
    contentHash: HASH,
    descriptions: {
      short: "Anthony shares grilled lamb with a farming family",
      two_sentences:
        "Anthony eats with the family who raised the lamb. It is the first time the episode slows down.",
      paragraph:
        "Anthony sits down to a long lunch with the family. The conversation turns to what the farm costs them. He listens more than he talks. The meal ends without a conclusion.",
    },
    tags: {
      content_advisory: "",
      mood: "warm, unhurried",
      theme: "food, family",
      tone: "wry, reflective",
      // Food & Drink (topic), Documentary (genre), Clip (form factor).
      iab: {
        cattax: 7 as const,
        cat: ["210", "332", "O3EQZQ"],
        labels: ["Food & Drink", "Documentary", "Clip"],
      },
    },
    thumbnailKey: "thumbnails/projects/p1/seg-1.jpg",
    generatedAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

check(
  IAB_CONTENT_TOPICS.length === IAB_TOPIC_IDS.size,
  `duplicate IAB topic id: ${IAB_CONTENT_TOPICS.length} entries but ${IAB_TOPIC_IDS.size} unique ids`,
);

check(
  !iabAllowlistPromptBlock({ formFactor: true, genres: true }).includes(
    "Topics —",
  ),
  "topics leaked into the prompt block when not requested (this would re-run the Pegasus back catalogue)",
);
check(
  iabAllowlistPromptBlock(AGENT_METADATA_OPTIONS.iabFields).includes("Topics —"),
  "the agent's prompt block is missing the topics list",
);

const normalized = normalizeIabTags(
  ["210", "332", "O3EQZQ", "not-a-real-id"],
  undefined,
  AGENT_METADATA_OPTIONS.iabFields,
);
check(
  normalized?.cat.length === 3 && !normalized.cat.includes("not-a-real-id"),
  `invented IAB ids should be dropped, got ${JSON.stringify(normalized?.cat)}`,
);
check(
  iabHasTopic(normalized) && iabHasGenre(normalized) && iabHasFormFactor(normalized),
  "a full agent answer should register a topic, a genre and a form factor",
);

const withoutTopics = normalizeIabTags(["210", "332", "O3EQZQ"], undefined, {
  formFactor: true,
  genres: true,
});
check(
  !iabHasTopic(withoutTopics),
  "topic ids must be filtered out when the caller did not ask for topics",
);

// ---------------------------------------------------------------------------
// Completeness, in both directions
// ---------------------------------------------------------------------------

const agentEntry = entry();

check(
  !isSegmentMetadataIncomplete(
    agentEntry,
    BOUNDS.startTime,
    BOUNDS.endTime,
    AGENT_METADATA_OPTIONS,
  ),
  "agent-written metadata should satisfy the agent's own bar",
);
check(
  !isSegmentMetadataIncomplete(
    agentEntry,
    BOUNDS.startTime,
    BOUNDS.endTime,
    PEGASUS_OPTIONS,
  ),
  "agent-written metadata should satisfy Export, or the panel regenerates it on open",
);

// A Pegasus row has no topics. Export must still consider it done, or every
// previously generated project re-runs through TwelveLabs on open.
const pegasusEntry = entry({
  tags: {
    ...agentEntry.tags,
    iab: {
      cattax: 7 as const,
      cat: ["332", "O3EQZQ"],
      labels: ["Documentary", "Clip"],
    },
  },
});
check(
  !isSegmentMetadataIncomplete(
    pegasusEntry,
    BOUNDS.startTime,
    BOUNDS.endTime,
    PEGASUS_OPTIONS,
  ),
  "existing Pegasus metadata must not be marked stale by the topics work",
);
check(
  isSegmentMetadataIncomplete(
    pegasusEntry,
    BOUNDS.startTime,
    BOUNDS.endTime,
    AGENT_METADATA_OPTIONS,
  ),
  "the agent should see topic-less metadata as something it can improve",
);

check(
  isSegmentMetadataIncomplete(agentEntry, 12.5, 46, AGENT_METADATA_OPTIONS),
  "moving a segment's bounds must invalidate its metadata",
);
check(
  isSegmentMetadataIncomplete(
    entry({ thumbnailKey: undefined }),
    BOUNDS.startTime,
    BOUNDS.endTime,
    AGENT_METADATA_OPTIONS,
  ),
  "a segment with no thumbnail is not finished",
);
check(
  !isSegmentMetadataIncomplete(
    entry({ tags: { ...agentEntry.tags, content_advisory: "" } }),
    BOUNDS.startTime,
    BOUNDS.endTime,
    AGENT_METADATA_OPTIONS,
  ),
  'an empty content advisory means "checked, nothing applies" and must not read as missing',
);

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

const merged = mergeSegmentMetadataEntry(pegasusEntry, agentEntry);
check(
  iabHasTopic(merged.tags?.iab) && iabHasGenre(merged.tags?.iab),
  "merging agent metadata over a Pegasus row should keep both the new topics and the old genres",
);

// ---------------------------------------------------------------------------
// Frontend mirror
// ---------------------------------------------------------------------------

const mirrorPath = join(
  __dirname,
  "../../../zeevee/src/lib/iabContentTaxonomy.ts",
);
let mirror: string | null = null;
try {
  mirror = readFileSync(mirrorPath, "utf8");
} catch {
  console.warn(`SKIP: frontend taxonomy mirror not readable at ${mirrorPath}`);
}

if (mirror) {
  const block = mirror.match(
    /IAB_TOPIC_IDS\s*=\s*new Set\(\[([\s\S]*?)\]\)/,
  )?.[1];
  check(!!block, "could not find IAB_TOPIC_IDS in the frontend taxonomy mirror");
  if (block) {
    const mirrored = new Set(
      Array.from(block.matchAll(/"([^"]+)"/g)).map((m) => m[1]),
    );
    const missing = [...IAB_TOPIC_IDS].filter((id) => !mirrored.has(id));
    const extra = [...mirrored].filter((id) => !IAB_TOPIC_IDS.has(id));
    check(
      missing.length === 0,
      `frontend is missing topic ids (they would be dropped from the export JSON): ${missing.join(", ")}`,
    );
    check(
      extra.length === 0,
      `frontend has topic ids the backend will never assign: ${extra.join(", ")}`,
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} agent metadata check(s) failed`);
  process.exit(1);
}
console.log("OK: agent delivery metadata contract");
