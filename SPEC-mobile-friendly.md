# SPEC: Minimal Mobile-Friendly Pass (Zeevee web app)

**Repo:** colemanisner/zeevee — **Branch:** `feature/mobile-friendly`
**Scope:** `zeevee/` frontend only (Vite + React + Tailwind + shadcn/ui). No backend, no infra changes.

## Goal

Make the app *usable* on a phone-sized viewport (≥360px wide): no breakage, readable text,
tappable controls, **no horizontal page overflow**. Desktop remains the primary experience and
must look and behave exactly as it does today.

## Non-goals (explicitly forbidden)

- **No breaking or re-tuning desktop behavior.** All changes must be additive: new `sm:`/`md:`
  overrides, or base styles that only apply below the `sm` (640px) breakpoint. Existing classes
  that produce the current desktop layout stay untouched.
- No redesign, no component restructuring, no new navigation patterns (no bottom-tab bars, no
  drawer rewrites).
- No new dependencies (no `react-responsive`, no CSS frameworks, no gesture libraries).
- No changes to Remotion rendering, export pipeline, or backend calls.
- No reformatting / drive-by cleanup. Small diff, easy review.

## Techniques allowed

1. Tailwind responsive prefixes (`sm:`, `md:`) on existing elements.
2. Base-layer tweaks in `zeevee/src/index.css` (e.g. `overflow-x: hidden` guard on `body`) —
   must be gated so desktop rendering is pixel-identical.
3. Replacing fixed pixel widths with `w-full max-w-[Npx]` **only where the current fixed width
   already equals the desktop max** (e.g. `w-[480px]` → `w-full max-w-[480px]` — identical on
   desktop, flexible on mobile).
4. `viewport` meta — already present in `zeevee/index.html`
   (`width=device-width, initial-scale=1.0`); verify only, no change expected.

## Target pages / components (ranked by user impact)

### 1. `src/components/layout/MainLayout.tsx` (app shell — highest leverage)
- Header (`h-14 sm:h-16`, already partially responsive): ensure the center title block and
  right-side action cluster wrap or truncate gracefully at 360px; hide low-priority header
  items below `sm:` (e.g. `hidden sm:flex`) rather than letting them overflow.
- Any fixed `grid-cols-4` dialog rows (line ~267) → `grid-cols-1 sm:grid-cols-4`.

### 2. `src/pages/Dashboard.tsx`
- Two `w-[480px] shrink-0` blocks (lines ~114, ~138) → `w-full max-w-[480px]`.
- Asset grid `grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4` → `grid-cols-1 sm:grid-cols-2 …`
  so a phone shows one readable card per row.

### 3. `src/pages/Editor.tsx` (most complex — keep changes minimal)
- Root uses `flex h-[calc(100vh-4rem)]` with a `w-[420px]` sidebar (line ~696). On mobile the
  sidebar must not squeeze the video area to zero: make the sidebar `w-full sm:w-[420px]` and
  overlay/stack it below `sm:` (absolute overlay is acceptable; simplest correct option wins).
- Video player area already uses `min-w-0`/`overflow-hidden` — verify only.
- Skeleton layout (line ~416) gets the same sidebar treatment as the real layout.

### 4. `src/components/editor/Timeline.tsx`
- Already `overflow-x-auto` internally (line ~1500) — this is correct; keep it. Just confirm
  the timeline scrolls horizontally *inside its container* and never pushes page width.
- Trim handles (`w-[6px]`, line ~1669) are too small for touch: bump to ~`w-[10px]` **below
  `sm:` only** if achievable with a pure-class change; otherwise skip (nice-to-have, not required).

### 5. `src/pages/SignIn.tsx`, `src/pages/Export.tsx`, modals (`CreateProjectModal.tsx`, `ExportPanel.tsx`, IQ agent panel)
- Verify only: shadcn dialogs/cards generally shrink fine. Fix only if overflow is observed,
  using the same additive-override pattern.

## Global guard

Add to `index.css` base layer (safe, no desktop visual effect):
```css
html, body { overflow-x: hidden; }
```
…only if an actual page-level overflow is observed during testing; otherwise leave CSS untouched.

## Acceptance criteria

- `npm run build` in `zeevee/` passes clean.
- At 375×667 and 360×640 (Chrome DevTools device emulation):
  - No horizontal scrollbar on Dashboard, Editor, SignIn, Export.
  - Header controls reachable; project title truncates instead of overflowing.
  - Dashboard cards stack single-column and remain fully readable.
  - Editor: video visible, timeline scrolls internally, sidebar opens as full-width overlay/section.
- At 1440×900: **pixel-identical to `main`** (visual spot-check of Dashboard + Editor).
- No new dependencies in `package.json`; diff confined to `zeevee/src/**` (+ this spec).

## Verification evidence required

- Build output (exit 0).
- Commit list on `feature/mobile-friendly`.
- PR URL with before/after screenshots (375px and 1440px) for Dashboard and Editor.
