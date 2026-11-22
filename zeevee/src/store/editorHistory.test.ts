/**
 * Editor undo / redo (historyMiddleware).
 *
 * Run: npx tsx --tsconfig tsconfig.app.json src/store/editorHistory.test.ts
 */
import { configureStore } from "@reduxjs/toolkit";
import {
  editorSlice,
  deleteSegment,
  setAgentRunActive,
  setCaptionSettings,
  setDuration,
  setSegments,
  splitSegment,
  updateCaptionStyle,
  updateGenerationMetadata,
  updateSegmentTime,
  updateSegmentTitle,
  type Segment,
} from "./editorSlice";
import { COALESCE_MS, createEditorHistory, redoEdit, undoEdit } from "./historyMiddleware";

let checks = 0;
let failures = 0;
function assertEqual<T>(actual: T, expected: T, message: string): void {
  checks++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`  FAIL: ${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function scene(id: string, startTime: number, endTime: number): Segment {
  return { id, startTime, endTime, title: id, description: "", characters: [], sceneTags: [], keyDialogue: "", confidence: 1 };
}

function makeStore() {
  let clock = 1_000_000;
  const history = createEditorHistory(() => clock);
  const store = configureStore({
    reducer: { editor: editorSlice.reducer },
    middleware: (gdm) => gdm().concat(history.middleware),
  });
  store.dispatch(setDuration(1000));
  store.dispatch(setSegments([scene("a", 0, 10), scene("b", 20, 30)]));
  return {
    store,
    tick: (ms: number) => {
      clock += ms;
    },
    ids: () => store.getState().editor.segments.map((s: Segment) => s.id),
    times: () => store.getState().editor.segments.map((s: Segment) => [s.startTime, s.endTime]),
    flags: () => store.getState().editor.history,
    version: () => store.getState().editor.localVersion,
  };
}

// Loading is not an edit.
{
  const t = makeStore();
  assertEqual(t.flags(), { canUndo: false, canRedo: false }, "nothing to undo after load");
}

// Undo and redo a delete.
{
  const t = makeStore();
  t.store.dispatch(deleteSegment("a"));
  assertEqual(t.ids(), ["b"], "deleted");
  assertEqual(t.flags(), { canUndo: true, canRedo: false }, "can undo delete");
  const before = t.version();
  t.store.dispatch(undoEdit());
  assertEqual(t.ids(), ["a", "b"], "undo brings scene back");
  assertEqual(t.version() > before, true, "undo is saved like an edit");
  assertEqual(t.flags(), { canUndo: false, canRedo: true }, "can redo");
  t.store.dispatch(redoEdit());
  assertEqual(t.ids(), ["b"], "redo deletes again");
  assertEqual(t.flags(), { canUndo: true, canRedo: false }, "flags after redo");
}

// A drag is one step; separate drags are separate steps.
{
  const t = makeStore();
  for (let i = 1; i <= 5; i++) {
    t.store.dispatch(updateSegmentTime({ id: "a", start: 0, end: 10 + i }));
    t.tick(50);
  }
  t.tick(COALESCE_MS + 1);
  t.store.dispatch(updateSegmentTime({ id: "a", start: 2, end: 15 }));
  t.store.dispatch(undoEdit());
  assertEqual(t.times()[0], [0, 15], "undo removes only the second drag");
  t.store.dispatch(undoEdit());
  assertEqual(t.times()[0], [0, 10], "undo removes the whole first drag");
  assertEqual(t.flags().canUndo, false, "back at the start");
}

// Different targets never merge, even back to back.
{
  const t = makeStore();
  t.store.dispatch(updateSegmentTitle({ id: "a", title: "A1" }));
  t.store.dispatch(updateSegmentTitle({ id: "b", title: "B1" }));
  t.store.dispatch(undoEdit());
  const titles = () => t.store.getState().editor.segments.map((s: Segment) => s.title);
  assertEqual(titles(), ["A1", "b"], "undo only the second scene's rename");
}

// A new edit after undo drops the redo stack.
{
  const t = makeStore();
  t.store.dispatch(splitSegment({ id: "a", atTime: 5 }));
  t.store.dispatch(undoEdit());
  t.store.dispatch(deleteSegment("b"));
  assertEqual(t.flags(), { canUndo: true, canRedo: false }, "redo cleared");
  t.store.dispatch(redoEdit());
  assertEqual(t.ids(), ["a"], "redo did nothing");
}

// Caption style edits are undoable.
{
  const t = makeStore();
  const size = () => t.store.getState().editor.captionSettings.style.fontSize;
  const original = size();
  t.store.dispatch(updateCaptionStyle({ fontSize: original + 10 }));
  t.store.dispatch(undoEdit());
  assertEqual(size(), original, "caption style restored");
}

// Not undoable: project loads and IQ prompt fields.
{
  const t = makeStore();
  t.store.dispatch(setCaptionSettings(t.store.getState().editor.captionSettings));
  t.store.dispatch(updateGenerationMetadata({ userPrompt: "funny bits" }));
  assertEqual(t.flags().canUndo, false, "loads and prompt typing are not undo steps");
}

// Server / agent replacing the cut clears history; agent blocks undo.
{
  const t = makeStore();
  t.store.dispatch(deleteSegment("a"));
  t.store.dispatch(setSegments([scene("x", 0, 5)]));
  assertEqual(t.flags(), { canUndo: false, canRedo: false }, "server load clears history");
  t.store.dispatch(updateSegmentTitle({ id: "x", title: "X" }));
  t.store.dispatch(setAgentRunActive(true));
  assertEqual(t.flags().canUndo, false, "agent run clears history");
  t.store.dispatch(updateSegmentTitle({ id: "x", title: "Y" }));
  assertEqual(t.flags().canUndo, false, "nothing recorded while the agent runs");
  t.store.dispatch(undoEdit());
  assertEqual(t.store.getState().editor.segments[0].title, "Y", "undo ignored while the agent runs");
}

// Undo restores selection only if that scene still exists.
{
  const t = makeStore();
  t.store.dispatch(editorSlice.actions.selectSegment("b"));
  t.store.dispatch(deleteSegment("b"));
  t.store.dispatch(undoEdit());
  assertEqual(t.store.getState().editor.selectedSegmentId, "b", "selection comes back with the scene");
}

if (failures) {
  console.error(`editor-history: ${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`editor-history: ${checks} checks passed`);
