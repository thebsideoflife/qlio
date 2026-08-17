# Editor click-through fixes: adjuster drag bars vs play/pause, word-click seek vs playback state

## Context · persona · why now

- **Product:** zeevee (a.k.a. Qlio) — short-form video editor. Frontend in `zeevee/` (Vite + React 19 + Redux Toolkit + Remotion 4); deploys via Vercel on merge to `main` (human-gated product — agents do not deploy).
- **Repository:** `ColemanIsner/zeevee`.
- **Persona:** a producer fine-tuning framing and scrubbing the transcript in the editor. Two click-through bugs keep breaking their flow:
  1. They grab a **lateral adjuster drag bar** (the left/right or up/down `FramingSlider` pills overlaid on the video preview) and the video **randomly starts/stops playing** on mouse release.
  2. They **click a caption word** in the Script tab to inspect a frame while paused, and the video **starts playing** instead of staying parked on the frame.
- **Why now:** both bugs live in the same event-handling neighborhood of `zeevee/src/pages/Editor.tsx` (video preview click-to-toggle + transcript word clicks) and are small, surgical fixes. This is a **spec-only** document — investigation + change approach, no code in this PR.

## Intent

1. Clicks/drags on the lateral adjusters (`FramingSlider` drag bars) must **never** toggle video play/pause.
2. Clicking a caption word must **seek** the video to that word's timestamp while **preserving playback state**: paused ⇒ seek and remain paused; playing ⇒ seek and remain playing.

---

## Investigation findings

### (a) Where play/pause toggle is attached, and why adjuster clicks bubble into it

**The toggle handler.** `handleVideoClick` in `zeevee/src/pages/Editor.tsx` (line ~466) toggles `video.play()` / `video.pause()` based on `video.paused`. It reaches the DOM in two ways on the **framing container** div (the black preview frame, `framingContainerRef`, rendered around line 545–665):

- **Directly**: `onClick={handleVideoClick}` when `squareTop || displayZoom <= 0` (line ~568–571).
- **Indirectly**: `onClick={handleFramingClick}` when `displayZoom > 0` (normal reframing mode). `handleFramingClick` (line ~350–355) only forwards to `handleVideoClick` when `hasDraggedRef.current === false`.

**The drag guard that doesn't cover the adjusters.** `hasDraggedRef` (line ~289) is the "was this a drag, not a click" latch. It is reset in `handleFramingMouseDown` (line ~293–297) and set in the window-level `mousemove` handler once the pointer moves > 1% of the container (line ~320). **Crucially, it is only ever touched by the container's own drag-to-reposition path.**

**The adjusters.** The lateral adjusters are the two `FramingSlider` components rendered **as children of the clickable framing container** (Editor.tsx line ~637–660):

- `orientation="horizontal"` — the **left/right** bar, absolutely positioned `bottom-3 left-1/2` (`FramingSlider.tsx` line ~68).
- `orientation="vertical"` — the **up/down** bar, `right-3 top-1/2` (rendered for 16:9 alongside the horizontal one).

**Why their clicks leak through.** In `zeevee/src/components/editor/FramingSlider.tsx`:

- The outer wrapper stops **`mousedown`** propagation — `onMouseDown={(e) => e.stopPropagation()}` (line ~71) — so the container's `handleFramingMouseDown` never runs and `hasDraggedRef` stays `false`. The inner track's `handleMouseDown` (line ~30–54) does `e.preventDefault()` and drives `onChange` via window `mousemove`/`mouseup` listeners.
- **Nothing stops `click`.** There is no `onClick` handler anywhere in `FramingSlider`. On mouse release the browser dispatches a `click` on the slider track, which **bubbles up the DOM** to the framing container's `onClick`. Because the container's own mousedown was suppressed, `hasDraggedRef.current` is `false`, so `handleFramingClick` forwards to `handleVideoClick` → **play/pause toggles**. This fires for both a plain click on the bar and the click that follows a drag release.
- **Double-click-to-center has the same leak, twice.** `handleDoubleClick` (line ~56–59) stops `dblclick` propagation, but the two `click` events that precede every `dblclick` still bubble — each toggles play/pause (net-zero state change, but a visible play/pause blip and, when paused, a brief play start).

**Contrast: the zoom column is already immune.** The `ZoomSlider` / Square-Top control column sits **outside** the framing container in a wrapper that stops both `onClick` and `onMouseDown` propagation (Editor.tsx line ~699–700). `FramingSlider` is the only interactive control living *inside* the clickable container, which is why only it suffers the click-through.

