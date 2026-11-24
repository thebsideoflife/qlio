/** Thumbnail Runbook rules that live in code: filters, crop, lift, naming, set balance. */
import assert from "node:assert/strict";
import {
  brightnessLift,
  candidateFps,
  crop16x9,
  differenceHash,
  filterCandidates,
  hammingDistance,
  laplacianVariance,
  meanLuma,
  safeWindow,
  showSlug,
  THUMBNAIL_FILENAME_PATTERN,
  thumbnailFilename,
  upscalePlan,
  type CandidateStats,
  type GrayFrame,
} from "../services/thumbnails/frameMath";
import {
  balanceSet,
  baseTotal,
  capBreaks,
  isSinglePresenter,
  summarizeSet,
  type BalanceCandidate,
  type BalanceScene,
} from "../services/thumbnails/balance";

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

const frame = (w: number, h: number, f: (x: number, y: number) => number): GrayFrame => {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = Math.max(0, Math.min(255, f(x, y)));
  return { width: w, height: h, data };
};

// --- measures
check("mean luma", () => assert.equal(meanLuma(frame(4, 4, () => 100)), 100));
check("flat frame has no edges", () => assert.equal(laplacianVariance(frame(10, 10, () => 80)), 0));
check("checkerboard is sharp", () =>
  assert.ok(laplacianVariance(frame(20, 20, (x, y) => ((x + y) % 2 ? 255 : 0))) > 1000));
check("same image, same hash", () => {
  const a = frame(90, 80, (x) => x * 2);
  assert.equal(hammingDistance(differenceHash(a), differenceHash(a)), 0);
});
check("different images, distant hashes", () => {
  const a = frame(90, 80, (x) => x * 2);
  const b = frame(90, 80, (x) => 255 - x * 2);
  assert.ok(hammingDistance(differenceHash(a), differenceHash(b)) > 30);
});

// --- Step 5 filters
const stat = (time: number, luma: number, sharpness: number, hash: string): CandidateStats => ({ time, luma, sharpness, hash });
check("black, blur and duplicates are rejected with reasons", () => {
  const stats = [
    stat(1, 8, 500, "0000000000000000"),
    stat(2, 120, 500, "ffffffffffffffff"),
    stat(3, 120, 499, "fffffffffffffffe"), // near-duplicate of t=2, softer
    stat(9, 120, 498, "fffffffffffffffe"), // same picture 7 s later: a new moment, kept
    stat(4, 120, 5, "0f0f0f0f0f0f0f0f"), // below the floor
    stat(5, 120, 400, "00ff00ff00ff00ff"),
    stat(6, 120, 300, "f0f0f0f0f0f0f0f0"),
    stat(7, 120, 350, "aaaaaaaaaaaaaaaa"),
  ];
  const r = filterCandidates(stats);
  const reason = (t: number) => r.rejected.find((x) => x.time === t)?.reason ?? "";
  assert.match(reason(1), /black/);
  assert.match(reason(3), /near-duplicate/);
  assert.match(reason(4), /blur/);
  assert.ok(r.kept.some((k) => k.time === 2));
  assert.ok(r.kept.some((k) => k.time === 9), "same framing seconds later is a different moment");
});
check("survivors are spread across the scene", () => {
  const stats: CandidateStats[] = [];
  for (let i = 0; i < 60; i++) {
    const hash = i.toString(16).padStart(2, "0").repeat(8);
    stats.push(stat(i, 120, i < 30 ? 1000 + i : 600 + i, hash));
  }
  const r = filterCandidates(stats, 8);
  assert.equal(r.kept.length, 8);
  assert.ok(r.kept.some((k) => k.time >= 30), "not all from the sharper first half");
});
check("window is 1 s inside the scene", () => assert.deepEqual(safeWindow(10, 30), { start: 11, end: 29 }));
check("very short scenes keep a middle window", () => {
  const w = safeWindow(10, 11.5);
  assert.ok(w.start >= 10 && w.end <= 11.5 && w.end > w.start);
});
check("2 fps, capped at 240 frames", () => {
  assert.equal(candidateFps(60), 2);
  assert.equal(candidateFps(600), 0.4);
});

