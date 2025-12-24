import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type {
  CaptionSettings,
  CaptionWord,
  CaptionStyle,
  CaptionLine,
  SegmentFraming,
  AspectRatio,
  GlobalFramingSettings,
} from "@/remotion/types";
import {
  DEFAULT_CAPTION_SETTINGS,
  DEFAULT_SEGMENT_FRAMING,
  DEFAULT_GLOBAL_FRAMING,
} from "@/remotion/types";
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
  framing?: SegmentFraming;
}

interface EditorState {
  segments: Segment[];
  selectedSegmentId: string | null;
  currentTime: number;
  duration: number;
  projectTitle: string;
  assetName: string;
  // Sync tracking - uses version numbers to avoid race conditions
  projectId: string | null;
  localVersion: number; // Increments on each local edit
  syncedVersion: number; // Tracks last successfully synced version
  isSyncing: boolean;
  // Caption state
  transcriptWords: CaptionWord[];
  captions: CaptionLine[];
  captionSettings: CaptionSettings;
  // Framing state
  globalFraming: GlobalFramingSettings;
  // Last render - S3 URI for persistence, presigned URL for download
  lastRenderS3Uri: string | null;
  lastRenderUrl: string | null;
}

const initialState: EditorState = {
  segments: [],
  selectedSegmentId: null,
  currentTime: 0,
  duration: 0,
  projectTitle: "",
  assetName: "",
  // Sync tracking - uses version numbers to avoid race conditions
  projectId: null,
  localVersion: 0,
  syncedVersion: 0,
  isSyncing: false,
  // Caption state
  transcriptWords: [],
  captions: [],
  captionSettings: DEFAULT_CAPTION_SETTINGS,
  // Framing state
  globalFraming: DEFAULT_GLOBAL_FRAMING,
  // Last render
  lastRenderS3Uri: null,
  lastRenderUrl: null,
};

// Helper to mark state as edited (invalidates cached render)
const markEdited = (state: EditorState) => {
  state.localVersion++;
  state.lastRenderS3Uri = null;
  state.lastRenderUrl = null;
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
      // Reset sync state when loading a new project
      state.localVersion = 0;
      state.syncedVersion = 0;
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
      markEdited(state);
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
        markEdited(state);
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
        markEdited(state);
      }
    },
    addSegment: (state, action: PayloadAction<{ atTime: number }>) => {
      const { atTime } = action.payload;
      const defaultDuration = 60;
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
      markEdited(state);
    },
    deleteSegment: (state, action: PayloadAction<string>) => {
      const id = action.payload;
      state.segments = state.segments.filter((s) => s.id !== id);
      if (state.selectedSegmentId === id) {
        state.selectedSegmentId = null;
      }
      markEdited(state);
    },

    // Sync state management
    setSyncing: (state, action: PayloadAction<boolean>) => {
      state.isSyncing = action.payload;
    },
    markSynced: (state, action: PayloadAction<number>) => {
      // Only update syncedVersion to the version that was actually synced
      // This prevents race conditions where edits made during sync are lost
      state.syncedVersion = action.payload;
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
      markEdited(state);
    },
    setCaptionsEnabled: (state, action: PayloadAction<boolean>) => {
      state.captionSettings.enabled = action.payload;
      markEdited(state);
    },
    updateCaptionPosition: (
      state,
      action: PayloadAction<{ x: number; y: number }>
    ) => {
      state.captionSettings.style.position = action.payload;
      markEdited(state);
    },

    // Framing actions
    setGlobalFraming: (state, action: PayloadAction<GlobalFramingSettings>) => {
      state.globalFraming = action.payload;
      // Note: setGlobalFraming from API load should NOT set dirty
    },
    setGlobalAspectRatio: (state, action: PayloadAction<AspectRatio>) => {
      state.globalFraming.aspectRatio = action.payload;
      // Apply to all segments
      state.segments.forEach((segment) => {
        if (segment.framing) {
          segment.framing.aspectRatio = action.payload;
        } else {
          segment.framing = {
            ...DEFAULT_SEGMENT_FRAMING,
            aspectRatio: action.payload,
          };
        }
      });
      markEdited(state);
    },
    setFramingEnabled: (state, action: PayloadAction<boolean>) => {
      state.globalFraming.enabled = action.payload;
      markEdited(state);
    },
    setSegmentFraming: (
      state,
      action: PayloadAction<{ segmentId: string; framing: SegmentFraming }>
    ) => {
      const segment = state.segments.find(
        (s) => s.id === action.payload.segmentId
      );
      if (segment) {
        segment.framing = action.payload.framing;
        markEdited(state);
      }
    },
    updateSegmentFraming: (
      state,
      action: PayloadAction<{
        segmentId: string;
        framing: Partial<SegmentFraming>;
      }>
    ) => {
      const segment = state.segments.find(
        (s) => s.id === action.payload.segmentId
      );
      if (segment) {
        segment.framing = {
          ...(segment.framing || DEFAULT_SEGMENT_FRAMING),
          ...action.payload.framing,
          isAiGenerated: false, // User is overriding
        };
        markEdited(state);
      }
    },
    updateSegmentFocusX: (
      state,
      action: PayloadAction<{ segmentId: string; focusX: number }>
    ) => {
      const segment = state.segments.find(
        (s) => s.id === action.payload.segmentId
      );
      if (segment) {
        segment.framing = {
          ...(segment.framing || DEFAULT_SEGMENT_FRAMING),
          focusX: action.payload.focusX,
          isAiGenerated: false,
        };
        markEdited(state);
      }
    },
    applyFramingToAllSegments: (
      state,
      action: PayloadAction<Partial<SegmentFraming>>
    ) => {
      state.segments.forEach((segment) => {
        segment.framing = {
          ...(segment.framing || DEFAULT_SEGMENT_FRAMING),
          ...action.payload,
          isAiGenerated: false,
        };
      });
      markEdited(state);
    },

    // Reset state when leaving editor
    resetEditor: () => initialState,

    // Render tracking
    setLastRender: (
      state,
      action: PayloadAction<{ s3Uri: string; url: string }>
    ) => {
      state.lastRenderS3Uri = action.payload.s3Uri;
      state.lastRenderUrl = action.payload.url;
    },
    // Called when loading project - only presigned URL available
    setLastRenderUrl: (state, action: PayloadAction<string | null>) => {
      state.lastRenderUrl = action.payload;
    },
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
  // Framing actions
  setGlobalFraming,
  setGlobalAspectRatio,
  setFramingEnabled,
  setSegmentFraming,
  updateSegmentFraming,
  updateSegmentFocusX,
  applyFramingToAllSegments,
  resetEditor,
  // Render tracking
  setLastRender,
  setLastRenderUrl,
} = editorSlice.actions;
export default editorSlice.reducer;
