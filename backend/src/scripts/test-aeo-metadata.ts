/**
 * AEO metadata: parsing, validation, staleness and merge rules.
 * Show-info hash fixtures must match zeevee/src/scripts/test-show-info.ts.
 */
import assert from "node:assert/strict";
import {
  buildAeoPrompt,
  normalizeHashtags,
  normalizeRating,
  parseAeoResponse,
  validateChapters,
  verifyQuotes,
  type AeoGenerationInput,
} from "../services/aeo-metadata";
import {
  computeMissingAeoOptions,
  computeMissingMetadataOptions,
  computeSegmentMetadataFingerprint,
  mergeSegmentMetadataEntry,
  pegasusOptionsFor,
} from "../services/export-metadata";
import {
  computeShowInfoHash,
  formatEpisodeLabel,
  normalizeShowInfo,
} from "../services/show-info";
import type { StoredSegmentMetadata } from "../types/segment-metadata";

let checks = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    checks++;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    throw err;
  }
}

const transcript = [
  { startTime: 0, endTime: 4, text: "Bones, put down the hypo." },
  { startTime: 100, endTime: 104, text: "I'll kill you first! You're all murderers!" },
  { startTime: 104, endTime: 109, text: "Security to the bridge, now." },
  { startTime: 300, endTime: 305, text: "This line is from a different scene." },
];

const show = normalizeShowInfo({
  series: "  Star Trek (The Original Series) ",
  season: "1",
  episode: 28,
  episodeTitle: "The City on the Edge of Forever",
  year: "1967",
  junk: "ignored",
});

// --- show info ------------------------------------------------------------
check("show info normalizes and drops unknown keys", () => {
  assert.deepEqual(show, {
    series: "Star Trek (The Original Series)",
    season: "1",
    episode: "28",
    episodeTitle: "The City on the Edge of Forever",
    year: "1967",
  });
});
check("episode label", () => {
  assert.equal(
    formatEpisodeLabel(show),
    'S1 E28 · "The City on the Edge of Forever" · 1967',
  );
});
check("show info hash fixtures (parity with frontend)", () => {
  assert.equal(computeShowInfoHash({}), "459c0ba3");
  assert.equal(computeShowInfoHash(null), "459c0ba3");
  assert.equal(computeShowInfoHash(show), "7d3421c4");
  assert.equal(computeShowInfoHash({ series: "Star Trek" }), "c45802ff");
});

// --- validators -------------------------------------------------------------
check("quotes must be verbatim in the scene's dialogue", () => {
  const kept = verifyQuotes(
    [
      "I'll kill you first!",
      "“You’re all murderers!”",
      "This line is from a different scene.",
      "I will kill you first",
      "Security",
    ],
    transcript,
    95,
    110,
  );
  assert.deepEqual(kept, ["I'll kill you first!", "“You’re all murderers!”"]);
});
check("ratings allowlist", () => {
  assert.equal(normalizeRating("tv-14"), "TV-14");
  assert.equal(normalizeRating("TV MA"), "TV-MA");
  assert.equal(normalizeRating("TVPG"), "TV-PG");
  assert.equal(normalizeRating("PG-13"), "");
  assert.equal(normalizeRating(undefined), "");
});
check("hashtags normalized, deduped, capped", () => {
  assert.deepEqual(
    normalizeHashtags(["StarTrek", "#star trek", "##Bones!", "startrek", 7, "#"], 5),
    ["#StarTrek", "#Bones"],
  );
});
check("chapters follow YouTube's rules or are dropped", () => {
  const ok = validateChapters(
    [
      { start: "0:40", title: "Security arrives" },
      { start: "0:00", title: "The hypo" },
      { start: "0:15", title: "Paranoia" },
    ],
    60,
  );
  assert.deepEqual(ok.map((c) => c.startSec), [0, 15, 40]);
  assert.deepEqual(validateChapters([{ start: "0:05", title: "a" }, { start: "0:20", title: "b" }, { start: "0:40", title: "c" }], 60), []);
  assert.deepEqual(validateChapters([{ start: "0:00", title: "a" }, { start: "0:20", title: "b" }], 60), []);
  assert.deepEqual(validateChapters([{ start: "0:00", title: "a" }, { start: "0:20", title: "b" }, { start: "0:55", title: "c" }], 60), []);
});