// --- Step 7 crop, upscale and lift
check("subject already on a third keeps the full 16:9 frame", () => {
  assert.deepEqual(crop16x9(1920, 1080, { x: 1 / 3, y: 0.4 }), { x: 0, y: 0, width: 1920, height: 1080 });
});
check("a centred subject is moved onto a third", () => {
  const c = crop16x9(1920, 1080, { x: 0.5, y: 0.4 });
  assert.ok(c.width < 1920 && Math.abs(c.width / c.height - 16 / 9) < 0.01);
  const rel = (0.5 * 1920 - c.x) / c.width;
  assert.ok(Math.abs(rel - 1 / 3) < 0.03 || Math.abs(rel - 2 / 3) < 0.03, `subject at ${rel.toFixed(2)} of the crop`);
  assert.ok(upscalePlan(c.width).factor <= 1.5, "zoom never needs more than 1.5x");
});
check("4:3 source is cropped to 16:9", () => {
  const c = crop16x9(1440, 1080, null);
  assert.equal(c.width, 1440);
  assert.equal(c.height, 810);
});
check("upscale methods follow the factor table", () => {
  assert.equal(upscalePlan(1920).method, "none");
  assert.equal(upscalePlan(1440).method, "lanczos");
  assert.equal(upscalePlan(1440).flag, null);
  assert.match(upscalePlan(640).flag ?? "", /over 1\.5x/);
  assert.match(upscalePlan(400).flag ?? "", /stop and ask/);
});
check("bright frames are not lifted", () => assert.equal(brightnessLift(frame(10, 10, () => 90)), null));
check("dark frames are lifted to about 72", () => {
  const lift = brightnessLift(frame(20, 20, (x) => 30 + x));
  assert.ok(lift && lift.gamma > 1 && lift.gamma <= 1.8);
  assert.ok(Math.abs(lift!.meanLumaAfter - 72) <= 2, `after ${lift!.meanLumaAfter}`);
});
check("very dark frames stop at gamma 1.8", () => {
  const lift = brightnessLift(frame(10, 10, () => 5));
  assert.equal(lift?.gamma, 1.8);
  assert.ok(lift!.meanLumaAfter < 72);
});

// --- naming
check("show slug", () => assert.equal(showSlug("The Show Title"), "the-show-title"));
check("filename uses the scene start, rounded down", () =>
  assert.equal(thumbnailFilename("The Show Title", 1, 103.9), "the-show-title_scene_01_01m43s.jpg"));
check("minutes keep counting past 59", () =>
  assert.equal(thumbnailFilename("x", 14, 85 * 60 + 20), "x_scene_14_85m20s.jpg"));
check("filenames match the QC pattern", () =>
  assert.match(thumbnailFilename("Café & Co.", 3, 5), THUMBNAIL_FILENAME_PATTERN));

// --- Step 6 / 6b
const cand = (
  time: number,
  subject: string,
  over: Partial<BalanceCandidate["scores"]> = {},
  attrs: Partial<BalanceCandidate["attrs"]> = {},
): BalanceCandidate => ({
  time,
  scores: { face_emotion: 4, reads_small: 4, focal_point: 4, character: 3, title_tie: 4, tone: 4, crop_16x9: 4, eye_contact: 0, ...over },
  attrs: { subject, look: `${subject} look`, setting: `set ${time}`, shot: "close-up", emotion: `e${time}`, source: "cast", gender: "unknown", ...attrs },
});
check("weighted total", () => assert.equal(baseTotal(cand(0, "A").scores), 4 * 3 + 4 * 2 + 4 * 2 + 3 + 4 * 2 + 4 + 4 * 2));

