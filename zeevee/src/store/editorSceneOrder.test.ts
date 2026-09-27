/**
 * Scenes are always chronological, so a scene's number (its 1-based position)
 * shifts when a scene is inserted before it or deleted.
 *
 * Run: npx tsx --tsconfig tsconfig.app.json src/store/editorSceneOrder.test.ts
 */
import { configureStore } from "@reduxjs/toolkit";
import {
  editorSlice,
  addSegment,
  deleteSegment,
  setDuration,
  setSegments,
  splitSegment,
  type Segment,
} from "./editorSlice";
import { buildExportMetadataDocument } from "@/lib/exportMetadataJson";

let checks = 0;
let failures = 0;

function assertEqual<T>(actual: T, expected: T, message: string): void {
  checks++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(
      `  FAIL: ${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function scene(id: string, startTime: number, endTime: number): Segment {
  return {
    id,
    startTime,
    endTime,
    title: id,
    description: "",
    characters: [],
    sceneTags: [],
    keyDialogue: "",
    confidence: 1,
  };
}

function makeStore() {
  const store = configureStore({ reducer: { editor: editorSlice.reducer } });
  store.dispatch(setDuration(1000));
  return store;
}

const order = (store: ReturnType<typeof makeStore>) =>
  store.getState().editor.segments.map((s) => s.id);

{
  const store = makeStore();
  store.dispatch(setSegments([scene("c", 400, 500), scene("a", 0, 100), scene("b", 200, 300)]));
  assertEqual(order(store), ["a", "b", "c"], "load sorts scenes chronologically");
}

{
  const store = makeStore();
  store.dispatch(setSegments([scene("a", 0, 100), scene("b", 300, 400), scene("c", 500, 600)]));
  store.dispatch(addSegment({ atTime: 150 }));
  const ids = order(store);
  assertEqual(ids.length, 4, "scene added");
  assertEqual([ids[0], ids[2], ids[3]], ["a", "b", "c"], "old 2 becomes 3, old 3 becomes 4");
  assertEqual(ids[1].startsWith("seg-"), true, "new scene is number 2");

  store.dispatch(deleteSegment(ids[1]));
  assertEqual(order(store), ["a", "b", "c"], "deleting renumbers back");
}

{
  const store = makeStore();
  store.dispatch(setSegments([scene("a", 0, 100), scene("b", 200, 300)]));
  store.dispatch(splitSegment({ id: "a", atTime: 50 }));
  assertEqual(order(store), ["a-a", "a-b", "b"], "split halves stay in place");
}

{
  const segments = [scene("a", 0, 10), scene("b", 10, 20), scene("c", 20, 30)];
  const doc = buildExportMetadataDocument({
    projectId: "p",
    projectTitle: "P",
    segments,
    selectedSegmentIds: new Set(["c"]),
    metadataBySegmentId: new Map(),
    options: {},
  });
  assertEqual(doc.scenes[0].sceneNumber, 3, "exporting scene 3 alone keeps number 3");
}

if (failures > 0) {
  console.error(`FAILED: ${failures}/${checks} checks`);
  process.exit(1);
}

console.log(`OK: ${checks} scene order checks`);
