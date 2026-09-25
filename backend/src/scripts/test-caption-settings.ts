/**
 * Tests for the shared caption-settings helpers: merging, change detection,
 * and choosing which sibling project a new project inherits captions from.
 */
import {
  captionSettingsEqual,
  DEFAULT_CAPTION_SETTINGS,
  mergeCaptionSettings,
  pickCaptionSettingsSource,
  type CaptionSettings,
} from "../utils/caption-settings";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- mergeCaptionSettings ---
const noOverride = mergeCaptionSettings(DEFAULT_CAPTION_SETTINGS);
assert(deepEqual(noOverride, DEFAULT_CAPTION_SETTINGS), "no override yields defaults");
assert(noOverride !== DEFAULT_CAPTION_SETTINGS, "merge returns a fresh object");
assert(noOverride.style !== DEFAULT_CAPTION_SETTINGS.style, "merge copies style");

const partial = mergeCaptionSettings(DEFAULT_CAPTION_SETTINGS, {
  style: { fontSize: 3, color: "#ff0000" },
  activeLanguage: "es",
  wordEdits: { "1.25": "Hola" },
});
assert(partial.style.fontSize === 3, "override fontSize wins");
assert(partial.style.color === "#ff0000", "override color wins");
assert(
  partial.style.fontFamily === DEFAULT_CAPTION_SETTINGS.style.fontFamily,
  "missing style fields fall back to base",
);
assert(
  partial.style.position.x === 50 && partial.style.position.y === 85,
  "position falls back to base when absent",
);
assert(partial.enabled === true, "enabled falls back to base");
assert(partial.activeLanguage === "es", "activeLanguage carried over");
assert(partial.wordEdits?.["1.25"] === "Hola", "wordEdits carried over");
assert(
  DEFAULT_CAPTION_SETTINGS.style.fontSize === 2,
  "merge does not mutate the defaults",
);

const disabled = mergeCaptionSettings(DEFAULT_CAPTION_SETTINGS, {
  enabled: false,
  style: { position: { x: 10, y: 20 } },
});
assert(disabled.enabled === false, "enabled=false is honoured (not treated as absent)");
assert(disabled.style.position.x === 10 && disabled.style.position.y === 20, "position override wins");

const undefinedFields = mergeCaptionSettings(DEFAULT_CAPTION_SETTINGS, {
  activeLanguage: undefined,
  style: { fontSize: undefined, highlightColor: undefined },
});
assert(undefinedFields.style.fontSize === 2, "undefined style field does not clobber base");
assert(undefinedFields.style.highlightColor === "#fbbf24", "undefined highlightColor keeps base");
assert(!("activeLanguage" in undefinedFields), "undefined top-level field is dropped");

// Layering twice (defaults <- project <- request) behaves like renderVideo did.
const projectSettings: CaptionSettings = {
  enabled: true,
  style: { ...DEFAULT_CAPTION_SETTINGS.style, fontSize: 4 },
  wordEdits: { a: "1", b: "2" },
};
const layered = mergeCaptionSettings(
  mergeCaptionSettings(DEFAULT_CAPTION_SETTINGS, projectSettings),
  { style: { color: "#00ff00" }, wordEdits: { c: "3" } },
);
assert(layered.style.fontSize === 4, "project value survives request layer");
assert(layered.style.color === "#00ff00", "request value wins over project");
assert(deepEqual(layered.wordEdits, { c: "3" }), "wordEdits replaced wholesale by the latest layer");

// --- captionSettingsEqual ---
assert(
  captionSettingsEqual(
    { enabled: true, style: { fontSize: 2, position: { x: 1, y: 2 } } },
    { style: { position: { y: 2, x: 1 }, fontSize: 2 }, enabled: true },
  ),
  "key order is ignored",
);
assert(
  captionSettingsEqual({ enabled: true, activeLanguage: undefined }, { enabled: true }),
  "undefined values are ignored",
);
assert(
  !captionSettingsEqual({ enabled: true, style: { fontSize: 2 } }, { enabled: true, style: { fontSize: 3 } }),
  "differing nested value is unequal",
);
assert(
  !captionSettingsEqual(
    { enabled: true, wordEdits: { "1": "a" } },
    { enabled: true, wordEdits: { "1": "b" } },
  ),
  "differing wordEdits are unequal",
);
assert(!captionSettingsEqual(undefined, { enabled: true }), "missing vs present is unequal");
assert(captionSettingsEqual(undefined, undefined), "both missing is equal");