// --- prompt -------------------------------------------------------------------
const baseInput: AeoGenerationInput = {
  options: {
    characters: true,
    cast: true,
    locations: true,
    searchTitle: true,
    entityDescription: true,
    fanAliases: true,
    questions: true,
    keyQuotes: true,
    contentRating: true,
    platforms: ["youtube", "tiktok"],
  },
  wantIabTopics: true,
  show,
  videoTitle: "City on the Edge",
  sceneTitle: "2. I'll Kill You First!",
  transcript,
  segmentStart: 95,
  segmentEnd: 155,
};

check("prompt carries show facts and only requested fields", () => {
  const { user } = buildAeoPrompt(baseInput);
  assert.match(user, /Series: Star Trek \(The Original Series\)/);
  assert.match(user, /"cast"/);
  assert.match(user, /"youtube"/);
  assert.match(user, /"tiktok"/);
  assert.doesNotMatch(user, /"instagram_reels"/);
  const dialogue = user.split("<scene_dialogue>")[1].split("</scene_dialogue>")[0];
  assert.match(dialogue, /\[0:05\] I'll kill you first!/);
  assert.doesNotMatch(dialogue, /different scene/);
});
check("without show info the prompt never asks for cast", () => {
  const { user } = buildAeoPrompt({ ...baseInput, show: {} });
  assert.doesNotMatch(user, /"cast"/);
  assert.match(user, /Do not guess the series/);
});

// --- parsing ------------------------------------------------------------------
check("parse keeps valid fields and empties the rest", () => {
  const raw = JSON.stringify({
    characters: ["Leonard McCoy", "James T. Kirk", "leonard mccoy", ""],
    cast: ["DeForest Kelley", "William Shatner"],
    locations: ["USS Enterprise bridge"],
    search_title: "McCoy's Cordrazine Overdose | Star Trek: The Original Series",
    entity_description: "In Star Trek's \"The City on the Edge of Forever,\" Dr. McCoy overdoses.",
    fan_aliases: ["McCoy goes crazy", "cordrazine scene"],
    questions_answered: ["What Star Trek episode does McCoy overdose", "Why does McCoy go crazy in Star Trek?"],
    key_quotes: ["I'll kill you first!", "Live long and prosper"],
    content_rating: "tv-pg",
    iab_topics: ["150", "not-an-id"],
    platforms: {
      youtube: {
        title: "McCoy Overdoses on Cordrazine",
        description: "Para one.\n\nPara two.",
        hashtags: ["StarTrek"],
        tags: ["star trek", "mccoy"],
        chapters: [{ start: "0:00", title: "Hypo" }, { start: "0:20", title: "Paranoia" }, { start: "0:40", title: "Security" }],
      },
    },
  });
  const { aeo, iab } = parseAeoResponse(raw, baseInput);
  assert.deepEqual(aeo.entities?.characters, ["Leonard McCoy", "James T. Kirk"]);
  assert.deepEqual(aeo.entities?.cast, ["DeForest Kelley", "William Shatner"]);
  assert.equal(aeo.search?.questions?.[0], "What Star Trek episode does McCoy overdose?");
  assert.deepEqual(aeo.keyQuotes, ["I'll kill you first!"]);
  assert.equal(aeo.contentRating, "TV-PG");
  assert.equal(aeo.platforms?.youtube?.description, "Para one.\n\nPara two.");
  assert.equal(aeo.platforms?.youtube?.chapters?.length, 3);
  // TikTok was requested but not returned: stored empty, not re-requested.
  assert.deepEqual(aeo.platforms?.tiktok, {});
  // iab ids only from the allowlist (invalid dropped).
  assert.deepEqual(iab?.cat, ["150"]);
});
check("cast is forced empty without show info", () => {
  const { aeo } = parseAeoResponse(
    JSON.stringify({ cast: ["Somebody"] }),
    { ...baseInput, show: {}, options: { cast: true } },
  );
  assert.deepEqual(aeo.entities?.cast, []);
});

// --- staleness & merge ----------------------------------------------------------
const hash = computeShowInfoHash(show);
const aeoOpts = { characters: true, searchTitle: true, platforms: ["youtube" as const], showInfoHash: hash };

check("no cache: everything wanted is missing", () => {
  assert.deepEqual(computeMissingAeoOptions(undefined, aeoOpts), aeoOpts);
});
check("different show info: regenerate all", () => {
  const cached = { showInfoHash: "other", entities: { characters: ["X"] }, search: { title: "t" }, platforms: { youtube: {} } };
  assert.deepEqual(computeMissingAeoOptions(cached, aeoOpts), aeoOpts);
});
check("only missing fields are requested; empty values count as done", () => {
  const cached = { showInfoHash: hash, entities: { characters: [] }, platforms: { youtube: {} } };
  assert.deepEqual(computeMissingAeoOptions(cached, aeoOpts), {
    showInfoHash: hash,
    searchTitle: true,
  });
  assert.equal(
    computeMissingAeoOptions({ ...cached, search: { title: "" } }, aeoOpts),
    null,
  );
});
check("nothing wanted: no AEO work", () => {
  assert.equal(computeMissingAeoOptions(undefined, { showInfoHash: hash }), null);
  assert.equal(computeMissingAeoOptions(undefined, undefined), null);
});

const contentHash = computeSegmentMetadataFingerprint(10, 70);
const cachedEntry: StoredSegmentMetadata = {
  segmentId: "s1",
  contentHash,
  descriptions: { short: "A short" },
  thumbnailKey: "thumb.jpg",
  generatedAt: "2026-11-01T00:00:00Z",
};

check("AEO-only miss does not ask Pegasus for descriptions", () => {
  const missing = computeMissingMetadataOptions(
    cachedEntry,
    { includeDescriptions: true, descriptionLengths: ["short"], aeo: aeoOpts },
    10,
    70,
  );
  assert.ok(missing);
  assert.equal(missing!.includeDescriptions, false);
  assert.deepEqual(missing!.aeo, aeoOpts);
  assert.equal(pegasusOptionsFor(missing!), null);
});
check("IAB topics alone go to AEO, not Pegasus", () => {
  const missing = computeMissingMetadataOptions(
    { ...cachedEntry, tags: { iab: { cattax: 7, cat: ["1028", "325"] } } },
    { includeIab: true, iabFields: { formFactor: true, genres: true, topics: true }, includeDescriptions: false },
    10,
    70,
  );
  assert.ok(missing);
  assert.deepEqual(missing!.iabFields, { topics: true });
  assert.equal(pegasusOptionsFor(missing!), null);
});
check("Pegasus still runs for missing descriptions, without topics", () => {
  const pegasus = pegasusOptionsFor({
    includeDescriptions: true,
    descriptionLengths: ["paragraph"],
    includeIab: true,
    iabFields: { formFactor: true, genres: true, topics: true },
    aeo: aeoOpts,
  });
  assert.ok(pegasus);
  assert.equal(pegasus!.aeo, undefined);
  assert.deepEqual(pegasus!.iabFields, { formFactor: true, genres: true, topics: false });
});

check("merge keeps earlier AEO fields for the same show info and bounds", () => {
  const first = mergeSegmentMetadataEntry(cachedEntry, {
    ...cachedEntry,
    aeo: { showInfoHash: hash, entities: { characters: ["McCoy"] } },
  });
  const second = mergeSegmentMetadataEntry(first, {
    segmentId: "s1",
    contentHash,
    aeo: { showInfoHash: hash, search: { title: "T" }, entities: { locations: ["Bridge"] } },
    generatedAt: "2026-11-02T00:00:00Z",
  });
  assert.deepEqual(second.aeo?.entities, { characters: ["McCoy"], locations: ["Bridge"] });
  assert.equal(second.aeo?.search?.title, "T");
});
check("merge replaces AEO when show info or bounds change", () => {
  const withAeo: StoredSegmentMetadata = { ...cachedEntry, aeo: { showInfoHash: hash, keyQuotes: ["Old"] } };
  const newShow = mergeSegmentMetadataEntry(withAeo, {
    segmentId: "s1",
    contentHash,
    aeo: { showInfoHash: "other", search: { title: "New" } },
    generatedAt: "x",
  });
  assert.equal(newShow.aeo?.keyQuotes, undefined);
  const moved = mergeSegmentMetadataEntry(withAeo, {
    segmentId: "s1",
    contentHash: computeSegmentMetadataFingerprint(12, 70),
    generatedAt: "x",
  });
  assert.equal(moved.aeo, undefined);
});

console.log(`aeo-metadata: ${checks} checks passed`);
