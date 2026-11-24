/**
 * Export-package files from the Thumbnail Runbook: the per-scene selection
 * log (Step 7), the contact sheet for human review (Step 8), the
 * `compact_thumbnail` fields and the `_notes.thumbnails` entry (Step 9).
 */

import { baseTotal, VARIETY_WEIGHT } from "../services/thumbnails/balance";
import type { StoredThumbnailPick } from "../services/thumbnails/pick";
import type { StoredThumbnailSet } from "../services/thumbnails/setPass";

export const CDN_PLACEHOLDER = "https://[cdn-path]";

export interface ThumbnailSceneInput {
  sceneNumber: number;
  title: string;
  filename: string;
  pick: StoredThumbnailPick | undefined;
  /** Zip-relative path of the runner-up preview, when included. */
  runnerUpFile?: string;
}

function clock(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const f = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}.${p(f, 3)}`;
}

/** `compact_thumbnail` block for a scene (always written). */
export function compactThumbnail(filename: string, cdnPath: string | null = null) {
  return {
    filename,
    resolution: "1920x1080",
    timestamp_link: `${cdnPath ? `https://${cdnPath.replace(/^https?:\/\//, "").replace(/\/+$/, "")}` : CDN_PLACEHOLDER}/${filename}`,
  };
}

/** One selection-log entry per scene, in the runbook's schema. */
export function selectionLogEntry(scene: ThumbnailSceneInput) {
  const p = scene.pick;
  const chosen = p && p.chosen >= 0 ? p.candidates[p.chosen] : undefined;
  const runner = p && p.runnerUp >= 0 ? p.candidates[p.runnerUp] : undefined;
  if (!p || !chosen) {
    return {
      scene: scene.sceneNumber,
      filename: scene.filename,
      frame_time_source: null,
      flags: [p ? "no usable candidate: frame 1 s in, needs a human pick" : "legacy thumbnail (frame 1 s in), not chosen by the runbook"],
    };
  }
  const variety = p.variety ?? 3;
  return {
    scene: scene.sceneNumber,
    filename: scene.filename,
    frame_time_source: clock(chosen.time),
    character: chosen.attrs.subject,
    source: chosen.attrs.source,
    material: chosen.attrs.source === "other_material" ? chosen.note : "",
    material_owner: chosen.attrs.source === "other_material" ? "unknown" : "",
    emotion: chosen.attrs.emotion || p.brief.emotion,
    spoiler_sensitivity: p.brief.spoiler_sensitivity,
    scores: {
      face_emotion: chosen.scores.face_emotion,
      reads_small: chosen.scores.reads_small,
      focal_point: chosen.scores.focal_point,
      character: chosen.scores.character,
      specific: chosen.scores.title_tie,
      tone: chosen.scores.tone,
      crop_16x9: chosen.scores.crop_16x9,
      eye_contact: chosen.scores.eye_contact,
      variety,
    },
    weighted_total: baseTotal(chosen.scores) + VARIETY_WEIGHT * variety,
    runner_up_time: runner ? clock(runner.time) : null,
    candidates_pulled: p.pulled,
    candidates_scored: p.scored,
    upscale: p.exported?.upscale ?? null,
    brightness: p.exported?.brightness ?? null,
    flags: [
      ...p.flags,
      ...(chosen.attrs.source === "other_material" ? ["rights review: confirm who owns this material"] : []),
    ],
    rationale: p.rationale || chosen.note,
  };
}

export function buildSelectionLog(scenes: ThumbnailSceneInput[], set: StoredThumbnailSet | undefined) {
  return [
    ...scenes.map(selectionLogEntry),
    {
      set_balance: set?.summary ?? null,
      ...(set?.note ? { set_note: set.note } : {}),
    },
  ];
}

/** `_notes.thumbnails` text. */
export function thumbnailNotes(scenes: ThumbnailSceneInput[], cdnPath: string | null = null): string {
  const picked = scenes.filter((s) => s.pick && s.pick.chosen >= 0).length;
  const flagged = scenes.filter((s) => !s.pick || s.pick.flags.length > 0);
  const reasons = new Map<string, number>();
  for (const s of flagged) {
    const list = s.pick ? s.pick.flags : ["legacy frame"];
    for (const f of list) {
      const key = f.split(":")[0].split("(")[0].trim();
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
  }
  const why = [...reasons.entries()].map(([r, n]) => `${r} (${n})`).join(", ");
  return [
    `Images generated in 16:9 1920x1080 only (no extra formats) for ${scenes.length} scenes; ${picked} chosen by the Thumbnail Runbook picker.`,
    cdnPath ? `CDN path: ${cdnPath}.` : "CDN path not assigned: timestamp_link values are placeholders.",
    flagged.length ? `${flagged.length} scenes flagged: ${why}.` : "No scenes flagged.",
    "Upscaling used Lanczos only; Real-ESRGAN is not available in this build.",
    "Not yet reviewed by a human: see the contact sheet before CDN upload.",
  ].join(" ");
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Step 8 contact sheet: chosen vs runner-up, one row per scene, flagged first. */
export function buildContactSheetHtml(params: {
  showName: string;
  scenes: ThumbnailSceneInput[];
  set: StoredThumbnailSet | undefined;
}): string {
  const rows = [...params.scenes].sort((a, b) => {
    const fa = !a.pick || a.pick.flags.length > 0 ? 0 : 1;
    const fb = !b.pick || b.pick.flags.length > 0 ? 0 : 1;
    return fa - fb || a.sceneNumber - b.sceneNumber;
  });
  const s = params.set?.summary;
  const counts = s
    ? `Subjects: ${Object.entries(s.subject_counts).map(([k, v]) => `${esc(k)} ${v}`).join(", ")} · max share ${Math.round(s.max_subject_share * 100)}% · longest run ${s.longest_same_subject_run} · caps broken ${s.caps_broken.length}${s.single_presenter ? ` · single presenter (${s.blend?.presenter ?? 0} presenter / ${s.blend?.other_material ?? 0} other)` : ""}`
    : "Set balance not run.";
  const body = rows
    .map((r) => {
      const p = r.pick;
      const chosen = p && p.chosen >= 0 ? p.candidates[p.chosen] : undefined;
      const hml = p ? p.brief.spoiler_sensitivity[0] : "–";
      const flags = p ? p.flags : ["legacy frame, not chosen by the runbook"];
      return `<tr${flags.length ? ' class="flag"' : ""}>
