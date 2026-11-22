/**
 * Text layer and structured-data files for the export zip: per-scene
 * transcript, SRT and VTT captions and Schema.org JSON-LD, plus one video
 * sitemap. All pure, so the packaging Lambda only fetches and appends.
 *
 * Captions use the same lines the renderer burns in (same transcript, word
 * edits and grouping), shifted to the scene's own clock.
 */

import type { CaptionLine } from "./transcript-format";
import { captionsOverlappingRange } from "./transcript-format";
import { formatEpisodeLabel, normalizeShowInfo } from "../services/show-info";

export interface SceneCaptionCue {
  start: number;
  end: number;
  text: string;
}

/** Caption lines for one scene, on the scene's clock, clamped to its length. */
export function sceneCaptionCues(
  captions: CaptionLine[],
  startTime: number,
  endTime: number,
): SceneCaptionCue[] {
  const duration = Math.max(0, endTime - startTime);
  const ms = (sec: number) => Math.round(sec * 1000) / 1000;
  return captionsOverlappingRange(captions, startTime, endTime)
    .map((line) => ({
      start: ms(Math.max(0, line.startTime - startTime)),
      end: ms(Math.min(duration, line.endTime - startTime)),
      text: line.text.replace(/\s+/g, " ").trim(),
    }))
    .filter((cue) => cue.text && cue.end - cue.start > 0.05);
}

function timestamp(sec: number, separator: "," | "."): string {
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(ms, 3)}`;
}

export function formatSrt(cues: SceneCaptionCue[]): string {
  return cues
    .map(
      (cue, i) =>
        `${i + 1}\n${timestamp(cue.start, ",")} --> ${timestamp(cue.end, ",")}\n${cue.text}\n`,
    )
    .join("\n");
}

export function formatVtt(cues: SceneCaptionCue[]): string {
  const body = cues
    .map(
      (cue) =>
        `${timestamp(cue.start, ".")} --> ${timestamp(cue.end, ".")}\n${cue.text.replace(/-->/g, "->")}\n`,
    )
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

export function formatTranscript(cues: SceneCaptionCue[]): string {
  return cues.map((cue) => cue.text).join("\n") + (cues.length ? "\n" : "");
}

export function wordCount(cues: SceneCaptionCue[]): number {
  return cues.reduce(
    (total, cue) => total + cue.text.split(/\s+/).filter(Boolean).length,
    0,
  );
}

/** ISO 8601 duration, whole seconds ("PT1M5S"). */
export function isoDuration(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}${s || (!h && !m) ? `${s}S` : ""}`;
}

/** The subset of a metadata-document scene these builders read. */
export interface AeoExportScene {
  sceneNumber: number;
  editorTitle?: string;
  title?: string;
  durationSec: number;
  descriptions?: { short?: string; two_sentences?: string; paragraph?: string };
  tags?: { mood?: string; theme?: string; tone?: string; content_advisory?: string };
  aeo?: {
    entities?: { characters?: string[]; cast?: string[]; locations?: string[] };
    search?: {
      title?: string;
      entityDescription?: string;
      fanAliases?: string[];
      questions?: string[];
    };
    keyQuotes?: string[];
    contentRating?: string;
    platforms?: Record<string, { tags?: string[] } | undefined>;
  };
}

export interface SceneFileNames {
  video: string;
  thumbnail?: string;
}

function sceneName(scene: AeoExportScene): string {
  return (
    scene.aeo?.search?.title ||
    scene.title ||
    scene.editorTitle?.replace(/^\d+\.\s*/, "") ||
    `Scene ${scene.sceneNumber}`
  );
}

function sceneDescription(scene: AeoExportScene): string | undefined {
  return (
    scene.aeo?.search?.entityDescription ||
    scene.descriptions?.paragraph ||
    scene.descriptions?.two_sentences ||
    scene.descriptions?.short ||
    undefined
  );
}

function sceneKeywords(scene: AeoExportScene): string[] {
  const out: string[] = [];
  const add = (value?: string) => {
    const text = value?.trim();
    if (text && !out.some((k) => k.toLowerCase() === text.toLowerCase())) out.push(text);
  };
  scene.aeo?.search?.fanAliases?.forEach(add);
  scene.aeo?.platforms?.youtube?.tags?.forEach(add);
  for (const key of ["mood", "theme", "tone"] as const) {
    scene.tags?.[key]?.split(/,\s*/).forEach(add);
  }
  return out.slice(0, 20);
}

/**
 * Schema.org JSON-LD for one scene: a VideoObject that is also a Clip, linked
 * to its TVEpisode, TVSeason and TVSeries when the producer gave them.
 * `contentUrl` and `thumbnailUrl` are the files' names in the zip; whoever
 * publishes the clip swaps in the hosted URLs.
 */
