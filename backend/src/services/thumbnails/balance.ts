/**
 * Step 6 totals and Step 6b set balancing (Qlio Thumbnail Runbook), in code.
 * The model scores each candidate and describes it (subject cluster, look,
 * setting, shot, emotion); this module does the arithmetic: weighted totals,
 * criterion 9 (set variety), the soft caps, and the single-presenter blend.
 */

export interface CandidateScores {
  face_emotion: number;
  reads_small: number;
  focal_point: number;
  character: number;
  title_tie: number;
  tone: number;
  crop_16x9: number;
  /** Bonus, 0–5. */
  eye_contact: number;
}

export type ShotType = "close-up" | "two-shot" | "wide";

export interface CandidateAttributes {
  /** Same label for the same person (or hero subject) across the title, e.g. "P1". */
  subject: string;
  /** Costume, hat, hairstyle, prop. */
  look: string;
  setting: string;
  shot: ShotType;
  emotion: string;
  /** "presenter" on single-presenter titles; "cast" otherwise; "other_material" for B-roll etc. */
  source: "cast" | "presenter" | "other_material";
  /** Only from a cast list or script, never from a face. */
  gender: "female" | "male" | "mixed" | "unknown";
}

export interface BalanceCandidate {
  time: number;
  scores: CandidateScores;
  attrs: CandidateAttributes;
}

export interface BalanceScene {
  sceneNumber: number;
  /** Eligible candidates (passed every rule), best first. */
  candidates: BalanceCandidate[];
}

export const WEIGHTS: Record<keyof CandidateScores, number> = {
  face_emotion: 3,
  reads_small: 2,
  focal_point: 2,
  character: 1,
  title_tie: 2,
  tone: 1,
  crop_16x9: 2,
  eye_contact: 1,
};
export const VARIETY_WEIGHT = 2;

export function baseTotal(scores: CandidateScores): number {
  let total = 0;
  for (const key of Object.keys(WEIGHTS) as Array<keyof CandidateScores>) {
    total += WEIGHTS[key] * (Number(scores[key]) || 0);
  }
  return total;
}

/** Step 6 provisional order: total, then face/emotion, then 16:9 crop. */
export function rankCandidates(candidates: BalanceCandidate[]): BalanceCandidate[] {
  return [...candidates].sort(
    (a, b) =>
      baseTotal(b.scores) - baseTotal(a.scores) ||
      b.scores.face_emotion - a.scores.face_emotion ||
      b.scores.crop_16x9 - a.scores.crop_16x9 ||
      a.time - b.time,
  );
}

function lookKey(a: CandidateAttributes): string {
  return `${a.subject}|${a.look.trim().toLowerCase()}`;
}

/**
 * Criterion 9 for `cand` in scene `index`, against the other scenes' current
 * choices: 5 adds something the set lacks, 3 neutral, 1 repeats subject and
 * look, or matches a neighbour on subject, look and shot.
 */
export function varietyScore(
  cand: BalanceCandidate,
  index: number,
  chosen: Array<BalanceCandidate | null>,
): number {
  const others = chosen.filter((c, i) => i !== index && c) as BalanceCandidate[];
  const neighbours = [chosen[index - 1], chosen[index + 1]].filter(Boolean) as BalanceCandidate[];
  const a = cand.attrs;
  if (
    neighbours.some(
      (n) => n.attrs.subject === a.subject && lookKey(n.attrs) === lookKey(a) && n.attrs.shot === a.shot,
    )
  ) {
    return 1;
  }
  if (others.some((o) => lookKey(o.attrs) === lookKey(a))) return 1;
  const newSubject = !others.some((o) => o.attrs.subject === a.subject);
  const newSetting = !others.some((o) => o.attrs.setting.toLowerCase() === a.setting.toLowerCase());
  const newEmotion = !others.some((o) => o.attrs.emotion.toLowerCase() === a.emotion.toLowerCase());
  if (newSubject || newSetting || newEmotion) return 5;
  return 3;
}

export interface CapBreak {
  sceneNumber: number;
  cap: "subject_share" | "subject_run" | "setting_run" | "shot_run" | "same_look" | "emotion" | "presenter_run";
  detail: string;
}

export interface BalanceOptions {
  /** Single-presenter title: presenter share target is 1 in 3 (Step 6c). */
  singlePresenter?: boolean;
}

