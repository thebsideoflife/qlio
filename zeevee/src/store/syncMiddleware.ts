import type { Middleware } from "@reduxjs/toolkit";
import { updateProject } from "@/services/api";
import { markSynced, setSyncing } from "./editorSlice";

const SYNC_INTERVAL_MS = 10000; // 10 seconds

// Track the interval ID so we can clean it up
let syncIntervalId: ReturnType<typeof setInterval> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StoreAPI = { getState: () => any; dispatch: (action: any) => any };

/**
 * Starts the sync polling interval.
 * Called when a project is loaded (setProjectId action).
 */
function startSyncInterval(store: StoreAPI) {
  // Clear any existing interval first
  stopSyncInterval();

  syncIntervalId = setInterval(async () => {
    const state = store.getState();
    const {
      projectId,
      segments,
      captionSettings,
      globalFraming,
      generationMetadata,
      localVersion,
      syncedVersion,
      isSyncing,
      agentRunActive,
    } = state.editor;

    // Only sync if: we have a project, there are unsynced changes, and not already syncing
    const hasUnsyncedChanges = localVersion > syncedVersion;

    // While the IQ agent has the cut, it writes segments server-side and streams
    // them back. Pushing our copy over the top would clobber its work.
    if (projectId && hasUnsyncedChanges && !isSyncing && !agentRunActive) {
      // Capture the version we're about to sync
      const versionToSync = localVersion;

      store.dispatch(setSyncing(true));
      try {
        // The title is saved on its own when edited (saveProjectTitle); sending
        // it here could push a stale name back over a newer one.
        await updateProject(projectId, {
          segments,
          captionSettings,
          globalFraming,
          ...(generationMetadata ? { metadata: generationMetadata } : {}),
        });
        // Only mark the specific version as synced - if user made edits during sync,
        // localVersion will be higher and we'll sync again next interval
        store.dispatch(markSynced(versionToSync));
      } catch (e) {
        console.error("[Sync] Failed to sync project:", e);
        // Don't update syncedVersion on failure - will retry next interval
      }
      store.dispatch(setSyncing(false));
    }
  }, SYNC_INTERVAL_MS);
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
}

export const syncMiddleware: Middleware = (store) => {
  return (next) => (action) => {
    const result = next(action);

    // Type guard for action
    const typedAction = action as { type: string; payload?: unknown };

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
