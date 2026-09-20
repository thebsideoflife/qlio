# Shot-hold framing R&D — findings, 18 Sep 2026

> **Read "Third pass: after human review round 1" (at the end) first**, then "Where this stands".
> The first- and second-pass sections are kept as the record of what was believed at the time;
> several numbers and one claim ("no missed cuts") were superseded the same day.

Local research only. Nothing here touches DynamoDB, S3, or a deployed path. Asset
`64b4881a-…` (Nashville, Lionsgate Cut 081926), 60,991 frames at 23.976 fps, 26 stored segments.

## Run it

```bash
cd experiments/shot-hold
.venv/bin/python review/server.py        # http://localhost:8765
.venv/bin/python -m eval.labels_report   # after reviewing: approve rates, deny reasons, corrections
```

Caches live in `/tmp/shothold` (master, 360p proxy, features, faces, shots, crops, job output, stills).
Everything downstream of the proxy re-runs in seconds:

```bash
.venv/bin/python -m crop.policy
.venv/bin/python -m shothold.run_job --crops subject-v3 --zoom-lambda 2 --loose-cost 4 --hold-through
.venv/bin/python -m eval.score --hold-through --zoom-lambda 2 --loose-cost 4
.venv/bin/python -m review.make_batch crop --method subject-v3 --job subject-v3.l2.0c4.0h --n 24 --tag r2 --seed 2
```

## What changed about the problem

The spec assumed the stored Nashville track is over-cut relative to camera shots, so
"one hold per shot" would mean fewer holds. The numbers say otherwise.

| | count inside the 26 segments |
|---|---:|
| Stored framing holds | 351 |
| Camera shots (our clock) | 848 |
| Camera shots (PySceneDetect adaptive, independent) | 800 |

Nashville is cut fast: the median shot is about 2.2 s. In the human-framed segments the editors
already reframed on nearly every shot (s4: 42 holds, 47 shots; s7: 13 and 13; s3: 31 and 37). In
the Gemini-capped segments the track is badly under-framed (s13: 4 holds for 56 shots).

So "too choppy" is not a hold-count problem. Three things in the stored track are visibly wrong,
and each is measurable:

1. **Reframes land near cuts, not on them.** All 326 interior stored keyframes sit on a 0.1 s grid
   (2.4 frames). Of 296 human keyframes, 96 land within half a frame of the true cut; 146 more are
   one to one-and-a-half frames off. Each of those shows a frame of the new shot in the old crop,
   or the reverse. That reads as a stutter on every cut.
2. **Reframes land mid-shot.** 31 human and 21 of 30 Gemini keyframes are more than half a second
   from any cut. Those are crop jumps inside a continuous picture.
3. **Zoom changes move the letterbox.** 87 of the 326 stored changes alter zoom. A pan on a camera
   cut is invisible because the whole picture changes anyway. A zoom change is not: the bars move.

The model I now work to:

- **Clock** gives exact cut frames. Any reframe happens on frame N of a cut, never elsewhere.
- **Pan is per shot and free.** Re-aim on every cut if the subject moved.
- **Zoom is per segment and expensive.** Pick zoom for the whole segment at once, with an explicit
  price per zoom change. That price (`--zoom-lambda`) is the "less choppy" knob.
- Hold count is an output, not a target.

## Clock — reliable

`hist-adaptive-v1` (luma difference + HSV histogram distance on the 360p proxy, local-ratio test
against the median of ±12 frames, flash rejection). One decode, 92 s for features, deterministic
(same cuts on re-run, sha1 `8e5fa3f12f5e`).

| check | result |
|---|---|
| Cuts found | 882 (881 hard, 1 dissolve) |
| Agreement with PySceneDetect adaptive, ±2 frames | 813 of 837 of theirs |
| Agreement with PySceneDetect content | 830 of 875 |
| Fixed-threshold `ffmpeg scene>0.3` | 542 cuts; finds 0, 1 and 2 cuts in three dark segments where adaptive methods find 31–38. A fixed threshold fails in dark scenes. |
| Self-flagged suspicious (same picture both sides) | 21 of 881, mostly stage-light changes in concert scenes |
| Miss candidates in the 33 shots over 8 s | 0 pass the miss test (SUPERSEDED: a 40-frame dissolve inside one of these shots was missed by every detector; see second pass) |
| Face-layout "teleports" inside a shot (independent miss probe) | 19 found, all 19 visually confirmed as motion, 0 missed cuts |