<td class="n">${String(r.sceneNumber).padStart(2, "0")}</td>
<td><b>${esc(r.title)}</b> [${hml}]<br>${esc(chosen?.attrs.subject ?? "")}${chosen ? ` · ${esc(chosen.attrs.emotion)} · ${clock(chosen.time)}` : ""}${flags.length ? `<ul>${flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}</td>
<td><img src="${esc(r.filename)}" alt="chosen"><div>chosen</div></td>
<td>${r.runnerUpFile ? `<img src="${esc(r.runnerUpFile)}" alt="runner-up"><div>runner-up</div>` : "<div>no runner-up</div>"}</td>
</tr>`;
    })
    .join("\n");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(params.showName)} thumbnail contact sheet</title>
<style>
body{font:14px system-ui,sans-serif;margin:24px;color:#222}
table{border-collapse:collapse;width:100%}td{border-top:1px solid #ddd;padding:8px;vertical-align:top}
td.n{font:600 18px ui-monospace,monospace;width:40px}img{width:320px;display:block}
tr.flag{background:#fff7e0}ul{margin:4px 0 0 16px;padding:0;color:#8a5a00}
.sum{background:#f3f3f3;padding:10px 12px;border-radius:6px;margin-bottom:16px}
</style></head><body>
<h1>${esc(params.showName)}: thumbnail review</h1>
<div class="sum">${counts}${s?.gender_note ? `<br>${esc(s.gender_note)}` : ""}${params.set?.note ? `<br>${esc(params.set.note)}` : ""}</div>
<p>Flagged scenes first. A human signs off before images go to the CDN. To swap in a runner-up, use "Use runner-up" on the scene in Qlio's export panel.</p>
<table>
${body}
</table></body></html>
`;
}