**Adjacent observation (not in scope, same bug class):** `CaptionOverlay`'s corner resize handles (`CaptionOverlay.tsx` line ~195–215) stop `mousedown` but not `click`; clicking them also bubbles into the container toggle. Note for a future hardening pass; leave behavior unchanged here.

### (b) Where word clicks trigger seeking, and how playback state is changed today

**Call chain** (all in `zeevee/src/pages/Editor.tsx`):

1. Word `<span>` `onClick={() => !editMode && handleWordClick(word)}` in `TranscriptPanel` (line ~1147). In edit mode the click is a no-op by design (contentEditable owns it).
2. `TranscriptPanel.handleWordClick` (line ~978–987) calls the prop `onWordClick(word.start)`.
3. `Editor.handleWordClick(startTime)` (line ~503–514) does:
   ```ts
   videoRef.current.currentTime = startTime;   // the seek
   const playPromise = videoRef.current.play(); // ← unconditionally forces "playing"
   ```
   The unconditional `play()` is the bug: **a paused video always starts playing on word click.** (The `AbortError`-swallowing `.catch()` mirrors the play/pause toggle's promise handling.)

**Playback-state mechanics that make the fix simple.** Assigning `HTMLMediaElement.currentTime` does **not** by itself change play state: a paused element stays paused on the new frame; a playing element continues after the seek. So preserving state only requires *not* calling `play()` when paused (and defensively re-asserting `play()` when it was playing, in case a browser stalls post-seek).

**Preview-mode interaction (must be preserved).** `useSeamlessPlayback` (`zeevee/src/hooks/useSeamlessPlayback.ts`) runs a RAF that **early-returns while `video.paused || video.seeking`** (line ~22–25) and otherwise skips between segments / pauses at the end of the last segment. Consequences the fix must keep intact:

- Paused word-click seek in preview mode lands on the word's frame and **stays there** (the seamless RAF never yanks a paused video to the next segment).
- Playing word-click seek in preview mode remains subject to seamless segment skipping — unchanged existing behavior.

**Keyboard shortcut precedent.** The Space handler in `Timeline.tsx` (line ~391–407) uses the same `video.paused ? play() : pause()` pattern with identical `AbortError` handling — the proposed fix below follows that established style.

---

## Proposed change approach

### Fix 1 — adjusters swallow their own clicks (`zeevee/src/components/editor/FramingSlider.tsx`)

Add `onClick={(e) => e.stopPropagation()}` to the **outer wrapper div** (the element that already stops `onMouseDown`, line ~71). One line, co-located with the existing propagation guard.

- Why the wrapper, not the track: the wrapper is the component's root, so every click originating anywhere inside the adjuster (track, handle, chevrons, groove) is swallowed before it can reach the framing container — including the two `click`s that precede a double-click.
- Why not fix it in `Editor.tsx` (e.g. target-checking inside `handleFramingClick`, or a global drag-distance latch): more invasive, couples the container to its children's internals, and risks breaking the legitimate click-to-toggle on the video surface. The established repo pattern is "interactive child stops its own propagation" (see the zoom column wrapper, `CaptionOverlay` drag start, `Timeline` controls).
- No change to `handleFramingClick` / `hasDraggedRef` — the container's own drag-to-reposition guard keeps working exactly as today.

### Fix 2 — word click preserves playback state (`zeevee/src/pages/Editor.tsx`, `handleWordClick` line ~503)

Snapshot play state before the seek; only re-assert play when it was playing:

```ts
const handleWordClick = (startTime: number) => {
  const video = videoRef.current;
  if (!video) return;
  const wasPlaying = !video.paused && !video.ended;
  video.currentTime = startTime;
  if (wasPlaying) {
    const playPromise = video.play();
    if (playPromise !== undefined) {
      playPromise.catch((error) => {
        if (error.name !== "AbortError") {
          console.error("Playback error:", error);
        }
      });
    }
  }
};
```

- Paused ⇒ seek lands, element stays paused on the word's frame. Playing ⇒ seek + continue.
- `!video.ended` guard: if the video ran to the end, a word click seeks but does not resurrect playback (ended behaves like paused — the least surprising reading of "preserve playback state").
- No Redux changes (`setCurrentTime` continues to flow from the existing RAF time-sync), no changes to `TranscriptPanel`, `useSeamlessPlayback`, or the edit-mode guard.

## In scope

- `zeevee/src/components/editor/FramingSlider.tsx` — stop click propagation at the component root.
- `zeevee/src/pages/Editor.tsx` — playback-state-preserving `handleWordClick`.
- Manual QA evidence (steps in Verify contract) + repo static checks.

## Out of scope

- `CaptionOverlay` resize-handle click-through (same bug class; noted above for a future pass — do not change here).
- Any change to click-to-toggle play/pause on the video surface itself, drag-to-reposition, `ZoomSlider`, Square-Top toggle, Timeline seeking/scrubbing, or `useSeamlessPlayback` segment skipping.
- Edit-mode word interactions (contentEditable path) — the existing `!editMode` guard stays.
- Backend, Remotion render path, state model, sync middleware — untouched.
- Deploy / merge (human-gated product; PR stays open for the operator).

## Constraints · safety

- **Preserve existing behavior outside these two interactions.** Legit clicks on the video surface must still toggle play/pause; container drag-to-reposition must still not toggle on release (existing `hasDraggedRef` path untouched).
- **Minimal diff:** one added handler in `FramingSlider.tsx`; one restructured handler in `Editor.tsx`. No new state, no new refs, no API/type changes.
- **Style consistency:** reuse the repo's existing `play()`/`AbortError` promise-handling idiom (see `handleVideoClick`, `Timeline.tsx` Space handler).
- **Human gate:** do not merge the PR, do not deploy.

## Acceptance criteria

1. Clicking either lateral adjuster (horizontal left/right bar, vertical up/down bar) does **not** toggle play/pause; the adjuster still sets focus position on press/drag.
2. Dragging an adjuster and releasing does **not** toggle play/pause.
3. Double-click-to-center on an adjuster centers the focus and does **not** toggle play/pause (no play blip).
4. Clicking the video surface (not on an adjuster) still toggles play/pause; drag-to-reposition on the video still does not toggle on release.
5. Word click while **paused**: video seeks to the word's start time and **remains paused** on that frame; transcript highlight, caption overlay, and timeline playhead reflect the new time (existing RAF sync).
6. Word click while **playing**: video seeks and **continues playing**.
7. Word click in **preview mode**: paused ⇒ seek lands and stays paused even when the word is outside all segments (seamless RAF does not yank it); playing ⇒ seamless segment skipping behaves exactly as before.
8. Word click in **edit mode** still does nothing (contentEditable unaffected).
9. `npm run lint`, `npm run build` (`tsc -b && vite build`), and `npm test` pass in `zeevee/`.

## Verify contract (exact commands / probes)

Run from repo root. Paste outputs as evidence.

**Static checks + unit-style scripts — frontend:**
```bash
cd zeevee && npm ci && npm run lint
cd zeevee && npm test        # test:fingerprint + test:agent-thread + test:zoom-math
cd zeevee && npm run build   # tsc -b && vite build
```

**Manual QA probes** (no component-test harness exists for editor interactions; run `cd zeevee && npm run dev`, open a project with transcript + framing zoom > 0):

| # | Setup | Action | Expect |
|---|-------|--------|--------|
| 1 | Video paused, zoom > 0 | Click horizontal adjuster bar | Focus X changes; video stays paused |
| 2 | Video playing, 16:9 | Drag vertical adjuster, release | Focus Y changes; video keeps playing |
| 3 | Video paused | Double-click adjuster | Focus centers; video stays paused (no blip) |
| 4 | Any | Click video surface off-adjuster | Play/pause toggles (unchanged) |
| 5 | Video paused, Script tab | Click a transcript word | Playhead + frame jump to word; still paused |
| 6 | Video playing, Script tab | Click a transcript word | Seeks to word; keeps playing |
| 7 | Preview mode, paused | Click word outside all segments | Seeks, stays paused at that frame |
| 8 | Script tab Edit mode | Click a word | No seek; word editable |

**PR / ship close-out (human gate — do NOT merge or deploy):**
```bash
gh pr view <PR_NUMBER> --repo ColemanIsner/zeevee --json url,mergeable,state,baseRefName,headRefName
```
- Confirm the PR is open into `main`, `mergeable` is not `CONFLICTING`, `state` is `OPEN`. Cite the PR URL. Do not merge; do not deploy.

**Skipped checks** (report explicitly): backend checks — no backend files touched; automated UI tests — none exist for these interactions, manual QA table above stands in.