**I-frames are not camera cuts.** 886 I-frames; 684 (77%) coincide with a consensus cut, 202 do
not. Of 838 consensus cuts, 152 (18%) have no I-frame. Max GOP is 250 but only 8 non-cut I-frames
sit at the cap: the encoder's own scene-cut heuristic fires on flashes and motion. Used as a clock,
I-frames would give about one false reframe in four and miss about one cut in five.

**False cuts are cheap, missed cuts are not.** If the clock splits one shot in two, both halves get
the same crop and the job layer writes no keyframe (72 of 882 cuts, including 9 of the 21
suspicious ones, produce no crop change). A missed cut leaves a whole shot in the wrong crop. Tune
the clock for recall.

Not reliable yet: the end-credits region (frames 59,300–59,760) and cuts less than 6 frames apart.

## Crop — promising, needs eyes

Faces: YuNet on the proxy at 4 fps, 92 s, deterministic. 10.5% of samples have no face, 36% have
two or more. A 24-frame check against 720p found one missed face in 12 empty frames.

**Who is the subject.** I mined weak labels from the stored human crops: 98 shots with two or more
comparable faces where the stored crop contains exactly one of them
(`labels/weak_subject_from_stored.jsonl`).

| cue | picks the human's subject | on the 76 where the human actively panned |
|---|---:|---:|
| chance | 46% | |
| largest face | 46% | 40% |
| mouth-minus-eyes motion (no audio) | 45% | 45% |
| most central face | 75% | 67% |

Largest-face is at chance because over-the-shoulder coverage makes the wrong person biggest. The
pixel-only mouth signal carries nothing (it correlates 0.83 with head motion). `subject-v3` uses
the most central persistent face among faces at least half the height of the biggest one (the 0.5
gate is the best of a 0–1 sweep on the weak labels: 75.5%; gates above 0.6 fall towards chance).
Expect it to be wrong on roughly one multi-face shot in four; one spot-checked dispute card showed
a large foreground subject losing to a small central background face before the gate was raised.

**Policy (`subject-v3`)**: 9:16 on the subject; include a second face of comparable size only if
both fit at 9:16 or 3:4; otherwise keep the central one. Widen for the subject's own travel, never
past 1:1. No face: centred, and the zoom is inherited from the neighbours. Zoom only takes three
values (9:16, 3:4, 1:1) so the bars have three positions.

**Job layer** (`shothold/job.py`): Viterbi over the segment's shots, cost = clipped subject +
wasted width + `lambda` per zoom change. Hold through a cut when the current window already
contains the new subject. Every keyframe resolves to its cut frame under `frameIndex`
(asserted); segment bounds are copied, never written (checked: identical).

| job config (subject-v3) | holds | zoom changes | 9:16 share of time | subject clipped |
|---|---:|---:|---:|---:|
| stored Nashville track | 351 | 87 | 62% | n/a |
| per-shot, no smoothing | 774 | 373 | 59% | 26 s |
| **lambda 2, loose 4 (default)** | 669 | 97 | 63% | 107 s of 2,341 |
| lambda 4, loose 4 | 651 | 46 | 55% | 146 s |

The default matches the stored track's zoom-change count and 9:16 share, with all 643 interior
reframes on exact cut frames and none mid-shot. Against the 972 seconds where a human actively
panned, mean crop IoU is 0.58 (68% of seconds at IoU ≥ 0.5) versus 0.40 (36%) for today's
`focusX = 0.5`.

What I cannot certify: whether 3:4 is the right "slightly wider", whether no-face shots should be
centred, whether `lambda` 2 feels smooth, and whether the central-face rule holds outside drama.
That is what the review batches are for.

## Review batches waiting (first pass; superseded by the list in "Where this stands")

| batch | cards | question |
|---|---:|---|
| Clip A/B | 3 | Watch stored (left) vs proposed (right) for s3 (human-dense), s12 (Gemini-capped), s8. Is the proposal smoother? An orange border flashes on every crop change. |
| Crop · subject disputes | 16 | Shots where largest-face and central-face disagree. Settles the subject rule. |
| Crop · stratified | 24 | Even sample over policy branches: single, travel-widened, two-fit, two-don't-fit, no-face. |
| Cut | 30 | 10 consensus cuts, 10 only-ours, 6 only-others, suspicious, miss candidates. |

