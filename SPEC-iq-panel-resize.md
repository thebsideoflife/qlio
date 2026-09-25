# SPEC: Drag-resizable IQ editor panel

## Background

The "IQ editor" is the right-hand sidebar on the Editor page (`zeevee/src/pages/Editor.tsx`),
whose default tab is **IQ** (`IQAgentPanel` — `zeevee/src/components/editor/iq-agent/IQAgentPanel.tsx`).
The sidebar currently has two states only: open at a hard-coded `w-[420px]`, or collapsed to
`w-0`, toggled by a pill button centered on the sidebar's left edge. Long agent threads and
brief controls would benefit from a wider panel; preview-focused work benefits from a narrow one.

## Goal

Make the sidebar width draggable via its left edge, while keeping the existing
expand/collapse toggle behavior.

## UX behavior

1. **Drag handle on the left edge** of the open sidebar: a 6–8px hit area spanning the full
   sidebar height, with `cursor: col-resize` and a subtle hover highlight (blue-500, matching
   existing accent usage). Reuse the existing window-level `mousemove`/`mouseup` drag pattern
   already in `Editor.tsx` (`handleFramingMouseDown` effect) rather than adding a library.
2. **Width constraints:** min **320px**, max **720px** (also clamped to ≤ 60% of viewport width
   so the video area never collapses on small screens). Default stays **420px**.
3. **Drag-to-collapse:** dragging below a collapse threshold (~200px) snaps the sidebar shut,
   identical to the existing toggle (`sidebarOpen = false`). Re-opening restores the previous
   width. The existing pill toggle button keeps working and stays visible when collapsed.
4. **No layout jump:** while dragging, disable the `transition-all duration-200` width
   transition on the sidebar (conditional class), and do not transition on re-open from drag.
5. The tabs (IQ / Captions / Script) and their content reflow naturally; no per-tab changes.

## Persistence

Persist width + open state in `localStorage` under a single JSON key
`zeevee:editorSidebar` (`{ width: number, open: boolean }`), read on mount with a fallback
to defaults. This matches existing conventions (`api_password`, `zeevee:recentAssets`,
favorites keys in `AssetCard.tsx`). Validate/clamp the stored value on read. Do not put this
in Redux — it is local UI chrome, like the current `sidebarOpen` useState.

## Files to change

| File | Change |
|---|---|
| `zeevee/src/pages/Editor.tsx` | All of it: `sidebarWidth` state initialized from localStorage, drag-handle div on the sidebar's left edge (inside the existing `relative flex` wrapper), window mousemove/mouseup effect, width clamping + collapse threshold, conditional transition suppression, persistence write (debounced or on mouseup), replace `w-[420px]` with inline `style={{ width }}`. |

No other files need changes. `IQAgentPanel` and the tab components are already width-agnostic
(flex/min-h-0/overflow-hidden). Tailwind/shadcn has no resizable primitive in
`zeevee/src/components/ui/`, so a hand-rolled handle is consistent with the codebase.

## Acceptance

- Dragging the left edge resizes between 320px and 720px (and ≤ 60vw) live, no transition lag.
- Dragging past ~200px collapses; toggle re-opens at the last width.
- Reload preserves width and open/collapsed state.
- Existing pill toggle, tabs, and framing-drag on the video are unaffected.
