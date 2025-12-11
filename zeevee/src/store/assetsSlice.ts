import {
  createSlice,
  createAsyncThunk,
  type PayloadAction,
} from "@reduxjs/toolkit";
import type { Segment } from "./editorSlice";
import { listAssets } from "@/services/api";

export interface Asset {
  id: string;
  title: string;
  originalName?: string;
  thumbnail?: string;
  thumbnailUrl?: string;
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
  metadata?: any;
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
}

const initialState: AssetsState = {
  items: [],
  loading: false,
  error: null,
};

export const fetchAssets = createAsyncThunk("assets/fetchAssets", async () => {
  const data = await listAssets();
  // Transform or validate if necessary
  return data; // Assuming data is Asset[]
});

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
      }>
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
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchAssets.pending, (state) => {
        state.loading = true;
      })
      .addCase(fetchAssets.fulfilled, (state, action) => {
        state.loading = false;
        // Merge with existing items to preserve local optimistic updates if possible,
        // or just replace. Since we're polling, replacing is safer but might cause jitter.
        // Let's replace for now.
        state.items = action.payload;
      })
      .addCase(fetchAssets.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message || "Failed to fetch assets";
      });
  },
});

export const { addAsset, updateAssetStatus, setAssets, removeAsset } =
  assetsSlice.actions;
export default assetsSlice.reducer;
