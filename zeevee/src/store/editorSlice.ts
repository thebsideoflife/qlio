import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type {
  CaptionSettings,
  CaptionWord,
  CaptionStyle,
  CaptionLine,
} from "@/remotion/types";
import { DEFAULT_CAPTION_SETTINGS } from "@/remotion/types";
import { groupWordsIntoCaptions } from "@/remotion/utils";

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
  // Caption state
  transcriptWords: CaptionWord[];
  captions: CaptionLine[];
  captionSettings: CaptionSettings;
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
  // Caption state
  transcriptWords: [],
  captions: [],
  captionSettings: DEFAULT_CAPTION_SETTINGS,
};

// Helper to merge overlapping segments - uses outermost coordinates (min start, max end)
// Only merges when segments actually overlap (endTime > startTime), not when they just touch
const mergeOverlappingSegments = (segments: Segment[]): Segment[] => {
  if (segments.length <= 1) return segments;

  // Sort by start time
  const sorted = [...segments].sort((a, b) => a.startTime - b.startTime);
  const result: Segment[] = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = result[result.length - 1];

    // Only merge if segments actually overlap (not just touching)
    if (last.endTime > current.startTime) {
      // Merge: use outermost coordinates (min start, max end)
      last.startTime = Math.min(last.startTime, current.startTime);
      last.endTime = Math.max(last.endTime, current.endTime);
      // Combine titles if different
      if (last.title !== current.title && !last.title.includes(current.title)) {
        last.title = `${last.title} + ${current.title}`;
      }
      // Merge other metadata
      last.description = last.description || current.description;
      last.characters = [
        ...new Set([...last.characters, ...current.characters]),
      ];
      last.sceneTags = [...new Set([...last.sceneTags, ...current.sceneTags])];
      last.keyDialogue = last.keyDialogue || current.keyDialogue;
      last.confidence = Math.min(last.confidence, current.confidence);
    } else {
      result.push({ ...current });
    }
  }

  return result;
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
        // Note: merging happens on finalizeSegmentEdit (mouse release)
      }
    },

    // Called on mouse release to merge any overlapping segments
    finalizeSegmentEdit: (state) => {
      // Find the currently selected segment before merge
      const selectedSeg = state.selectedSegmentId
        ? state.segments.find((s) => s.id === state.selectedSegmentId)
        : null;

      const merged = mergeOverlappingSegments(state.segments);

      // Update selection if the segment was merged away
      if (
        selectedSeg &&
        !merged.find((s) => s.id === state.selectedSegmentId)
      ) {
        // Find the merged segment that contains the original segment's time
        const containingSegment = merged.find(
          (s) =>
            s.startTime <= selectedSeg.startTime &&
            s.endTime >= selectedSeg.endTime
        );
        state.selectedSegmentId = containingSegment?.id || null;
      }

      state.segments = merged;
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
      const defaultDuration = 10;
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

      // Merge any overlapping segments
      const merged = mergeOverlappingSegments(state.segments);
      state.segments = merged;

      // Select the segment containing the new time range
      const containingSegment = merged.find(
        (s) => s.startTime <= atTime && s.endTime >= atTime
      );
      state.selectedSegmentId = containingSegment?.id || newSegment.id;
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

    // Caption actions
    setTranscriptWords: (state, action: PayloadAction<CaptionWord[]>) => {
      state.transcriptWords = action.payload;
      // Automatically generate captions when transcript is loaded
      state.captions = groupWordsIntoCaptions(action.payload);
    },
    setCaptionSettings: (state, action: PayloadAction<CaptionSettings>) => {
      state.captionSettings = action.payload;
      // Note: setCaptionSettings from API load should NOT set dirty
    },
    updateCaptionStyle: (
      state,
      action: PayloadAction<Partial<CaptionStyle>>
    ) => {
      state.captionSettings.style = {
        ...state.captionSettings.style,
        ...action.payload,
      };
      state.isDirty = true;
    },
    setCaptionsEnabled: (state, action: PayloadAction<boolean>) => {
      state.captionSettings.enabled = action.payload;
      state.isDirty = true;
    },
    updateCaptionPosition: (
      state,
      action: PayloadAction<{ x: number; y: number }>
    ) => {
      state.captionSettings.style.position = action.payload;
      state.isDirty = true;
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
  finalizeSegmentEdit,
  splitSegment,
  addSegment,
  deleteSegment,
  setSyncing,
  markSynced,
  setCurrentTime,
  setDuration,
  // Caption actions
  setTranscriptWords,
  setCaptionSettings,
  updateCaptionStyle,
  setCaptionsEnabled,
  updateCaptionPosition,
  resetEditor,
} = editorSlice.actions;
export default editorSlice.reducer;
