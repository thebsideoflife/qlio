/**
 * AEO staleness and export-JSON picking. Staleness cases mirror
 * backend/src/scripts/test-aeo-metadata.ts (computeMissingAeoOptions).
 */
import assert from "node:assert/strict";
import { isAeoStale, isSegmentMetadataStale, computeSegmentMetadataFingerprint } from "../lib/segmentMetadataFingerprint";
import { buildExportMetadataDocument, pickAeo } from "../lib/exportMetadataJson";

const hash = "7d3421c4";
const opts = { characters: true, searchTitle: true, platforms: ["youtube" as const], showInfoHash: hash };

assert.equal(isAeoStale(undefined, opts), true, "no cache");
assert.equal(isAeoStale({ showInfoHash: "other", entities: { characters: [] }, search: { title: "" }, platforms: { youtube: {} } }, opts), true, "show info changed");
assert.equal(isAeoStale({ showInfoHash: hash, entities: { characters: [] }, platforms: { youtube: {} } }, opts), true, "search title missing");
assert.equal(isAeoStale({ showInfoHash: hash, entities: { characters: [] }, search: { title: "" }, platforms: { youtube: {} } }, opts), false, "empty values count as done");
assert.equal(isAeoStale(undefined, { showInfoHash: hash }), false, "nothing wanted");
assert.equal(isAeoStale(undefined, undefined), false, "AEO off");

const contentHash = computeSegmentMetadataFingerprint(10, 70);
const cached = {
  segmentId: "s1",
  contentHash,
  descriptions: { short: "Short" },
  thumbnailUrl: "https://x/t.jpg",
  thumbnailVersion: 2,
  tags: { iab: { cattax: 7 as const, cat: ["1028", "325"] } },
  aeo: {
    showInfoHash: hash,
    entities: { characters: ["Leonard McCoy"], cast: [], locations: ["USS Enterprise bridge"] },
    search: { title: "McCoy's Overdose | Star Trek", fanAliases: ["McCoy goes crazy"] },
    keyQuotes: ["I'll kill you first!"],
    contentRating: "TV-PG",
    platforms: { youtube: { title: "Y" }, tiktok: {} },
  },
};
assert.equal(
  isSegmentMetadataStale(cached, 10, 70, {
    includeDescriptions: true,
    descriptionLengths: ["short"],
    includeIab: true,
    iabFields: { formFactor: true, genres: true, topics: true },
  }),
  true,
  "IAB topics wanted but missing",
);
assert.equal(
  isSegmentMetadataStale(cached, 10, 70, {
    includeDescriptions: true,
    descriptionLengths: ["short"],
    aeo: { characters: true, keyQuotes: true, platforms: ["youtube", "tiktok"], showInfoHash: hash },
  }),
  false,
  "everything requested is cached",
);

const picked = pickAeo(cached, {
  aeo: { characters: true, cast: true, searchTitle: true, keyQuotes: false, platforms: ["youtube", "tiktok"], showInfoHash: hash },
});
assert.deepEqual(picked, {
  entities: { characters: ["Leonard McCoy"] },
  search: { title: "McCoy's Overdose | Star Trek" },
  platforms: { youtube: { title: "Y" } },
});
assert.equal(pickAeo(cached, {}), undefined, "AEO off: nothing exported");

const doc = buildExportMetadataDocument({
  projectId: "p",
  projectTitle: "P",
  segments: [{ id: "s1", startTime: 10, endTime: 70, title: "1. Scene" }],
  selectedSegmentIds: new Set(["s1"]),
  metadataBySegmentId: new Map([["s1", cached]]),
  options: { aeo: { contentRating: true, showInfoHash: hash } },
  showInfo: { series: "Star Trek", season: "1", episode: "28" },
});
assert.deepEqual(doc.show, { series: "Star Trek", season: "1", episode: "28", episodeLabel: "S1 E28" });
assert.deepEqual(doc.scenes[0].aeo, { contentRating: "TV-PG" });
assert.equal(
  buildExportMetadataDocument({
    projectId: "p",
    projectTitle: "P",
    segments: [],
    selectedSegmentIds: new Set(),
    metadataBySegmentId: new Map(),
    options: {},
    showInfo: {},
  }).show,
  undefined,
  "empty show info is left out",
);
console.log("aeo-metadata: 13 checks passed");