Click a still to correct the crop centre; `[` `]` change zoom. Each judgment appends one line to
`labels/labels.jsonl` with the input pointer (asset, source frames), proposal, verdict, reasons,
correction, notes, method and version. Stills are regenerable from the pointers.

## Not done

- No VLM was used. No OpenRouter key was available in the environment, and nothing so far needed one.
  The place it would help is the subject disputes, as a JSON "which person" classifier on a still.
- Audio. Active-speaker needs the audio track; pixel-only mouth motion does not work.
- Intra-shot subject exit (spec open question 3) is handled only by widening at shot open.
- Second asset: see the generalisation note below if present.

## Generalisation: second asset (does NOT transfer cleanly)

`3240330b-…` "OPREPO8_3" (Operation Repo): handheld reality show, 21.9 min, 29.97 fps, 720x480 at
roughly 4:3. Same code, no parameter changes, cache in `/tmp/shothold-b`.

| | Nashville (drama) | Operation Repo (reality) |
|---|---:|---:|
| Our cuts | 882 | 611 (27.9 shots per minute) |
| PySceneDetect-adaptive cuts we also find | 813 of 837 (97%) | 438 of 456 (96%) |
| Our cuts PySceneDetect-adaptive also finds | 92% | 72% |
| Cuts only we find, spot check | mostly stage-light changes | 0 of 6 real: CG titles, whip pans, glitch effects, lower thirds |
| Cuts both PySceneDetect methods find and we lack | 8, mostly flashes | 5, and 5 of 5 were real (next to glitch or blur transitions) |
| I-frames that are cuts | 77% | 30% (fixed 29-frame GOP) |
| Sampled frames with no face | 10.5% | 36.8% |
| Shots with no face track | 92 of 883 | 294 of 612 |

What this says:

- The I-frame result generalises and gets stronger: on a fixed-GOP encode 70% of I-frames are not cuts.
- Recall against an independent detector holds (96%), but our extra cuts on graphics-heavy,
  effects-heavy footage are false, and the flash-rejection rule eats real cuts that sit next to
  glitch transitions. Because false cuts are nearly free in this design and missed cuts are not,
  the safer clock for unknown content is the UNION of ours and PySceneDetect-adaptive, with the
  job layer absorbing the extras. That is untested.
- The crop layer is face-driven and half the shots in this show have no face. The no-face fallback
  (centred, inherited zoom) would carry half the episode. That needs a non-face subject signal
  (saliency or a person/body detector) before it is useful on reality or documentary footage.
- `shothold/geometry.py` hardcodes a 16:9 source. The policy mix on this 4:3 asset is not meaningful
  until source aspect is a parameter.

The second-asset agent also parameterised `clock/*.py` and `crop/face_cache.py` on `SHOTHOLD_CACHE`
and probed fps and frame count instead of hardcoding Nashville's. Nashville outputs were not re-generated
after that change.

## Second pass (same day): self-evaluation before human review

Caution from Coleman: some of the stored Nashville framing is bad. Everything below that leans on the
stored track is marked as a weak reference, and each decision has a justification that does not
depend on it.

### The first containment metric was circular. The honest one is worse.

`subject_inside_pct` (98.7%) followed the policy's own face track, and the tracker silently dropped
fast movers, so it graded its own homework. Two independent checks replaced it:

- **Subagent visual pre-screen** of 40 face shots and 24 no-face shots not in the human batches
  (`/tmp/shothold/eval/prescreen/`): 25 of 40 OK; 6 clipped, 4 empty, 4 too wide, 1 wrong person.
  8 of the 11 clipped/empty failures were motion inside the shot, 7 of them on the closing still.
  3 of the 4 too-wide shots were widened by job smoothing, not by their own proposal. One shot
  contained an undetected cut.
- **`eval/frame_containment.py`**: subject defined per frame, no tracker. 11.4% of frames had the
  subject more than a quarter outside the window, 15% in the last third of shots.

| branch | share of frames | subject >25% outside |
|---|---:|---:|
| two or more comparable faces that do not fit: kept one | 33% | 20% |
| subject travel | 27% | 3% |
| single subject | 34% | 2% |
| faces fit together | 4% | 3% |

