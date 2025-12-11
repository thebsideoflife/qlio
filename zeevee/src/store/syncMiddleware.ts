import type { Middleware } from "@reduxjs/toolkit";
import { updateProject } from "@/services/api";
import { markSynced, setSyncing } from "./editorSlice";
import type { RootState } from "./store";

const SYNC_INTERVAL_MS = 10000; // 10 seconds

export const syncMiddleware: Middleware = (store) => {
  // Start polling interval when middleware initializes
  setInterval(async () => {
    const state = store.getState() as RootState;
    const { projectId, segments, isDirty, isSyncing } = state.editor;

    // Only sync if: we have a project, there are changes, and not already syncing
    if (projectId && isDirty && !isSyncing) {
      store.dispatch(setSyncing(true));
      try {
        await updateProject(projectId, { segments });
        store.dispatch(markSynced());
        console.log("[Sync] Segments synced successfully");
      } catch (e) {
        console.error("[Sync] Failed to sync segments:", e);
        // Don't clear isDirty on failure - will retry next interval
      }
      store.dispatch(setSyncing(false));
    }
  }, SYNC_INTERVAL_MS);

  // Pass actions through unchanged
  return (next) => (action) => next(action);
};
