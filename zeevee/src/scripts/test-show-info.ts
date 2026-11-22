/**
 * Show-info hash parity — keep in sync with
 * backend/src/scripts/test-aeo-metadata.ts. A mismatch makes the panel and
 * the server disagree on AEO staleness and requests loop.
 */
import assert from "node:assert/strict";
import { computeShowInfoHash, formatEpisodeLabel, normalizeShowInfo } from "../lib/showInfo";

const show = normalizeShowInfo({
  series: "  Star Trek (The Original Series) ",
  season: "1",
  episode: 28,
  episodeTitle: "The City on the Edge of Forever",
  year: "1967",
});
assert.equal(computeShowInfoHash({}), "459c0ba3");
assert.equal(computeShowInfoHash(null), "459c0ba3");
assert.equal(computeShowInfoHash(show), "7d3421c4");
assert.equal(computeShowInfoHash({ series: "Star Trek" }), "c45802ff");
assert.equal(formatEpisodeLabel(show), 'S1 E28 · "The City on the Edge of Forever" · 1967');
console.log("show-info: 5 parity checks passed");
