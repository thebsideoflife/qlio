import {
  createSlice,
  createAsyncThunk,
  type PayloadAction,
} from "@reduxjs/toolkit";
import type { Segment } from "./editorSlice";
import { listAssets, listAssetStatuses, getAsset } from "@/services/api";

export interface Asset {
  id: string;
  title: string;
  originalName?: string;
  status:
    | "processing"
    | "uploading"
    | "indexing"
    | "completed"
    | "failed"
    | "READY";
  format: string;
  size: string;
  segmentCount: number;
  createdAt: string;
  videoUrl?: string;
  segments?: Segment[];
  metadata?: Record<string, unknown>;
  uploadProgress?: number;
  processing?: {
    stage: string;
    progress: number;
    stages: {
      upload: number;
      transcription: number;
      clip_selection: number;
      reframing: number;
      captions: number;
      delivery: number;
    };
    eta: string;
  };
}

interface AssetsState {
  items: Asset[];
  loading: boolean;
  error: string | null;
  initialLoadDone: boolean;
}

const initialState: AssetsState = {
  items: [],
  loading: false,
  error: null,
  initialLoadDone: false,
};

/**
 * Full asset fetch with presigned URLs - use for initial load
 */
export const fetchAssets = createAsyncThunk("assets/fetchAssets", async () => {
  const data = await listAssets();
  return data as Asset[];
});

/**
 * Slim status polling - use for background polling while assets are processing.
 * Only updates status/title, preserves existing videoUrls.
 * Returns list of asset IDs that became READY (need full fetch for videoUrl).
 */
export const pollAssetStatuses = createAsyncThunk(
  "assets/pollStatuses",
  async (_, { getState }) => {
    const statuses = await listAssetStatuses();
    const state = getState() as { assets: AssetsState };
    const existingMap = new Map(state.assets.items.map((a) => [a.id, a]));

    // Find assets that just became READY - they need a full fetch for videoUrl
    const newlyReady: string[] = [];
    for (const slim of statuses) {
      const existing = existingMap.get(slim.id);
      const isReady = slim.status === "READY" || slim.status === "completed";
      const wasNotReady =
        existing &&
        existing.status !== "READY" &&
        existing.status !== "completed";
      if (isReady && wasNotReady && !existing.videoUrl) {
        newlyReady.push(slim.id);
      }
    }

    // Fetch full asset data for newly ready assets (to get presigned URLs)
    const fullAssets: Asset[] = [];
    for (const id of newlyReady) {
      try {
        const full = await getAsset(id);
        fullAssets.push({ ...full, id: full.assetId || full.id });
      } catch {
        // Non-fatal - will get it on next poll
      }
    }

    return { statuses, fullAssets };
  },
);

export const assetsSlice = createSlice({
  name: "assets",
  initialState,
  reducers: {
    setAssets: (state, action: PayloadAction<Asset[]>) => {
      state.items = action.payload;
    },
    addAsset: (state, action: PayloadAction<Asset>) => {
      state.items.unshift(action.payload);
    },
    updateAssetStatus: (
      state,
      action: PayloadAction<{
        id: string;
        status: Asset["status"];
        progress?: number;
      }>,
    ) => {
      const asset = state.items.find((a) => a.id === action.payload.id);
      if (asset) {
        asset.status = action.payload.status;
        if (typeof action.payload.progress === "number") {
          asset.uploadProgress = action.payload.progress;
        }
      }
    },
    removeAsset: (state, action: PayloadAction<string>) => {
      state.items = state.items.filter((item) => item.id !== action.payload);
    },
    updateAsset: (
      state,
      action: PayloadAction<{ id: string; updates: Partial<Asset> }>,
    ) => {
      const asset = state.items.find((a) => a.id === action.payload.id);
      if (asset) {
        Object.assign(asset, action.payload.updates);
      }
    },
  },
  extraReducers: (builder) => {
    builder
      // Full fetch - for initial load
      .addCase(fetchAssets.pending, (state) => {
        state.loading = true;
      })
      .addCase(fetchAssets.fulfilled, (state, action) => {
        state.loading = false;
        state.initialLoadDone = true;
        state.items = action.payload;
      })
      .addCase(fetchAssets.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message || "Failed to fetch assets";
      })
      // Slim polling - used for both initial load and background polling
      .addCase(pollAssetStatuses.pending, (state) => {
        // Only show loading spinner on initial load
        if (!state.initialLoadDone) {
          state.loading = true;
        }
      })
      .addCase(pollAssetStatuses.fulfilled, (state, action) => {
        const { statuses, fullAssets } = action.payload;

        state.loading = false;
        state.initialLoadDone = true;

        // Build maps for efficient lookup
        const statusMap = new Map(statuses.map((s) => [s.id, s]));
        const fullMap = new Map(fullAssets.map((a) => [a.id, a]));

        // Update existing items with new status info
        for (const item of state.items) {
          // If we have a full asset (newly ready), replace entirely
          const full = fullMap.get(item.id);
          if (full) {
            Object.assign(item, full);
            continue;
          }

          // Otherwise just update status fields from slim data
          const slim = statusMap.get(item.id);
          if (slim) {
            item.status = slim.status as Asset["status"];
            item.title = slim.title;
          }
        }

        // Add any new assets that weren't in state
        const existingIds = new Set(state.items.map((i) => i.id));
        for (const slim of statuses) {
          if (!existingIds.has(slim.id)) {
            // New asset - add it with slim data (no videoUrl yet)
            state.items.unshift({
              id: slim.id,
              title: slim.title,
              status: slim.status as Asset["status"],
              format: slim.format || "",
              createdAt: slim.createdAt,
              size: "",
              segmentCount: 0,
            });
          }
        }

        // Remove assets that no longer exist
        const currentIds = new Set(statuses.map((s) => s.id));
        state.items = state.items.filter((item) => currentIds.has(item.id));
      })
      .addCase(pollAssetStatuses.rejected, (state, action) => {
        state.loading = false;
        // Only set error on initial load failure
        if (!state.initialLoadDone) {
          state.error = action.error.message || "Failed to fetch assets";
        }
      });
  },
});

export const {
  addAsset,
  updateAssetStatus,
  setAssets,
  removeAsset,
  updateAsset,
} = assetsSlice.actions;
export default assetsSlice.reducer;