Where it fails is the two-person shot that cannot hold both people. That is a third of the footage
and it is a product decision (who do we keep, or do we go wide), not a tuning problem.

### Widening buys almost nothing here

| widen tolerance | 9:16 share of time | zoom changes | frames with subject outside |
|---|---:|---:|---:|
| 1.0 (widen whenever the extent overhangs) | 68% | 83 | 10.5% |
| **1.25 (new default)** | 85% | 64 | 11.4% |
| 1.5 | 96% | 26 | 12.5% |
| never widen | 100% | 0 | 13.5% |

Going from "widen freely" to "never widen" costs 3 points of containment and removes every zoom
change. The failures are about which person, not how wide. This stands on its own. As a weak
reference only: the human editors held 9:16 on 81% of shots, including 88% of the shots my first
policy widened for travel; my widening decisions barely correlated with theirs (caught 7 of their
52 wide shots). Both variants are rendered as A/B clips so a person decides.

### Changes made (crop-v4.2, job-v1)

- Tracker tolerates motion (centre may move 0.15 of width per 0.25 s if face size is consistent).
- Travel extent uses the 10th to 90th percentile of box edges, not min and max.
- `widen_tolerance` 1.25; the extent handed to the job layer is what the shot committed to keeping,
  so smoothing cannot re-widen it.
- Smoothing may loosen a shot by one zoom stop at most (a close-up can never become 1:1).
- Source aspect is a parameter (`SHOTHOLD_SOURCE_ASPECT`); zoom stops derive from it.
- New 12-card batch of **risky holds**: shots where subject-sized faces the tracker dropped fall
  outside the window (87 of 832 shots, 10.5%).

### Tried and rejected

- **No-face fallback from motion or detail centroids** on the 18x32 thumbnails. Against the 24
  pre-screened no-face shots it moved the window off correct centred shots and did not fix the
  wrong ones. No-face stays centred. It needs a person or saliency model.
- **Framing as a missed-cut detector** (face "teleports"): 19 candidates, all motion.

### Stability

Crops from two disjoint 2 fps face samplings agree (IoU >= 0.8) on 78% of shots; zoom differed on
about 100 of 883. Decisions near a zoom-stop boundary flip with sampling. Output is deterministic
for a fixed sampling, but this is sensitivity worth knowing: fewer widenings (tolerance 1.25) also
means fewer knife-edge zoom decisions. Re-measured below.

### The subject rule, re-checked for fragility

Most-central beats largest-face in 12 of 17 segments, and on the 51 shots where the two cues
disagree the stored human crop sided with central 38 times and largest 9. It is not driven by one
segment. It is still learned from a track that contains bad framing, so the 16-card dispute batch is
the arbiter, not this table.

### Clock, second pass

- **A missed cut that no detector found.** The pre-screen agent saw two setups inside one 9 s
  "shot" (frames 59,135 to 59,355). It is a 40-frame cross-dissolve. Ours, both PySceneDetect
  detectors and ffmpeg all miss it, and my earlier "0 missed cuts" claim was wrong: the miss probes
  only looked for hard cuts. `clock/dissolve.py` (stable A, smooth change, stable B, A unrelated to
  B, no persistent face across it) finds 4 on Nashville: 2 real dissolves, 1 fade-in from black,
  1 false (an occluder crossing frame). A face-continuity test removed a fifth false one. This is
  the one place where framing data usefully corrects the clock. A false soft cut is NOT free (it
  splits a moving shot and causes a mid-shot reframe), so dissolves are proposed for review, not
  merged into the clock. 0 found on the reality-show asset.
- **Detector v2** (`python clock/detect.py ours2`): additive margin when the background is busy,
  reject weak candidates that change under 35% of the picture (lower thirds, titles), land on the
  end of a transition effect. Reality show: both-PySceneDetect misses 5 to 2, ours-only 85 to 74;
  visual check 8 of 8 removals correct, 6 of 8 additions correct. Nashville: neutral (10 of 16
  checked changes correct, 2 wrong). Not clearly better, so Nashville review material stays on v1.1.
- **Union clock** (v2 plus PySceneDetect-adaptive): Nashville 897 cuts vs 882. Through the job
  layer that is 670 holds vs 670. Measured confirmation that extra hard cuts are nearly free, so
  the union is the recommended default for unknown content.
