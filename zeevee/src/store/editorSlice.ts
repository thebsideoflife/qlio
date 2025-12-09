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
}

const initialSegments: Segment[] = [];

const initialState: EditorState = {
  segments: initialSegments,
  selectedSegmentId: null,
  currentTime: 0,
  duration: 0,
  projectTitle: "",
  assetName: "",
};

export const editorSlice = createSlice({
  name: "editor",
  initialState,
  reducers: {
    setSegments: (state, action: PayloadAction<Segment[]>) => {
      state.segments = action.payload;
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
    updateSegmentTime: (
      state,
      action: PayloadAction<{ id: string; start: number; end: number }>
    ) => {
      const segment = state.segments.find((s) => s.id === action.payload.id);
      if (segment) {
        segment.startTime = action.payload.start;
        segment.endTime = action.payload.end;
      }
    },
    splitSegment: (state, action: PayloadAction<string>) => {
      const index = state.segments.findIndex((s) => s.id === action.payload);
      if (index !== -1) {
        const segment = state.segments[index];
        const midPoint =
          segment.startTime + (segment.endTime - segment.startTime) / 2;

        const newSegment1 = {
          ...segment,
          endTime: midPoint,
          id: segment.id + "-a",
          title: segment.title + " (Part 1)",
        };
        const newSegment2 = {
          ...segment,
          startTime: midPoint,
          id: segment.id + "-b",
          title: segment.title + " (Part 2)",
        };

        // Replace original with two new parts
        state.segments.splice(index, 1, newSegment1, newSegment2);
      }
    },
    setCurrentTime: (state, action: PayloadAction<number>) => {
      state.currentTime = action.payload;
    },
    setDuration: (state, action: PayloadAction<number>) => {
      state.duration = action.payload;
    },
  },
});

export const {
  setSegments,
  setProjectMetadata,
  updateProjectTitle,
  selectSegment,
  updateSegmentTime,
  splitSegment,
  setCurrentTime,
  setDuration,
} = editorSlice.actions;
export default editorSlice.reducer;
