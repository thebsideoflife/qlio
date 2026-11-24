/**
 * Whole-title thumbnail pass (Qlio Thumbnail Runbook Steps 6b and 6c):
 * label who each candidate shows across scenes, balance the set in code,
 * review the grid, and re-export any scene whose choice changed.
 */

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SPORELABS_SONNET_MODEL, sporelabsChatCompletions, type SporeLabsContentPart } from "../sporelabs";
import {
  balanceSet,
  capBreaks,
  isSinglePresenter,
  summarizeSet,
  type BalanceScene,
  type SetSummary,
} from "./balance";
import { exportThumbnail, type SourceInfo, type StoredThumbnailPick } from "./pick";
import { GRID_REVIEW_SYSTEM, SET_CLUSTER_SYSTEM } from "./prompts";

const s3 = new S3Client({});
/** Candidates per scene shown to the set calls. */
const SET_CANDIDATES = 3;

export interface SetPassScene {
  segmentId: string;
  sceneNumber: number;
  pick: StoredThumbnailPick;
  thumbnailKey: string;
}

export interface StoredThumbnailSet {
  version: number;
  fingerprint: string;
  summary: SetSummary;
  generatedAt: string;
  note: string;
}

/** Changes whenever any scene's candidates change. */
export function setFingerprint(scenes: SetPassScene[]): string {
  const raw = scenes
    .map((s) => `${s.segmentId}:${s.pick.contentHash}:${s.pick.candidates.map((c) => c.time.toFixed(3)).join(",")}`)
    .join("|");
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

async function previewDataUrl(bucket: string, key: string): Promise<string | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const bytes = await res.Body!.transformToByteArray();
    return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
}

function parseJson<T>(text: string): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

const label = (sceneNumber: number, k: number) => `S${String(sceneNumber).padStart(2, "0")}-c${k + 1}`;

async function askWithImages<T>(
  system: string,
  intro: string,
  images: Array<{ label: string; url: string }>,
): Promise<T | null> {
  const content: SporeLabsContentPart[] = [{ type: "text", text: intro }];
  for (const img of images) {
    content.push({ type: "text", text: img.label });
    content.push({ type: "image_url", image_url: { url: img.url } });
  }
  const result = await sporelabsChatCompletions({
    model: SPORELABS_SONNET_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content },
    ],
    maxTokens: 4000,
    temperature: 0,
    timeoutMs: 180_000,
    attempts: 2,
  });
  return parseJson<T>(String(result.content ?? ""));
}

export interface SetPassResult {
  picks: Map<string, StoredThumbnailPick>;
  set: StoredThumbnailSet;
}

