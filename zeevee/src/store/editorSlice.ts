import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export interface Segment {
  id: string;
  startTime: number; // in seconds
  endTime: number; // in seconds
  title: string;
  description: string;
  characters: string[];
  sceneTags: string[];
  keyDialogue: string;
  confidence: number;
}

interface EditorState {
  segments: Segment[];
  selectedSegmentId: string | null;
  currentTime: number;
  duration: number;
  projectTitle: string;
  assetName: string;
  // Sync tracking
  projectId: string | null;
  isDirty: boolean;
  isSyncing: boolean;
}

const initialState: EditorState = {
  segments: [],
  selectedSegmentId: null,
  currentTime: 0,
  duration: 0,
  projectTitle: "",
  assetName: "",
  // Sync tracking
  projectId: null,
  isDirty: false,
  isSyncing: false,
};

export const editorSlice = createSlice({
  name: "editor",
  initialState,
  reducers: {
    // Project management
    setProjectId: (state, action: PayloadAction<string | null>) => {
      state.projectId = action.payload;
      // Reset dirty state when loading a new project
      state.isDirty = false;
      state.isSyncing = false;
    },
    setSegments: (state, action: PayloadAction<Segment[]>) => {
      state.segments = action.payload;
      // Note: setSegments from API load should NOT set dirty
    },
    setProjectMetadata: (
      state,
      action: PayloadAction<{ title: string; assetName: string }>
    ) => {
      state.projectTitle = action.payload.title;
      state.assetName = action.payload.assetName;
    },
    updateProjectTitle: (state, action: PayloadAction<string>) => {
      state.projectTitle = action.payload;
    },
    selectSegment: (state, action: PayloadAction<string | null>) => {
      state.selectedSegmentId = action.payload;
    },

    // Segment editing (all set isDirty)
    updateSegmentTime: (
      state,
      action: PayloadAction<{ id: string; start: number; end: number }>
    ) => {
      const segment = state.segments.find((s) => s.id === action.payload.id);
      if (segment) {
        segment.startTime = action.payload.start;
        segment.endTime = action.payload.end;
        state.isDirty = true;
      }
    },
    splitSegment: (
      state,
      action: PayloadAction<{ id: string; atTime?: number }>
    ) => {
      const { id, atTime } = action.payload;
      const index = state.segments.findIndex((s) => s.id === id);
      if (index !== -1) {
        const segment = state.segments[index];
        // Use provided time or default to midpoint
        const splitPoint =
          atTime !== undefined
            ? atTime
            : segment.startTime + (segment.endTime - segment.startTime) / 2;

        // Ensure split point is within segment bounds
        if (splitPoint <= segment.startTime || splitPoint >= segment.endTime) {
          return;
        }

        const newSegment1: Segment = {
          ...segment,
          endTime: splitPoint,
          id: `${segment.id}-a`,
          title: `${segment.title} (Part 1)`,
        };
        const newSegment2: Segment = {
          ...segment,
          startTime: splitPoint,
          id: `${segment.id}-b`,
          title: `${segment.title} (Part 2)`,
        };

        state.segments.splice(index, 1, newSegment1, newSegment2);
        state.isDirty = true;
      }
    },
    addSegment: (state, action: PayloadAction<{ atTime: number }>) => {
      const { atTime } = action.payload;
      const defaultDuration = 3;
      const endTime = Math.min(atTime + defaultDuration, state.duration);

      // Don't add if it would be zero-length
      if (endTime <= atTime) return;

      const newSegment: Segment = {
        id: `seg-${Date.now()}`,
        startTime: atTime,
        endTime,
        title: "New Segment",
        description: "",
        characters: [],
        sceneTags: [],
        keyDialogue: "",
        confidence: 1,
      };

      state.segments.push(newSegment);
      state.segments.sort((a, b) => a.startTime - b.startTime);
      state.selectedSegmentId = newSegment.id;
      state.isDirty = true;
    },
    deleteSegment: (state, action: PayloadAction<string>) => {
      const id = action.payload;
      state.segments = state.segments.filter((s) => s.id !== id);
      if (state.selectedSegmentId === id) {
        state.selectedSegmentId = null;
      }
      state.isDirty = true;
    },

    // Sync state management
    setSyncing: (state, action: PayloadAction<boolean>) => {
      state.isSyncing = action.payload;
    },
    markSynced: (state) => {
      state.isDirty = false;
    },

    // Playback state
    setCurrentTime: (state, action: PayloadAction<number>) => {
      state.currentTime = action.payload;
    },
    setDuration: (state, action: PayloadAction<number>) => {
      state.duration = action.payload;
    },

    // Reset state when leaving editor
    resetEditor: () => initialState,
  },
});

export const {
  setProjectId,
  setSegments,
  setProjectMetadata,
  updateProjectTitle,
  selectSegment,
  updateSegmentTime,
  splitSegment,
  addSegment,
  deleteSegment,
  setSyncing,
  markSynced,
  setCurrentTime,
  setDuration,
  resetEditor,
} = editorSlice.actions;
export default editorSlice.reducer;