- Cut-frame exactness: 813 of 814 cuts shared with PySceneDetect-adaptive are on the identical
  frame; 12 of 12 eyeballed cuts had N as the first new frame. On the reality show 119 of 605 cuts
  are multi-frame blends, where "the" cut frame is ambiguous by a frame or two.

## Where this stands

Default job `subject-v3.l2.0c4.0h` (crop-v4.2): 670 holds, 644 interior reframes, all on cut
frames, 64 zoom changes, 85% of time at 9:16. Variant `...always916`: 0 zoom changes.

| claim | status | evidence that does not depend on the stored track |
|---|---|---|
| Hard-cut clock is exact and deterministic on drama | reliable | two independent detectors agree on 97%, same frame on 813 of 814, identical re-runs |
| I-frames are not a clock | reliable | 23% (drama) and 70% (reality) of I-frames are not cuts |
| Extra cuts are nearly free, missed cuts are not | reliable | +15 cuts changes 0 holds; one missed dissolve put a wide crop on a close-up for 5 s |
| Fixed thresholds fail in dark scenes | reliable | ffmpeg scene 0.3 finds 0 to 2 cuts where adaptive methods find 31 to 38 |
| Reframe only on cut frames; zoom is the expensive change | sound by construction | asserted in the job layer and tests |
| Widening rarely helps on this show | supported | never widening costs 3 points of containment and removes all zoom changes |
| Most-central face is the subject | weakly supported | learned from stored crops (some bad); consistent in 12 of 17 segments; pre-screen saw 1 wrong-person in 40 |
| Two people who do not fit: keep one | unresolved | 33% of frames, 20% of them lose the per-frame subject; product decision |
| A static hold keeps a moving subject | not reliable | 7 of 40 pre-screened shots lose the subject by the closing still |
| No-face shots centred | not reliable | wrong in about 5 of 24; cheap pixel fallbacks made it worse |
| Long dissolves | partly | 3 of 4 proposals real on one asset; tiny sample |
| Transfers beyond single-camera drama | no | reality show: 48% of shots have no face, clock needed new rules, source was 4:3 |

Review material now queued (90 cards, about 20 minutes; start at the top):

| batch | cards | question |
|---|---:|---|
| Clip A/B, default | 2 | stored (left) vs proposed (right), segments s3 and s12 |
| Clip A/B, always 9:16 | 2 | same segments, never widening. Is any widening worth it? |
| Crop: subject disputes | 16 | largest face vs most central face |
| Crop: risky holds | 12 | shots where a subject-sized face leaves the window |
| Crop: stratified | 24 | even sample over policy branches |
| Cut | 32 | includes the 4 dissolve proposals |

If a stored Nashville crop on a card is itself bad, say so in the note ("stored is wrong"): that
tells me which segments to stop using as a reference.

## Third pass: after human review round 1

85 cards judged (`labels/labels.jsonl`). Nothing below touches the reviewed v1 outputs in `/tmp/shothold`:
new runs live in `/tmp/shothold-v1b` (v1 clock, new crop code) and `/tmp/shothold-v3` (new clock).

### Reading the labels

- **Clips 4 of 4 approved**, default and always-9:16. Nothing to change at the segment level.
- **Cut cards cannot be read as approve rates.** Round-1 cards used two wordings (hard cuts:
  Approve = "this is a cut"; miss candidates: Approve = "the clock is right that there is NO cut").
  The stills show the reviewer answered "is this a cut?" on every card: 16243 is an obvious cut and
  was Approved; 869, 7546, 21046, 47965 are one continuous shot and were Denied; 52720, 53051, 59687
  are lightning or photo flashes and were Denied. So the 6 denied miss candidates mean **the clock was
  right on all 6**, not 6 missed cuts. `eval/clock_labels.py` scores clocks on that reading (13710 excluded:
  its four stills are blank white). Round-2 cut cards all ask the same question.
- **All 8 denied suspicious / hist-only cuts are the same composition under a light change** (concert
  spotlights, gain shifts in "I Can Hear Them Playing"). The one approved suspicious cut is a real cut
  between two aerials.