export async function runSetPass(params: {
  scenes: SetPassScene[];
  bucket: string;
  sourceUrl: string;
  source: SourceInfo;
}): Promise<SetPassResult> {
  const scenes = [...params.scenes].sort((a, b) => a.sceneNumber - b.sceneNumber);
  const picks = new Map(scenes.map((s) => [s.segmentId, structuredClone(s.pick)]));
  const notes: string[] = [];

  // 1. Who is who, across scenes (subject clusters), and single-presenter
  const shown: Array<{ label: string; url: string; segmentId: string; k: number }> = [];
  for (const s of scenes) {
    const p = picks.get(s.segmentId)!;
    for (let k = 0; k < Math.min(SET_CANDIDATES, p.candidates.length); k++) {
      const url = await previewDataUrl(params.bucket, p.candidates[k].previewKey);
      if (url) shown.push({ label: label(s.sceneNumber, k), url, segmentId: s.segmentId, k });
    }
  }
  let singlePresenter = false;
  if (shown.length > 1) {
    const reply = await askWithImages<{ labels?: Record<string, string>; single_presenter?: boolean; presenter_label?: string | null }>(
      SET_CLUSTER_SYSTEM,
      `${scenes.length} scenes, ${shown.length} candidates.`,
      shown,
    ).catch((err) => {
      notes.push(`subject grouping failed (${err instanceof Error ? err.message : String(err)}); variety used each scene's own descriptions`);
      return null;
    });
    for (const item of shown) {
      const lab = reply?.labels?.[item.label];
      const cand = picks.get(item.segmentId)!.candidates[item.k];
      if (lab) cand.attrs.subject = lab;
      if (reply?.single_presenter && reply.presenter_label && lab === reply.presenter_label) cand.attrs.source = "presenter";
    }
    singlePresenter = Boolean(reply?.single_presenter);
  }

  // Only the candidates the set calls saw take part; a faceless frame is only
  // allowed on a single-presenter title (rule 5 exception).
  const balanceScenes: BalanceScene[] = scenes.map((s) => {
    const p = picks.get(s.segmentId)!;
    return {
      sceneNumber: s.sceneNumber,
      candidates: p.candidates.slice(0, SET_CANDIDATES),
    };
  });
  singlePresenter = singlePresenter || isSinglePresenter(balanceScenes);
  if (!singlePresenter) {
    for (const b of balanceScenes) {
      const withFace = b.candidates.filter((c) => c.attrs.source !== "other_material");
      if (withFace.length) b.candidates = withFace;
    }
  }

  // 2. Criterion 9 and the caps, in code
  const result = balanceSet(balanceScenes, { singlePresenter });
  const choice = [...result.choice];

  // 3. Grid review of the balanced set
  const gridSwaps: Array<{ sceneNumber: number; reason: string }> = [];
  const gridImages: Array<{ label: string; url: string }> = [];
  balanceScenes.forEach((b, i) => {
    b.candidates.forEach((c, k) => {
      const item = shown.find((x) => x.segmentId === scenes[i].segmentId && x.k === scenes[i].pick.candidates.findIndex((o) => o.time === c.time));
      if (!item) return;
      gridImages.push({ label: k === choice[i] ? `S${String(b.sceneNumber).padStart(2, "0")} chosen` : label(b.sceneNumber, k), url: item.url });
    });
  });
  if (balanceScenes.length >= 4 && gridImages.length) {
    const reply = await askWithImages<{ swaps?: Array<{ scene?: number; use?: string; reason?: string }>; note?: string }>(
      GRID_REVIEW_SYSTEM,
      `Running order: scenes ${balanceScenes.map((b) => b.sceneNumber).join(", ")}.`,
      gridImages,
    ).catch((err) => {
      notes.push(`grid review failed (${err instanceof Error ? err.message : String(err)})`);
      return null;
    });
    if (reply?.note) notes.push(`grid review: ${reply.note}`);
    for (const swap of (reply?.swaps ?? []).slice(0, 4)) {
      const i = balanceScenes.findIndex((b) => b.sceneNumber === Number(swap.scene));
      const m = /c(\d+)$/.exec(String(swap.use ?? ""));
      if (i < 0 || !m) continue;
      const k = Number(m[1]) - 1;
      const cand = balanceScenes[i].candidates[k];
      if (!cand || k === choice[i] || cand.scores.face_emotion < 3) continue;
      // Never trade a grid preference for a broken cap
      const before = capBreaks(balanceScenes, choice.map((c, j) => balanceScenes[j].candidates[c]), { singlePresenter }).length;
      const prev = choice[i];
      choice[i] = k;
      const after = capBreaks(balanceScenes, choice.map((c, j) => balanceScenes[j].candidates[c]), { singlePresenter }).length;
      if (after > before) {
        choice[i] = prev;
        continue;
      }
      gridSwaps.push({ sceneNumber: balanceScenes[i].sceneNumber, reason: String(swap.reason || "grid review").slice(0, 160) });
    }
  }

  // 4. Store the choices (as indexes into each scene's stored candidates) and re-export
  await Promise.all(
    scenes.map(async (s, i) => {
      const p = picks.get(s.segmentId)!;
      const b = balanceScenes[i];
      if (choice[i] < 0 || !b.candidates.length) return;
      const chosen = b.candidates[choice[i]];
      const runner = result.runnerUp[i] >= 0 && result.runnerUp[i] !== choice[i] ? b.candidates[result.runnerUp[i]] : b.candidates.find((_, k) => k !== choice[i]);
      p.chosen = p.candidates.findIndex((c) => c.time === chosen.time);
      p.runnerUp = runner ? p.candidates.findIndex((c) => c.time === runner.time) : -1;
      p.variety = result.variety[i];
      const swap = gridSwaps.find((g) => g.sceneNumber === s.sceneNumber) ?? result.swaps.find((g) => g.sceneNumber === s.sceneNumber);
      p.flags = p.flags.filter((f) => !f.startsWith("set:") && !f.startsWith("grid review:"));
      if (swap) p.flags.push(swap.reason.startsWith("cap") ? `set: ${swap.reason}` : `grid review: ${swap.reason}`);
      for (const b2 of result.capsBroken.filter((c) => c.sceneNumber === s.sceneNumber)) {
        p.flags.push(`set: cap kept broken, ${b2.detail} (no usable alternative)`);
      }
      if (!p.exported || Math.abs(p.exported.time - chosen.time) > 1e-3) {
        p.exported = await exportThumbnail({
          sourceUrl: params.sourceUrl,
          source: params.source,
          time: chosen.time,
          face: p.candidates[p.chosen].face,
          bucket: params.bucket,
          key: s.thumbnailKey,
        });
      }
    }),
  );

  const chosenAll = balanceScenes
    .map((b, i) => (choice[i] >= 0 ? b.candidates[choice[i]] : null))
    .filter((c): c is NonNullable<typeof c> => Boolean(c));
  const summary = summarizeSet(chosenAll, result, singlePresenter, gridSwaps);
  return {
    picks,
    set: {
      version: 1,
      fingerprint: setFingerprint(scenes),
      summary,
      generatedAt: new Date().toISOString(),
      note: notes.join(" "),
    },
  };
}