check("the lead is capped at 30% of the set", () => {
  const scenes: BalanceScene[] = Array.from({ length: 10 }, (_, i) => ({
    sceneNumber: i + 1,
    candidates: [cand(i, "LEAD", { face_emotion: 5 }), cand(i + 0.5, `S${i}`)],
  }));
  const r = balanceSet(scenes);
  const leads = r.choice.filter((c, i) => scenes[i].candidates[c].attrs.subject === "LEAD").length;
  assert.ok(leads <= 3, `lead in ${leads} of 10`);
  assert.ok(!r.capsBroken.some((b) => b.cap === "subject_share"));
});
check("never swaps to a weak face to balance", () => {
  const scenes: BalanceScene[] = Array.from({ length: 4 }, (_, i) => ({
    sceneNumber: i + 1,
    candidates: [cand(i, "LEAD"), cand(i + 0.5, `S${i}`, { face_emotion: 2 })],
  }));
  const r = balanceSet(scenes);
  assert.ok(r.choice.every((c) => c === 0), "weak alternatives are never used");
  assert.ok(r.capsBroken.length > 0, "the unmet cap is reported");
});
check("no three in a row of one setting", () => {
  const scenes: BalanceScene[] = Array.from({ length: 3 }, (_, i) => ({
    sceneNumber: i + 1,
    candidates: [cand(i, `S${i}`, {}, { setting: "office" }), cand(i + 0.5, `T${i}`, { tone: 3 }, { setting: `street ${i}` })],
  }));
  const breaks = capBreaks(scenes, scenes.map((s) => s.candidates[0]));
  assert.ok(breaks.some((b) => b.cap === "setting_run"));
  const r = balanceSet(scenes);
  const after = capBreaks(scenes, r.choice.map((c, i) => scenes[i].candidates[c]));
  assert.ok(!after.some((b) => b.cap === "setting_run"), JSON.stringify(after));
});
check("runner-up is the best alternative", () => {
  const scenes: BalanceScene[] = [{ sceneNumber: 1, candidates: [cand(0, "A"), cand(1, "B", { tone: 3 }), cand(2, "C", { tone: 1 })] }];
  const r = balanceSet(scenes);
  assert.equal(r.runnerUp[0], 1);
});
check("single presenter is detected from face clusters", () => {
  const scenes: BalanceScene[] = Array.from({ length: 6 }, (_, i) => ({
    sceneNumber: i + 1,
    candidates: [cand(i, "HOST", {}, { source: "presenter" }), cand(i + 0.5, `B${i}`, {}, { source: "other_material" })],
  }));
  assert.ok(isSinglePresenter(scenes));
  const r = balanceSet(scenes, { singlePresenter: true });
  const hosts = r.choice.filter((c, i) => scenes[i].candidates[c].attrs.source === "presenter").length;
  assert.ok(hosts <= 2, `presenter in ${hosts} of 6`);
});
check("summary records counts and the gender note", () => {
  const chosen = [cand(0, "A"), cand(1, "A"), cand(2, "B")];
  const s = summarizeSet(chosen, { capsBroken: [], passes: 1, swaps: [] }, false);
  assert.equal(s.subject_counts.A, 2);
  assert.equal(s.longest_same_subject_run, 2);
  assert.match(s.gender_note, /cast list/);
});

