/**
 * Undo / redo for the editor.
 *
 * Every user edit already goes through `markEdited` (it bumps `localVersion`
 * so autosave knows to save). This middleware watches for that bump and, just
 * before such an edit lands, keeps a copy of the editable state. Undo puts the
 * last copy back; redo re-applies the state undo replaced.
 *
 * Rules:
 * - A burst of the same edit on the same thing (a drag, typing a title,
 *   nudging a word) is one undo step, not one per mouse move or keystroke.
 * - Loading a project, or the server / IQ agent replacing the cut, clears the
 *   history: undoing past that would put back a cut the server no longer has.
 * - While the IQ agent owns the cut, nothing is recorded and undo is off.
 * - Restored state is saved by autosave like any other edit.
 *
 * Snapshots are references to immutable Redux state, so keeping them is cheap.
 */

import { createAction, type Middleware } from "@reduxjs/toolkit";
import {
  resetEditor,
  restoreEditorSnapshot,
  setAgentRunActive,
  setCaptionSettings,
  setHistoryAvailability,
  setProjectId,
  setSegments,
  updateGenerationMetadata,
  type EditorSnapshot,
} from "./editorSlice";

export const undoEdit = createAction("editorHistory/undo");
export const redoEdit = createAction("editorHistory/redo");

/** Edits closer together than this (same action, same target) merge. */
export const COALESCE_MS = 800;
const MAX_STEPS = 100;

/** Bump the version without being user edits worth undoing. */
const NOT_UNDOABLE = new Set<string>([
  setCaptionSettings.type, // project load (may re-save separated words)
  updateGenerationMetadata.type, // IQ panel prompt fields: inputs have native undo
  restoreEditorSnapshot.type,
]);

/** The cut was replaced from outside: history no longer applies. */
const CLEARS_HISTORY = new Set<string>([
  setProjectId.type,
  setSegments.type,
  resetEditor.type,
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EditorLike = any;

function snapshotOf(editor: EditorLike): EditorSnapshot {
  return {
    segments: editor.segments,
    captionSettings: editor.captionSettings,
    globalFraming: editor.globalFraming,
    captions: editor.captions,
    transcriptWords: editor.transcriptWords,
    selectedSegmentId: editor.selectedSegmentId,
  };
}

/** Same action on the same scene / keyframe / word merges into one step. */
function coalesceKey(action: { type: string; payload?: unknown }): string {
  const payload = action.payload;
  if (typeof payload === "string") return `${action.type}:${payload}`;
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    for (const field of ["keyframeId", "segmentId", "id", "key"]) {
      if (typeof p[field] === "string") return `${action.type}:${p[field]}`;
    }
  }
  return action.type;
}

export interface EditorHistory {
  middleware: Middleware;
  /** For tests: drop all history. */
  clear: () => void;
}

export function createEditorHistory(now: () => number = Date.now): EditorHistory {
  let past: EditorSnapshot[] = [];
  let future: EditorSnapshot[] = [];
  let lastKey: string | null = null;
  let lastAt = 0;

  const clear = () => {
    past = [];
    future = [];
    lastKey = null;
  };

  const middleware: Middleware = (store) => (next) => (action) => {
    const publish = () => {
      const current = store.getState().editor.history;
      const canUndo = past.length > 0;
      const canRedo = future.length > 0;
      if (current?.canUndo !== canUndo || current?.canRedo !== canRedo) {
        store.dispatch(setHistoryAvailability({ canUndo, canRedo }));
      }
    };
    const typed = action as { type: string; payload?: unknown };

    if (undoEdit.match(typed) || redoEdit.match(typed)) {
      const editor = store.getState().editor;
      if (editor.agentRunActive) return undefined;
      const from = undoEdit.match(typed) ? past : future;
      const to = undoEdit.match(typed) ? future : past;
      const target = from.pop();
      if (!target) return undefined;
      to.push(snapshotOf(editor));
      lastKey = null; // the next edit starts a fresh step
      store.dispatch(restoreEditorSnapshot(target));
      publish();
      return undefined;
    }

    const before = store.getState().editor;
    const result = next(action);
    const after = store.getState().editor;

    const agentTookOver =
      setAgentRunActive.match(typed) && typed.payload === true;
    if (CLEARS_HISTORY.has(typed.type) || agentTookOver) {
      if (past.length || future.length) {
        clear();
        publish();
      }
      return result;
    }

    const isEdit =
      after.localVersion > before.localVersion &&
      !NOT_UNDOABLE.has(typed.type) &&
      !after.agentRunActive;
    if (isEdit) {
      const key = coalesceKey(typed);
      const t = now();
      if (!(key === lastKey && t - lastAt < COALESCE_MS)) {
        past.push(snapshotOf(before));
        if (past.length > MAX_STEPS) past.shift();
      }
      lastKey = key;
      lastAt = t;
      future = [];
      publish();
    }
    return result;
  };

  return { middleware, clear };
}

export const editorHistory = createEditorHistory();