- **Crop: 13 denials, by cause** (from notes plus 8-frame strips of each held shot, `eval/split_probe.py`):

  | cause | cards | what fixes it |
  |---|---|---|
  | wrong subject: the crop kept a face the lens threw out of focus | 3 (25532, 46732, 17710) | focus cue (below) |
  | subject walks or stands out of a static window in one long shot | 3 (20806, 53870, 53672) | exit split, 1 of 3 |
  | clock miss: whip-blur cut (3830), 35 s cross-dissolve montage (55648-56479) | 2 | exit split, partly |
  | 1-2 s action shot: the face stays in the window, the action (fight, turn, second person) does not | 3 (52240, 34972, 52344) | nothing here; needs a body signal or a wider stop |
  | unexplained / probable misclick (33692 denied with note "fine") | 2 | none |

  Only 1 of the 12 "should have been split" holds contains a cut any detector finds (3830,
  PySceneDetect-content only). "Split" mostly means "the subject moved", not "you missed a cut".
- The reviewer never nudged zoom (`[` `]`), though 5 notes say "or zoom out". The 17 corrections are pan only.

### Clock: `clock-v3` = union clock minus a lighting veto (`clock/clock_v3.py`)

`clock/struct_features.py` (one more 90 s proxy pass) measures whether two frames share the same
**gradient field**: edge direction, not edge strength, contrast-normalised. A light change keeps it and a camera
cut does not. A candidate is vetoed only if all three consecutive pairs around it stay alike (similarity > 0.6), so an
off-by-one cut frame cannot veto a real cut.

| | similarity across the cut |
|---|---|
| 8 human-denied lighting cuts | 0.72 to 0.86 |
| 799 three-detector consensus cuts | median 0.27, 99.5th pct 0.41; one at 0.89 (2949), itself a light change |
| human-approved real cuts | 0.18 to 0.41 |

All 69 candidates the veto removes across v1, v2, both PySceneDetect detectors and the union were checked by eye:
69 of 69 are the same shot (spotlights, candle flicker, lightning, press flashes in the finale, a title lighting up).
clock-v3 also merges `clock/dissolve.py` (reviewer: 3 of 4 proposals are real dissolves).

| clock (`python -m eval.clock_labels`) | cuts | human-labelled cuts found | labelled non-cuts kept |
|---|---:|---:|---:|
| hist-adaptive-v1 (reviewed) | 882 | 7 of 12 | 8 of 18 |
| union-v1 | 897 | 8 of 12 | 5 of 18 |
| **clock-v3** | 856 | **11 of 12** | 3 of 18 |

Still missed: 3830 (whip-blur; only PySceneDetect-content has it, and adding that detector brings 28 extra
candidates past the veto, about 25 of them motion inside one shot, including two human-labelled non-cuts). Still
kept: 53051 (lightning through a rainy windscreen), 24049 (the denied dissolve), 59039 (2 frames from the
approved dissolve 59041; the two labels agree, the hard-cut tolerance does not). The montage at 55648 is not
found by any clock. Through the job layer clock-v3 changes little: 668 vs 670 holds.

### Crop: `subject-v4` = central face, unless a comparable face is 3x sharper (`crop/face_sharpness.py`)

Per-face focus = Laplacian energy of the inner face (48x48, contrast-normalised), one 60 s proxy pass over
frames with two or more faces. Drama marks its subject with focus.

| subject rule | weak labels (94, stored human crops) | reviewed wrong-subject cards fixed | distance from the reviewer's 17 corrections (median crop centre) |
|---|---:|---:|---:|
| most central (v3) | 79% | 0 of 3 | 0.100 |
| sharpest face alone | 54% | | |
| **central unless a rival is 3x sharper and detector score ≥ 0.8 (v4)** | **83%** | **3 of 3** | **0.081** |

It switches the subject on 24 of 334 multi-face shots. By eye on those: about 13 clearly better (a sharp speaker
over a soft foreground shoulder), 10 unclear, 1 wrong (a sharp false face on decor at 4039, removed by the detector-score
guard). `eval.frame_containment` scores v4 slightly *worse* (11.4% → 12.3%) because it defines the subject as the
most central face. It cannot judge a rule that overrides centrality, so the review cards decide this one.

### Job: exit split, pan-only second hold inside one shot (`crop/exit_split.py`, `job-v1` + `tied`)

