# Shot-hold framing R&D — findings, 18 Sep 2026

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
| Miss candidates in the 33 shots over 8 s | 0 pass the miss test |
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

## Review batches waiting (73 cards, about 15 minutes)

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