export function buildSceneJsonLd(params: {
  scene: AeoExportScene;
  show: unknown;
  files: SceneFileNames;
  transcript?: string;
}): Record<string, unknown> {
  const { scene, files } = params;
  const show = normalizeShowInfo(params.show);
  const aeo = scene.aeo;
  const people = (names?: string[]) =>
    names?.length ? names.map((name) => ({ "@type": "Person", name })) : undefined;

  const series = show.series ? { "@type": "TVSeries", name: show.series } : undefined;
  const season = show.season
    ? {
        "@type": "TVSeason",
        seasonNumber: show.season,
        ...(series ? { partOfSeries: series } : {}),
      }
    : undefined;
  const episode =
    show.episode || show.episodeTitle
      ? {
          "@type": "TVEpisode",
          ...(show.episodeTitle ? { name: show.episodeTitle } : {}),
          ...(show.episode ? { episodeNumber: show.episode } : {}),
          ...(/^\d{4}$/.test(show.year ?? "") ? { datePublished: show.year } : {}),
          ...(season ? { partOfSeason: season } : {}),
          ...(series ? { partOfSeries: series } : {}),
        }
      : undefined;

  const doc: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": ["VideoObject", "Clip"],
    name: sceneName(scene),
    description: sceneDescription(scene),
    duration: isoDuration(scene.durationSec),
    contentUrl: files.video,
    thumbnailUrl: files.thumbnail,
    clipNumber: scene.sceneNumber,
    character: people(aeo?.entities?.characters),
    actor: people(aeo?.entities?.cast),
    contentLocation: aeo?.entities?.locations?.length
      ? aeo.entities.locations.map((name) => ({ "@type": "Place", name }))
      : undefined,
    contentRating: aeo?.contentRating || undefined,
    keywords: sceneKeywords(scene).join(", ") || undefined,
    transcript: params.transcript?.trim() || undefined,
    ...(episode
      ? { partOfEpisode: episode }
      : season
        ? { partOfSeason: season }
        : series
          ? { partOfSeries: series }
          : {}),
  };
  for (const [key, value] of Object.entries(doc)) {
    if (value === undefined) delete doc[key];
  }
  return doc;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export const SITEMAP_BASE_URL_TOKEN = "{{BASE_URL}}";
export const SITEMAP_PAGE_URL_TOKEN = "{{PAGE_URL}}";

/**
 * Google video sitemap entries. Hosting isn't known at export time, so URLs
 * carry {{PAGE_URL}} / {{BASE_URL}} placeholders, explained in the README.
 */
export function buildVideoSitemap(
  entries: Array<{ scene: AeoExportScene; files: SceneFileNames }>,
): string {
  const urls = entries.map(({ scene, files }) => {
    const title = sceneName(scene).slice(0, 100);
    const description = (sceneDescription(scene) || title).slice(0, 2048);
    const tags = sceneKeywords(scene).slice(0, 32);
    const rating = scene.aeo?.contentRating;
    const lines = [
      "  <url>",
      `    <loc>${xmlEscape(`${SITEMAP_PAGE_URL_TOKEN}/scene-${scene.sceneNumber}`)}</loc>`,
      "    <video:video>",
      files.thumbnail
        ? `      <video:thumbnail_loc>${xmlEscape(`${SITEMAP_BASE_URL_TOKEN}/${files.thumbnail}`)}</video:thumbnail_loc>`
        : "",
      `      <video:title>${xmlEscape(title)}</video:title>`,
      `      <video:description>${xmlEscape(description)}</video:description>`,
      `      <video:content_loc>${xmlEscape(`${SITEMAP_BASE_URL_TOKEN}/${files.video}`)}</video:content_loc>`,
      `      <video:duration>${Math.min(28_800, Math.max(1, Math.round(scene.durationSec)))}</video:duration>`,
      rating === "TV-14" || rating === "TV-MA"
        ? "      <video:family_friendly>no</video:family_friendly>"
        : "",
      ...tags.map((tag) => `      <video:tag>${xmlEscape(tag)}</video:tag>`),
      "    </video:video>",
      "  </url>",
    ];
    return lines.filter(Boolean).join("\n");
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    '        xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}

export function aeoReadme(params: {
  show: unknown;
  files: { captions: boolean; transcript: boolean; schemaOrg: boolean; videoSitemap: boolean };
}): string {
  const show = normalizeShowInfo(params.show);
  const lines = [
    "Search, targeting & AEO files",
    "=============================",
    "",
    show.series
      ? `Series: ${show.series}${formatEpisodeLabel(show) ? ` · ${formatEpisodeLabel(show)}` : ""}`
      : "Series: not set (add show info in Qlio's Export panel for richer structured data)",
    "",
  ];
  if (params.files.captions) {
    lines.push("*.srt / *.vtt   Captions on each scene's own timeline (upload alongside the video).");
  }
  if (params.files.transcript) {
    lines.push("*.txt           Plain transcript of each scene.");
  }
  if (params.files.schemaOrg) {
    lines.push(
      "*.jsonld        Schema.org VideoObject/Clip markup. Put it in a",
      "                <script type=\"application/ld+json\"> tag on the clip's page and",
      "                replace contentUrl / thumbnailUrl with the hosted URLs.",
    );
  }
  if (params.files.videoSitemap) {
    lines.push(
      "video-sitemap.xml  Google video sitemap. Replace {{PAGE_URL}} with the",
      "                   page each clip is published on and {{BASE_URL}} with",
      "                   where the video and thumbnail files are hosted.",
    );
  }
  lines.push("");
  return lines.join("\n");
}
