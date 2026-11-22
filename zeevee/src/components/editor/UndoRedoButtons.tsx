import { useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import { Redo2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RootState } from "@/store/store";
import { redoEdit, undoEdit } from "@/store/historyMiddleware";

const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";

/** Typing somewhere keeps the browser's own undo for that field. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

/**
 * Undo / Redo for editor edits (scenes, timing, framing, captions, word
 * edits). Also binds ⌘Z / ⇧⌘Z (Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y elsewhere).
 */
export function UndoRedoButtons() {
  const dispatch = useDispatch();
  const { canUndo, canRedo } = useSelector(
    (state: RootState) => state.editor.history,
  );
  const agentRunActive = useSelector(
    (state: RootState) => state.editor.agentRunActive,
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (isTextEntry(e.target)) return;
      const key = e.key.toLowerCase();
      const redo = (key === "z" && e.shiftKey) || (key === "y" && !isMac);
      const undo = key === "z" && !e.shiftKey;
      if (!undo && !redo) return;
      e.preventDefault();
      dispatch(redo ? redoEdit() : undoEdit());
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dispatch]);

  const blockedReason = agentRunActive ? " (unavailable while IQ is editing)" : "";
  return (
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        variant="ghost"
        className="h-8 w-8 p-0"
        onClick={() => dispatch(undoEdit())}
        disabled={!canUndo || agentRunActive}
        title={`Undo (${MOD}Z)${blockedReason}`}
        aria-label="Undo"
      >
        <Undo2 className="h-4 w-4" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-8 w-8 p-0"
        onClick={() => dispatch(redoEdit())}
        disabled={!canRedo || agentRunActive}
        title={`Redo (${isMac ? "⇧⌘Z" : "Ctrl+Y"})${blockedReason}`}
        aria-label="Redo"
      >
        <Redo2 className="h-4 w-4" />
      </Button>
    </div>
  );
}