// --- pickCaptionSettingsSource ---
const s1 = { enabled: true, style: { fontSize: 1 } };
const s2 = { enabled: true, style: { fontSize: 2 } };
const s3 = { enabled: true, style: { fontSize: 3 } };

assert(pickCaptionSettingsSource([]) === null, "no siblings -> null");
assert(
  pickCaptionSettingsSource([
    { projectId: "p1", updatedAt: "2026-09-01T00:00:00.000Z" },
    { projectId: "p2", updatedAt: "2026-09-02T00:00:00.000Z", captionSettings: null },
    { projectId: "p3", updatedAt: "2026-09-03T00:00:00.000Z", captionSettings: "bogus" },
  ]) === null,
  "siblings without a captionSettings object are ignored",
);

const byStamp = pickCaptionSettingsSource([
  {
    projectId: "old-edit",
    captionSettings: s1,
    captionSettingsUpdatedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z", // bumped by a server-side job
  },
  {
    projectId: "recent-edit",
    captionSettings: s2,
    captionSettingsUpdatedAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
  },
]);
assert(byStamp?.projectId === "recent-edit", "greatest captionSettingsUpdatedAt wins over a newer updatedAt");
assert(byStamp?.captionSettingsUpdatedAt === "2026-09-05T00:00:00.000Z", "returns the ranking stamp");
assert(byStamp?.captionSettings === s2, "returns that project's settings");

const fallback = pickCaptionSettingsSource([
  {
    projectId: "stamped",
    captionSettings: s1,
    captionSettingsUpdatedAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
  },
  {
    projectId: "legacy",
    captionSettings: s2,
    updatedAt: "2026-09-10T00:00:00.000Z", // no stamp: fall back to updatedAt
  },
]);
assert(fallback?.projectId === "legacy", "legacy project falls back to updatedAt and can win");
assert(
  fallback?.captionSettingsUpdatedAt === "2026-09-10T00:00:00.000Z",
  "fallback stamp is the updatedAt used for ranking",
);

const createdAtOnly = pickCaptionSettingsSource([
  { projectId: "c", captionSettings: s3, createdAt: "2026-09-01T00:00:00.000Z" },
]);
assert(createdAtOnly?.projectId === "c", "createdAt is the last-resort stamp");

const tie = pickCaptionSettingsSource([
  { projectId: "fell-back", captionSettings: s1, updatedAt: "2026-09-05T00:00:00.000Z" },
  {
    projectId: "explicit",
    captionSettings: s2,
    captionSettingsUpdatedAt: "2026-09-05T00:00:00.000Z",
  },
]);
assert(tie?.projectId === "explicit", "on a tie an explicit stamp beats a fallback");

const stableTie = pickCaptionSettingsSource([
  { projectId: "first", captionSettings: s1, captionSettingsUpdatedAt: "2026-09-05T00:00:00.000Z" },
  { projectId: "second", captionSettings: s2, captionSettingsUpdatedAt: "2026-09-05T00:00:00.000Z" },
]);
assert(stableTie?.projectId === "first", "on an exact tie the earlier entry is kept");

assert(
  pickCaptionSettingsSource([
    { projectId: "bad", captionSettings: s1, captionSettingsUpdatedAt: "not a date" },
  ]) === null,
  "unparseable stamps are skipped",
);

const noStamp = pickCaptionSettingsSource([{ projectId: "x", captionSettings: s1 }]);
assert(noStamp === null, "a candidate with no timestamp at all is skipped");

// End-to-end: what createProject writes for a new project.
const inherited = mergeCaptionSettings(DEFAULT_CAPTION_SETTINGS, byStamp!.captionSettings);
assert(inherited.style.fontSize === 2 && inherited.style.maxWidth === 95, "inherited settings layer over defaults");

console.log("caption-settings tests passed");
