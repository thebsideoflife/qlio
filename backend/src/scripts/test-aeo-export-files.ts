/** Export-zip AEO files: captions, transcript, JSON-LD, sitemap. */
import assert from "node:assert/strict";
import {
  aeoReadme,
  buildSceneJsonLd,
  buildVideoSitemap,
  formatSrt,
  formatTranscript,
  formatVtt,
  isoDuration,
  sceneCaptionCues,
  wordCount,
} from "../utils/aeo-export-files";
import type { CaptionLine } from "../utils/transcript-format";

let checks = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    checks++;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    throw err;
  }
};

const line = (id: string, startTime: number, endTime: number, text: string, speechEndTime?: number): CaptionLine => ({
  id,
  startTime,
  endTime,
  speechEndTime,
  text,
  words: [],
});
const captions = [
  line("a", 90, 94, "Before the scene", 93),
  line("b", 99.5, 103.2, "I'll kill you first!"),
  line("c", 104, 108.25, "Security -->  to the bridge"),
  line("d", 158, 163, "Held past the cut", 159),
  line("e", 161, 165, "After the scene"),
];

const cues = sceneCaptionCues(captions, 100, 160);

check("cues are clipped to the scene and on its clock", () => {
  assert.deepEqual(
    cues.map((c) => [c.start, c.end, c.text]),
    [
      [0, 3.2, "I'll kill you first!"],
      [4, 8.25, "Security --> to the bridge"],
      [58, 60, "Held past the cut"],
    ],
  );
});
check("SRT", () => {
  assert.equal(
    formatSrt(cues.slice(0, 2)),
    "1\n00:00:00,000 --> 00:00:03,200\nI'll kill you first!\n\n2\n00:00:04,000 --> 00:00:08,250\nSecurity --> to the bridge\n",
  );
});
check("VTT header and no cue-breaking arrows in text", () => {
  const vtt = formatVtt(cues.slice(1, 2));
  assert.ok(vtt.startsWith("WEBVTT\n\n00:00:04.000 --> 00:00:08.250\n"));
  assert.match(vtt, /Security -> to the bridge/);
});
check("transcript and word count", () => {
  assert.equal(formatTranscript(cues.slice(0, 1)), "I'll kill you first!\n");
  assert.equal(formatTranscript([]), "");
  assert.equal(wordCount(cues), 13);
});
check("ISO durations", () => {
  assert.equal(isoDuration(0), "PT0S");
  assert.equal(isoDuration(65.4), "PT1M5S");
  assert.equal(isoDuration(3600), "PT1H");
  assert.equal(isoDuration(3725), "PT1H2M5S");
});

const scene = {
  sceneNumber: 2,
  editorTitle: "2. I'll Kill You First!",
  title: "I'll Kill You First!",
  durationSec: 60,
  descriptions: { short: "McCoy overdoses" },
  tags: { mood: "chaotic, frightening" },
  aeo: {
    entities: { characters: ["Leonard McCoy"], cast: ["DeForest Kelley"], locations: ["USS Enterprise bridge"] },
    search: { title: "McCoy's Cordrazine Overdose | Star Trek", entityDescription: "In Star Trek, McCoy overdoses.", fanAliases: ["McCoy goes crazy"] },
    contentRating: "TV-14",
    platforms: { youtube: { tags: ["star trek"] } },
  },
};
const show = { series: "Star Trek (The Original Series)", season: "1", episode: "28", episodeTitle: "The City on the Edge of Forever", year: "1967" };

check("JSON-LD links clip, episode, season and series", () => {
  const doc = buildSceneJsonLd({
    scene,
    show,
    files: { video: "scene_02_Ill_Kill_You_First.mp4", thumbnail: "scene_02_Ill_Kill_You_First.jpg" },
    transcript: "I'll kill you first!\n",
  });
  assert.deepEqual(doc["@type"], ["VideoObject", "Clip"]);
  assert.equal(doc.name, "McCoy's Cordrazine Overdose | Star Trek");
  assert.equal(doc.duration, "PT1M");
  assert.deepEqual(doc.actor, [{ "@type": "Person", name: "DeForest Kelley" }]);
  assert.equal(doc.keywords, "McCoy goes crazy, star trek, chaotic, frightening");
  const episode = doc.partOfEpisode as Record<string, unknown>;
  assert.equal(episode["@type"], "TVEpisode");
  assert.equal(episode.episodeNumber, "28");
  assert.equal(episode.datePublished, "1967");
  assert.deepEqual(episode.partOfSeries, { "@type": "TVSeries", name: "Star Trek (The Original Series)" });
  assert.equal((episode.partOfSeason as Record<string, unknown>).seasonNumber, "1");
});
check("JSON-LD without show info has no episode links or empty fields", () => {
  const doc = buildSceneJsonLd({ scene: { sceneNumber: 1, durationSec: 5 }, show: {}, files: { video: "v.mp4" } });
  assert.equal(doc.partOfEpisode, undefined);
  assert.equal(doc.partOfSeries, undefined);
  assert.equal(doc.name, "Scene 1");
  assert.ok(Object.values(doc).every((v) => v !== undefined));
});
check("JSON-LD with only a series links straight to it", () => {
  const doc = buildSceneJsonLd({ scene, show: { series: "Star Trek" }, files: { video: "v.mp4" } });
  assert.deepEqual(doc.partOfSeries, { "@type": "TVSeries", name: "Star Trek" });
});
check("sitemap escapes text and marks mature clips", () => {
  const xml = buildVideoSitemap([
    { scene: { ...scene, aeo: { ...scene.aeo, search: { ...scene.aeo.search, title: "Kirk & Spock <live>" } } }, files: { video: "a.mp4", thumbnail: "a.jpg" } },
  ]);
  assert.match(xml, /<video:title>Kirk &amp; Spock &lt;live&gt;<\/video:title>/);
  assert.match(xml, /<video:content_loc>\{\{BASE_URL\}\}\/a\.mp4<\/video:content_loc>/);
  assert.match(xml, /<video:duration>60<\/video:duration>/);
  assert.match(xml, /<video:family_friendly>no<\/video:family_friendly>/);
  assert.match(xml, /^<\?xml/);
});
check("README explains placeholders only for files present", () => {
  const readme = aeoReadme({ show, files: { captions: true, transcript: false, schemaOrg: false, videoSitemap: true } });
  assert.match(readme, /Series: Star Trek \(The Original Series\) · S1 E28/);
  assert.match(readme, /\{\{PAGE_URL\}\}/);
  assert.doesNotMatch(readme, /jsonld/);
});

console.log(`aeo-export-files: ${checks} checks passed`);
