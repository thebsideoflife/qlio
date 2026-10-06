import type { Middleware } from "@reduxjs/toolkit";
import { updateProject } from "@/services/api";
import { markSynced, setSyncing } from "./editorSlice";

const SYNC_INTERVAL_MS = 10000; // 10 seconds

// Track the interval ID so we can clean it up
let syncIntervalId: ReturnType<typeof setInterval> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StoreAPI = { getState: () => any; dispatch: (action: any) => any };

// Bumped whenever the editor is reset or loads a project. A save that finishes
// after that belongs to the old editor session and must not mark the new one synced.
let editorSession = 0;

// Saves run one at a time, in order, so an older copy never lands after a newer one.
let saveChain: Promise<unknown> = Promise.resolve();

/**
 * Save the project's editable state. Every save goes through here so they
 * reach the server in the order they were made.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function saveProject(editor: any, includeSegments: boolean): Promise<void> {
  const { projectId, segments, captionSettings, globalFraming, generationMetadata } = editor;
  const save = saveChain.then(() =>
    // The title is saved on its own when edited (saveProjectTitle); sending
    // it here could push a stale name back over a newer one.
    updateProject(projectId, {
      ...(includeSegments ? { segments } : {}),
      captionSettings,
      globalFraming,
      ...(generationMetadata ? { metadata: generationMetadata } : {}),
    }),
  );
  saveChain = save.catch(() => undefined);
  return save;
}

/** Push unsynced edits now. Returns when the save settles. */
async function syncOnce(store: StoreAPI) {
  const editor = store.getState().editor;
  const { projectId, localVersion, syncedVersion, isSyncing, agentRunActive } = editor;

  // While the IQ agent has the cut, it writes segments server-side and streams
  // them back. Pushing our copy over the top would clobber its work.
  if (!projectId || localVersion <= syncedVersion || isSyncing || agentRunActive) return;

  // Capture the version we're about to sync
  const versionToSync = localVersion;
  const session = editorSession;
  store.dispatch(setSyncing(true));
  try {
    await saveProject(editor, true);
    // Only mark the specific version as synced - if user made edits during sync,
    // localVersion will be higher and we'll sync again next interval
    if (session === editorSession) store.dispatch(markSynced(versionToSync));
  } catch (e) {
    console.error("[Sync] Failed to sync project:", e);
    // Don't update syncedVersion on failure - will retry next interval
  }
  if (session === editorSession) store.dispatch(setSyncing(false));
}

/**
 * Leaving the editor resets its state, so save anything not yet synced first
 * (an edit made in the last few seconds would otherwise be dropped). Retries a
 * couple of times because nothing is left to retry it later.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function saveBeforeLeaving(editor: any) {
  if (!editor.projectId || editor.localVersion <= editor.syncedVersion) return;
  // The agent owns the segments while it runs; still keep caption and framing edits.
  const includeSegments = !editor.agentRunActive;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await saveProject(editor, includeSegments);
      return;
    } catch (e) {
      console.error(`[Sync] Failed to save on leaving the editor (attempt ${attempt + 1}):`, e);
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}

let unloadStore: StoreAPI | null = null;

/** Closing or reloading the tab with unsaved edits: save now and ask the browser to warn. */
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (!unloadStore) return;
  const { projectId, localVersion, syncedVersion, isSyncing } = unloadStore.getState().editor;
  if (!projectId || (localVersion <= syncedVersion && !isSyncing)) return;
  void syncOnce(unloadStore);
  e.preventDefault();
  e.returnValue = "";
}

/**
 * Starts the sync polling interval.
 * Called when a project is loaded (setProjectId action).
 */
function startSyncInterval(store: StoreAPI) {
  // Clear any existing interval first
  stopSyncInterval();

  syncIntervalId = setInterval(() => {
    void syncOnce(store);
  }, SYNC_INTERVAL_MS);
  unloadStore = store;
  window.addEventListener("beforeunload", onBeforeUnload);
}

/**
 * Stops the sync polling interval.
 * Called when leaving the editor (resetEditor action) or loading a new project.
 */
function stopSyncInterval() {
  if (syncIntervalId !== null) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
  }
  unloadStore = null;
  window.removeEventListener("beforeunload", onBeforeUnload);
}

export const syncMiddleware: Middleware = (store) => {
  return (next) => (action) => {
    // Type guard for action
    const typedAction = action as { type: string; payload?: unknown };

    // Leaving the editor (or switching project) resets its state: save first.
    if (typedAction.type === "editor/resetEditor") {
      void saveBeforeLeaving(store.getState().editor);
    }

    const result = next(action);
    if (
      typedAction.type === "editor/resetEditor" ||
      typedAction.type === "editor/setProjectId"
    ) {
      editorSession++;
    }

    // Start sync interval when a project is loaded
    if (typedAction.type === "editor/setProjectId") {
      const projectId = typedAction.payload as string | null;
      if (projectId) {
        startSyncInterval(store);
      } else {
        stopSyncInterval();
      }
    }

    // Stop sync interval when editor is reset (user leaves editor)
    if (typedAction.type === "editor/resetEditor") {
      stopSyncInterval();
    }

    return result;
  };
};

// Export for testing purposes
export { startSyncInterval, stopSyncInterval };