/** Soft caps of Step 6b (and the presenter spread of Step 6c). */
export function capBreaks(
  scenes: BalanceScene[],
  chosen: BalanceCandidate[],
  options: BalanceOptions = {},
): CapBreak[] {
  const n = chosen.length;
  const out: CapBreak[] = [];
  const shareCap = Math.ceil(0.3 * n);
  const subjectCounts = new Map<string, number[]>();
  chosen.forEach((c, i) => {
    const list = subjectCounts.get(c.attrs.subject) ?? [];
    list.push(i);
    subjectCounts.set(c.attrs.subject, list);
  });
  for (const [subject, idx] of subjectCounts) {
    const presenter = options.singlePresenter && chosen[idx[0]].attrs.source === "presenter";
    const cap = presenter ? Math.ceil(n / 3) : shareCap;
    if (idx.length > cap) {
      for (const i of idx.slice(cap)) {
        out.push({ sceneNumber: scenes[i].sceneNumber, cap: "subject_share", detail: `${subject} in ${idx.length} of ${n} (cap ${cap})` });
      }
    }
  }
  const runCheck = (key: (c: BalanceCandidate) => string, cap: CapBreak["cap"], label: string) => {
    let run = 1;
    for (let i = 1; i < n; i++) {
      run = key(chosen[i]) === key(chosen[i - 1]) ? run + 1 : 1;
      if (run > 2) out.push({ sceneNumber: scenes[i].sceneNumber, cap, detail: `third ${label} in a row: ${key(chosen[i])}` });
    }
  };
  runCheck((c) => c.attrs.subject, "subject_run", "same subject");
  runCheck((c) => c.attrs.setting.toLowerCase(), "setting_run", "same setting");
  runCheck((c) => c.attrs.shot, "shot_run", "same shot type");
  const looks = new Map<string, number[]>();
  chosen.forEach((c, i) => {
    if (c.attrs.source === "other_material") return;
    const list = looks.get(lookKey(c.attrs)) ?? [];
    list.push(i);
    looks.set(lookKey(c.attrs), list);
  });
  for (const [key, idx] of looks) {
    if (idx.length > 3) {
      for (const i of idx.slice(3)) out.push({ sceneNumber: scenes[i].sceneNumber, cap: "same_look", detail: `${key} used ${idx.length} times` });
    }
    for (let k = 1; k < idx.length; k++) {
      if (idx[k] === idx[k - 1] + 1) out.push({ sceneNumber: scenes[idx[k]].sceneNumber, cap: "same_look", detail: `${key} in adjacent scenes` });
    }
  }
  const emotions = new Map<string, number[]>();
  chosen.forEach((c, i) => {
    const e = c.attrs.emotion.toLowerCase();
    emotions.set(e, [...(emotions.get(e) ?? []), i]);
  });
  for (const [e, idx] of emotions) {
    if (idx.length > 3) {
      for (const i of idx.slice(3)) out.push({ sceneNumber: scenes[i].sceneNumber, cap: "emotion", detail: `"${e}" used ${idx.length} times` });
    }
  }
  if (options.singlePresenter) {
    for (let i = 1; i < n; i++) {
      if (chosen[i].attrs.source === "presenter" && chosen[i - 1].attrs.source === "presenter") {
        out.push({ sceneNumber: scenes[i].sceneNumber, cap: "presenter_run", detail: "two presenter scenes in a row" });
      }
    }
  }
  return out;
}

export interface BalanceResult {
  /** Index into each scene's candidates. */
  choice: number[];
  /** Best alternative after the pass, or -1. */
  runnerUp: number[];
  variety: number[];
  passes: number;
  capsBroken: CapBreak[];
  swaps: Array<{ sceneNumber: number; reason: string }>;
}

/** Candidates the pass may use: rule 5 needs at least 3 on criterion 1. */
function usable(scene: BalanceScene): number[] {
  const ok = scene.candidates
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.scores.face_emotion >= 3)
    .map(({ i }) => i);
  return ok.length ? ok : scene.candidates.length ? [0] : [];
}

/**
 * Step 6b: score criterion 9 against the provisional set, re-pick, repeat
 * up to 3 passes; then swap where a cap is broken, cheapest swap first.
 * Never swaps to a candidate below 3 on criterion 1.
 */