The reviewer answered spec open question 3: when the subject leaves, they want a new hold. Narrow version:
follow **the shot's own subject** (seeded where the policy chose it, then nearest face each 0.25 s, jump ≤ 0.2
of the frame width) and split into at most 3 pieces of ≥ 1 s when that removes ≥ 3 samples with the face >25% outside. Pan
only: split frames are written as `tied`, and the Viterbi cannot change zoom across them, so the letterbox never
moves mid-shot (asserted in `eval/job_summary.py`, tested). The new hold starts on the frame of largest picture
change between samples, so the jump rides motion.

A first version re-picked "most central face" per sample. It panned A-B-A across approved two-shots
(19391: 0.91 → 0.11 → 0.85). Following the shot's own subject fixed that.

| job (clock-v3) | holds | zoom changes | mid-shot pans | holds < 1 s | 9:16 time | subject >25% outside |
|---|---:|---:|---:|---:|---:|---:|
| subject-v3 (reviewed config, new clock) | 668 | 64 | 0 | 46 | 85% | 11.2% |
| subject-v4 | 679 | 66 | 0 | 50 | 84% | 12.1% |
| **subject-v4 + exit split** | 713 | 66 | 33 | 52 | 84% | 11.1% (last third of shots 14.3% → 12.3%) |

29 shots split. Of the reviewer's notes it catches 53870 (walk-out), the montage 55648 (3 pieces, partly
right), and 3806. 3806 is the lesson: across the missed whip cut, face identity does not carry over, and B lands
on the profile woman instead of the one facing camera. An exit split cannot fully stand in for a missed cut. It
misses 20806 and 43601, where the subject leaves in the last second before a cut, and every 1-2 s action shot. By eye over
all 30 splits of the version just before the ≥ 1 s piece fix (29 remain): about 22 clearly follow a moving subject or rescue a missed transition (55207 singer → man at the door;
58903 across the approved dissolve 59041), a few are small re-centres, no A-B-A flips. Whether a mid-shot pan
reads as smooth or as a jump can only be judged in motion: that is the round-2 clip batch.

### Prove-gates, per layer

| layer | gate | v1 (reviewed) | now |
|---|---|---|---|
| clock | human-labelled cuts found / non-cuts kept | 7 of 12 / 8 of 18 | 11 of 12 / 3 of 18 |
| clock | three-detector consensus cuts vetoed | n/a | 0 real (1 vetoed, itself a light change) |
| crop | wrong-subject denials fixed; distance from corrections | 0 of 3; 0.100 | 3 of 3; 0.081 |
| job | zoom changes mid-shot; keyframes off a cut or split frame | 0; 0 | 0; 0 (asserted) |
| job | round-2 split A/B clips | n/a | pending |

### Review round 2 (32 cards, about 10 minutes)

| batch | cards | question |
|---|---:|---|
| `splitclip-…-r2` | 10 | One shot each. A = one hold, B = pans mid-shot (orange flash). Approve = B is better. |
| `crop-subject-v4…-r2-focus` | 12 | Focus switched the subject (3 are round-1 denials, re-cut with v4). Approve = right person. |
| `cut-clock-v3-r2` | 10 | 8 cuts the union adds, 2 veto controls. Approve = yes, a cut (same wording on every card). |

```bash
cd experiments/shot-hold
.venv/bin/python review/server.py                  # same UI; round-2 batches are listed
.venv/bin/python -m eval.clock_labels              # clock gate
SHOTHOLD_CACHE=/tmp/shothold-v3 .venv/bin/python -m eval.job_summary
# rebuild clock-v3 path from the cache: struct_features, face_sharpness, clock_v3, then in /tmp/shothold-v3:
#   crop.policy; crop.exit_split --crops subject-v4; run_job --crops subject-v4+split --shots shots_split.json ...
```

### What I would do next

1. Read round 2. If the split clips are approved, lower `min_gain` to 2 so the end-of-shot exits (20806, 43601)
   split too. If they are denied, keep one hold and spend the effort on the 3:4 stop for moving shots instead.
2. Short action shots need a person/body box (the face stays in; the action does not). This is also the missing
   no-face signal from the reality-show test. It is a detector choice, not tuning.
3. Whip-blur cuts: a narrow rule (sustained high score then a new stable picture) rather than adding
   PySceneDetect-content wholesale.
4. Not done, and still true: no audio, no VLM, one drama asset. Nothing ships from here.
