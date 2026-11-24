import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import type { RootState } from "@/store/store";
import {
  addSegment,
  finalizeSegmentEdit,
  selectSegment,
  setTrimTarget,
  updateSegmentTime,
} from "@/store/editorSlice";
import {
  edgeDisplayTime,
  setEdgeTime,
  wordEdgeTime,
  type TrimEdge,
} from "@/lib/trimMath";
import { clipFromWords, scriptClipMarks, wordsInAnyClip } from "@/lib/scriptCuts";
import { SelectionMenuView } from "./ScriptTrim";

interface ScriptWord {
  key: string;
  start: number;
  end: number;
  value: string;
}

interface ClipBounds {
  id: string;
  startTime: number;
  endTime: number;
}

interface SelectionMenu {
  firstKey: string;
  lastKey: string;
  top: number;
  left: number;
}

/**
 * Script-panel side of trimming: where the selected clip's In / Out cuts sit
 * in the text, dragging those markers to another word, and turning a text
 * selection into a clip.
 */
export function useScriptTrim({
  words,
  segments,
  enabled,
  onSeek,
}: {
  words: ScriptWord[];
  segments: ClipBounds[];
  enabled: boolean;
  onSeek: (time: number) => void;
}) {
  const dispatch = useDispatch();
  const selectedId = useSelector((s: RootState) => s.editor.selectedSegmentId);
  const trimTarget = useSelector((s: RootState) => s.editor.trimTarget);
  const fps = useSelector((s: RootState) => s.editor.sourceFps);
  const duration = useSelector((s: RootState) => s.editor.duration);

  const clipId = trimTarget?.segmentId ?? selectedId;
  const clip = enabled ? segments.find((s) => s.id === clipId) ?? null : null;
  const marks = useMemo(() => scriptClipMarks(words, clip, fps), [words, clip, fps]);
  const inAnyClip = useMemo(
    () => (enabled ? wordsInAnyClip(words, segments) : new Set<string>()),
    [enabled, words, segments],
  );
  const wordByKey = useMemo(() => new Map(words.map((w) => [w.key, w])), [words]);

  const latest = useRef({ clip, fps, duration, wordByKey });
  useLayoutEffect(() => {
    latest.current = { clip, fps, duration, wordByKey };
  });

  const trimTo = useCallback(
    (clipBounds: ClipBounds, start: number, end: number, edge: TrimEdge, commit: boolean) => {
      dispatch(updateSegmentTime({ id: clipBounds.id, start, end }));
      if (commit) dispatch(finalizeSegmentEdit());
      onSeek(edgeDisplayTime({ startTime: start, endTime: end }, edge, latest.current.fps));
    },
    [dispatch, onSeek],
  );

  // ---- Dragging a cut marker onto another word -------------------------
  const [dragEdge, setDragEdge] = useState<TrimEdge | null>(null);

  const startMarkerDrag = useCallback(
    (edge: TrimEdge, e: React.PointerEvent) => {
      const start = latest.current.clip;
      if (!start || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      window.getSelection()?.removeAllRanges();
      dispatch(selectSegment(start.id));
      dispatch(setTrimTarget({ segmentId: start.id, edge }));
      onSeek(edgeDisplayTime(start, edge, latest.current.fps));
      setDragEdge(edge);

      const original = { ...start };
      let lastKey: string | null = null;
      let moved = false;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";

      const onMove = (ev: PointerEvent) => {
        const el = document
          .elementFromPoint(ev.clientX, ev.clientY)
          ?.closest<HTMLElement>("[data-word-key]");
        const key = el?.dataset.wordKey;
        if (!key || key === lastKey) return;
        const word = latest.current.wordByKey.get(key);
        if (!word) return;
        lastKey = key;
        moved = true;
        const { fps: f, duration: total } = latest.current;
        const next = setEdgeTime(original, edge, wordEdgeTime(word, edge, f), f, total);
        trimTo(original, next.start, next.end, edge, false);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        document.body.style.userSelect = prevUserSelect;
        if (moved) dispatch(finalizeSegmentEdit());
        setDragEdge(null);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [dispatch, onSeek, trimTo],
  );

  // ---- Selecting text --------------------------------------------------
  const [menu, setMenu] = useState<SelectionMenu | null>(null);

  const onSelectEnd = useCallback(
    (container: HTMLElement) => {
      if (!enabled) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setMenu(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) return;
      const spans = Array.from(
        container.querySelectorAll<HTMLElement>("[data-word-key]"),
      ).filter((el) => range.intersectsNode(el));
      // Only whole-ish words count: ignore a span touched at offset 0 / end
      if (spans.length === 0) {
        setMenu(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      const box = container.getBoundingClientRect();
      setMenu({
        firstKey: spans[0].dataset.wordKey!,
        lastKey: spans[spans.length - 1].dataset.wordKey!,
        top: rect.bottom - box.top + container.scrollTop + 6,
        left: Math.max(0, Math.min(rect.left - box.left, box.width - 300)),
      });
    },
    [enabled],
  );

  // Close the menu once the selection goes away
  useEffect(() => {
    if (!menu) return;
    const onChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setMenu(null);
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, [menu]);

  const menuWords = menu
    ? {
        first: wordByKey.get(menu.firstKey) ?? null,
        last: wordByKey.get(menu.lastKey) ?? null,
      }
    : null;

  // Clip the selection belongs to: the one it overlaps most, else none
  const menuClip = useMemo(() => {
    if (!menuWords?.first || !menuWords.last) return null;
    const a = menuWords.first.start;
    const b = menuWords.last.end;
    let best: ClipBounds | null = null;
    let bestOverlap = 0;
    for (const s of segments) {
      const o = Math.min(b, s.endTime) - Math.max(a, s.startTime);
      if (o > bestOverlap) {
        bestOverlap = o;
        best = s;
      }
    }
    return best;
  }, [menuWords?.first, menuWords?.last, segments]);

  const closeMenu = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setMenu(null);
  }, []);

  const runMenuAction = useCallback(
    (action: "clip" | "in" | "out" | "new") => {
      const first = menuWords?.first;
      const last = menuWords?.last;
      if (!first || !last) return;
      const { fps: f, duration: total } = latest.current;
      if (action === "new") {
        const { start, end } = clipFromWords(first, last, f, total);
        dispatch(addSegment({ atTime: start, endTime: end }));
        onSeek(edgeDisplayTime({ startTime: start, endTime: end }, "start", f));
        closeMenu();
        return;
      }
      const target = menuClip ?? latest.current.clip;
      if (!target) return;
      dispatch(selectSegment(target.id));
      if (action === "clip") {
        const { start, end } = clipFromWords(first, last, f, total);
        trimTo(target, start, end, "start", true);
        dispatch(setTrimTarget({ segmentId: target.id, edge: "start" }));
      } else {
        const edge: TrimEdge = action === "in" ? "start" : "end";
        const word = action === "in" ? first : last;
        const next = setEdgeTime(target, edge, wordEdgeTime(word, edge, f), f, total);
        trimTo(target, next.start, next.end, edge, true);
        dispatch(setTrimTarget({ segmentId: target.id, edge }));
      }
      closeMenu();
    },
    [menuWords?.first, menuWords?.last, menuClip, dispatch, onSeek, trimTo, closeMenu],
  );

  // Keep the edge being trimmed in view while it moves
  const activeEdgeTime =
    trimTarget && clip
      ? trimTarget.edge === "start"
        ? clip.startTime
        : clip.endTime
      : null;
  useEffect(() => {
    if (activeEdgeTime == null || !trimTarget || dragEdge) return;
    const el = document.querySelector<HTMLElement>(
      `[data-cut-marker="${trimTarget.edge}"]`,
    );
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeEdgeTime, trimTarget, dragEdge]);

  const clipNumber = (id: string | undefined) => {
    if (!id) return null;
    const sorted = [...segments].sort((a, b) => a.startTime - b.startTime);
    const i = sorted.findIndex((s) => s.id === id);
    return i >= 0 ? i + 1 : null;
  };

  const selectionMenu =
    enabled && menu && menuWords?.first && menuWords.last ? (
      <SelectionMenuView
        top={menu.top}
        left={menu.left}
        targetNumber={clipNumber((menuClip ?? clip)?.id)}
        canTrim={!!menuClip}
        canMoveEdges={!!(menuClip ?? clip)}
        canCreate={!menuClip}
        seconds={menuWords.last.end - menuWords.first.start}
        onAction={runMenuAction}
      />
    ) : null;

  const activeEdge =
    trimTarget && clip && trimTarget.segmentId === clip.id ? trimTarget.edge : null;

  return {
    enabled: enabled && !!clip,
    marks,
    inAnyClip,
    inSelectedClip: marks.inClip,
    activeEdge,
    dragEdge,
    startMarkerDrag,
    onSelectEnd,
    selectionMenu,
    anyClips: enabled && segments.length > 0,
  };
}