export function balanceSet(scenes: BalanceScene[], options: BalanceOptions = {}): BalanceResult {
  const choice: number[] = scenes.map((s) => (s.candidates.length ? 0 : -1));
  const pick = () => choice.map((c, i) => (c >= 0 ? scenes[i].candidates[c] : null));
  let passes = 0;
  for (; passes < 3; passes++) {
    let changed = false;
    for (let i = 0; i < scenes.length; i++) {
      if (choice[i] < 0) continue;
      const current = pick();
      let best = choice[i];
      let bestTotal = -Infinity;
      for (const k of usable(scenes[i])) {
        const c = scenes[i].candidates[k];
        const total = baseTotal(c.scores) + VARIETY_WEIGHT * varietyScore(c, i, current);
        if (total > bestTotal + 1e-9) {
          bestTotal = total;
          best = k;
        }
      }
      if (best !== choice[i]) {
        choice[i] = best;
        changed = true;
      }
    }
    if (!changed) {
      passes++;
      break;
    }
  }

  const swaps: BalanceResult["swaps"] = [];
  const scenesWith = scenes.map((s, i) => ({ s, i })).filter(({ i }) => choice[i] >= 0);
  const sub = scenesWith.map(({ s }) => s);
  const chosenNow = () => scenesWith.map(({ i }) => scenes[i].candidates[choice[i]]);
  for (let guard = 0; guard < 50; guard++) {
    const breaks = capBreaks(sub, chosenNow(), options);
    if (breaks.length === 0) break;
    // Cheapest swap that lowers the number of broken caps
    let bestSwap: { i: number; k: number; loss: number; reason: string } | null = null;
    const breaking = new Set(breaks.map((b) => b.sceneNumber));
    for (const { s, i } of scenesWith) {
      if (!breaking.has(s.sceneNumber)) continue;
      const curTotal = baseTotal(s.candidates[choice[i]].scores);
      for (const k of usable(s)) {
        if (k === choice[i]) continue;
        const before = choice[i];
        choice[i] = k;
        const after = capBreaks(sub, chosenNow(), options).length;
        choice[i] = before;
        if (after >= breaks.length) continue;
        const loss = curTotal - baseTotal(s.candidates[k].scores);
        if (!bestSwap || loss < bestSwap.loss) {
          bestSwap = { i, k, loss, reason: breaks.find((b) => b.sceneNumber === s.sceneNumber)!.detail };
        }
      }
    }
    if (!bestSwap) break;
    choice[bestSwap.i] = bestSwap.k;
    swaps.push({ sceneNumber: scenes[bestSwap.i].sceneNumber, reason: `cap: ${bestSwap.reason}` });
  }

  const final = pick();
  const variety = scenes.map((s, i) => (choice[i] >= 0 ? varietyScore(s.candidates[choice[i]], i, final) : 0));
  const runnerUp = scenes.map((s, i) => {
    let best = -1;
    let bestTotal = -Infinity;
    for (const k of usable(s)) {
      if (k === choice[i]) continue;
      const t = baseTotal(s.candidates[k].scores) + VARIETY_WEIGHT * varietyScore(s.candidates[k], i, final);
      if (t > bestTotal) {
        bestTotal = t;
        best = k;
      }
    }
    return best;
  });
  return {
    choice,
    runnerUp,
    variety,
    passes,
    capsBroken: capBreaks(sub, chosenNow(), options),
    swaps,
  };
}

/** Step 6c: one face cluster supplies almost every usable face. */
export function isSinglePresenter(scenes: BalanceScene[]): boolean {
  const counts = new Map<string, number>();
  let faces = 0;
  for (const s of scenes) {
    for (const c of s.candidates) {
      if (c.attrs.source === "other_material") continue;
      faces++;
      counts.set(c.attrs.subject, (counts.get(c.attrs.subject) ?? 0) + 1);
    }
  }
  if (faces < 6) return false;
  const top = Math.max(0, ...counts.values());
  return top / faces >= 0.85;
}

export interface SetSummary {
  subject_counts: Record<string, number>;
  max_subject_share: number;
  longest_same_subject_run: number;
  same_look_max: number;
  emotion_max: number;
  caps_broken: Array<{ scene: number; cap: string; detail: string }>;
  passes: number;
  gender_counts: Record<string, number>;
  gender_note: string;
  single_presenter: boolean;
  blend?: { presenter: number; other_material: number; target: "1:2" };
  grid_review_swaps: Array<{ scene: number; reason: string }>;
}

export function summarizeSet(
  chosen: BalanceCandidate[],
  result: Pick<BalanceResult, "capsBroken" | "passes" | "swaps">,
  singlePresenter: boolean,
  gridSwaps: Array<{ sceneNumber: number; reason: string }> = [],
): SetSummary {
  const count = (key: (c: BalanceCandidate) => string) => {
    const m = new Map<string, number>();
    for (const c of chosen) m.set(key(c), (m.get(key(c)) ?? 0) + 1);
    return m;
  };
  const subjects = count((c) => c.attrs.subject);
  let run = 0;
  let longest = 0;
  chosen.forEach((c, i) => {
    run = i > 0 && chosen[i - 1].attrs.subject === c.attrs.subject ? run + 1 : 1;
    longest = Math.max(longest, run);
  });
  const genders = count((c) => c.attrs.gender);
  const unknownOnly = [...genders.keys()].every((g) => g === "unknown");
  return {
    subject_counts: Object.fromEntries(subjects),
    max_subject_share: chosen.length ? Math.round((Math.max(...subjects.values()) / chosen.length) * 100) / 100 : 0,
    longest_same_subject_run: longest,
    same_look_max: Math.max(0, ...count((c) => lookKey(c.attrs)).values()),
    emotion_max: Math.max(0, ...count((c) => c.attrs.emotion.toLowerCase()).values()),
    caps_broken: result.capsBroken.map((b) => ({ scene: b.sceneNumber, cap: b.cap, detail: b.detail })),
    passes: result.passes,
    gender_counts: Object.fromEntries(genders),
    gender_note: unknownOnly
      ? "No cast list with genders was provided; the runbook forbids inferring gender from faces, so the set was not gender-balanced."
      : "",
    single_presenter: singlePresenter,
    ...(singlePresenter
      ? {
          blend: {
            presenter: chosen.filter((c) => c.attrs.source === "presenter").length,
            other_material: chosen.filter((c) => c.attrs.source === "other_material").length,
            target: "1:2" as const,
          },
        }
      : {}),
    grid_review_swaps: gridSwaps.map((s) => ({ scene: s.sceneNumber, reason: s.reason })),
  };
}