// --- export files (selection log, contact sheet, fields, notes)
import("../utils/thumbnail-export-files").then(async (files) => {
  const { judgeCandidates } = await import("../services/thumbnails/pick");
  const { buildExportPackageLayout, localizeExportMetadataDocument } = await import("../utils/exportPackageLayout");
  const judged = judgeCandidates(
    {
      brief: { spoiler_sensitivity: "High", turn_time: 20 },
      candidates: [
        { n: 1, usable: true, face_count: 1, eyes_open: true, scores: { face_emotion: 5, crop_16x9: 4 }, subject: "man in grey coat", emotion: "Shock", face: { x: 0.3, y: 0.4 } },
        { n: 2, usable: true, face_count: 1, eyes_open: true, scores: { face_emotion: 5 } },
        { n: 3, usable: true, face_count: 1, burned_text: true },
        { n: 4, usable: true, face_count: 0, source: "cast" },
        { n: 5, usable: true, face_count: 1, unsafe: true },
        { n: 6, usable: true, face_count: 0, source: "other_material", scores: { face_emotion: 4 } },
      ],
    },
    [10, 25, 11, 12, 13, 14],
    ["k1", "k2", "k3", "k4", "k5", "k6"],
  );
  check("frames after the turn of a High scene are rejected", () =>
    assert.ok(judged.rejected.some((r) => r.time === 25 && /turn/.test(r.reason))));
  check("burned-in text, no face and content limits are rejected", () => {
    const reasons = judged.rejected.map((r) => r.reason);
    assert.ok(reasons.includes("burned-in text") && reasons.includes("no usable face") && reasons.includes("content limits"));
  });
  check("faceless other material survives for the set pass to judge", () =>
    assert.ok(judged.ranked.some((c) => c.time === 14 && c.attrs.source === "other_material")));
  check("gender is never inferred", () => assert.ok(judged.ranked.every((c) => c.attrs.gender === "unknown")));
  check("best candidate first", () => assert.equal(judged.ranked[0].time, 10));

  const pick = {
    version: 2,
    contentHash: "h",
    brief: { emotion: "shock", spoiler_sensitivity: "High" as const, title_line: null, title_line_time: null, turn_time: 20 },
    candidates: judged.ranked,
    chosen: 0,
    runnerUp: 1,
    pulled: 40,
    scored: 6,
    rejected: judged.rejected,
    flags: ["lanczos 1.88x (over 1.5x; Real-ESRGAN not available in this build)"],
    rationale: "Reaction before the reveal.",
    exported: { time: 10, crop: { x: 0, y: 0, width: 1024, height: 576 }, frameWidth: 1024, frameHeight: 576, sarCorrected: false,
      upscale: { method: "lanczos", factor: 1.88, source_crop: "1024x576", sar_corrected: false }, brightness: null },
    variety: 4,
  };
  const scenes = [
    { sceneNumber: 1, title: "A <b>bold</b> title", filename: "show_scene_01_00m10s.jpg", pick, runnerUpFile: "review/x.jpg" },
    { sceneNumber: 2, title: "Legacy", filename: "show_scene_02_01m00s.jpg", pick: undefined },
  ];
  const log = files.buildSelectionLog(scenes, undefined) as Array<Record<string, unknown>>;
  check("selection log entry follows the runbook schema", () => {
    const e = log[0];
    assert.equal(e.frame_time_source, "00:00:10.000");
    assert.equal(e.runner_up_time, "00:00:14.000");
    assert.ok((e.scores as Record<string, number>).specific >= 1 && (e.scores as Record<string, number>).variety === 4);
    assert.ok(typeof e.weighted_total === "number");
    assert.deepEqual((e.upscale as Record<string, unknown>).method, "lanczos");
  });
  check("legacy scenes are flagged in the log", () => assert.match(JSON.stringify(log[1]), /legacy thumbnail/));
  check("log ends with the set summary", () => assert.ok("set_balance" in log[log.length - 1]));
  check("compact_thumbnail fields with the CDN placeholder", () =>
    assert.deepEqual(files.compactThumbnail("x_scene_01_00m10s.jpg"), {
      filename: "x_scene_01_00m10s.jpg",
      resolution: "1920x1080",
      timestamp_link: "https://[cdn-path]/x_scene_01_00m10s.jpg",
    }));
  check("notes say placeholder, flags and no review yet", () => {
    const notes = files.thumbnailNotes(scenes);
    assert.match(notes, /placeholders/);
    assert.match(notes, /2 scenes flagged/);
    assert.match(notes, /Not yet reviewed/);
  });
  check("contact sheet escapes titles and lists flagged scenes first", () => {
    const html = files.buildContactSheetHtml({ showName: "Show", scenes, set: undefined });
    assert.ok(html.includes("A &lt;b&gt;bold&lt;/b&gt; title"));
    assert.ok(html.indexOf("show_scene_01") < html.indexOf("show_scene_02") || html.indexOf("Legacy") > 0);
    assert.ok(html.includes('src="review/x.jpg"'));
  });
  const layout = buildExportPackageLayout({
    projectTitle: "My Show",
    showName: "The Show Title",
    scenes: [{ segmentId: "a", title: "One", sceneNumber: 1, startTime: 103.4 }],
  });
  check("package uses runbook names in a thumbnails folder", () => {
    assert.equal(layout.scenes[0].thumbnailFilename, "the-show-title_scene_01_01m43s.jpg");
    assert.equal(layout.scenes[0].thumbnailPath, "My Show/thumbnails/the-show-title_scene_01_01m43s.jpg");
  });
  check("metadata JSON points at the thumbnails folder", () => {
    const doc = localizeExportMetadataDocument({ scenes: [{ segmentId: "a", thumbnailUrl: "https://x" }] }, layout, {
      includePoster: false,
      includeThumbnails: true,
    });
    assert.equal(doc.scenes[0].thumbnailUrl, "thumbnails/the-show-title_scene_01_01m43s.jpg");
  });
  console.log(`thumbnail-math: ${checks} checks passed`);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
