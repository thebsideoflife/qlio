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

// Minimum segment duration (100ms)
const MIN_SEGMENT_DURATION = 0.1;

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

    // Segment editing with push behavior - adjacent segments contract when one expands
    updateSegmentTime: (
      state,
      action: PayloadAction<{ id: string; start: number; end: number }>
    ) => {
      const { id, start, end } = action.payload;
      const segmentIndex = state.segments.findIndex((s) => s.id === id);
      if (segmentIndex === -1) return;

      const segment = state.segments[segmentIndex];
      const oldStart = segment.startTime;
      const oldEnd = segment.endTime;

      // Sort segments by start time to find neighbors
      const sorted = [...state.segments].sort(
        (a, b) => a.startTime - b.startTime
      );
      const sortedIndex = sorted.findIndex((s) => s.id === id);

      let newStart = start;
      let newEnd = end;

      // Handle left edge expansion (start moved earlier)
      if (newStart < oldStart) {
        // Find segments that would overlap with the new start
        for (let i = sortedIndex - 1; i >= 0; i--) {
          const prev = sorted[i];
          if (prev.endTime > newStart) {
            // Push the previous segment's end to match our new start
            const prevSegInState = state.segments.find((s) => s.id === prev.id);
            if (prevSegInState) {
              const newPrevEnd = newStart;
              // Don't let the pushed segment become too small
              if (
                newPrevEnd - prevSegInState.startTime >=
                MIN_SEGMENT_DURATION
              ) {
                prevSegInState.endTime = newPrevEnd;
              } else {
                // Limit our expansion to not squeeze the neighbor below min
                newStart = prevSegInState.startTime + MIN_SEGMENT_DURATION;
              }
            }
          }
        }
      }

      // Handle left edge contraction (start moved later) - no push needed

      // Handle right edge expansion (end moved later)
      if (newEnd > oldEnd) {
        // Find segments that would overlap with the new end
        for (let i = sortedIndex + 1; i < sorted.length; i++) {
          const next = sorted[i];
          if (next.startTime < newEnd) {
            // Push the next segment's start to match our new end
            const nextSegInState = state.segments.find((s) => s.id === next.id);
            if (nextSegInState) {
              const newNextStart = newEnd;
              // Don't let the pushed segment become too small
              if (
                nextSegInState.endTime - newNextStart >=
                MIN_SEGMENT_DURATION
              ) {
                nextSegInState.startTime = newNextStart;
              } else {
                // Limit our expansion to not squeeze the neighbor below min
                newEnd = nextSegInState.endTime - MIN_SEGMENT_DURATION;
              }
            }
          }
        }
      }

      // Handle right edge contraction (end moved earlier) - no push needed

      // Apply the new times to the segment being edited
      segment.startTime = Math.max(0, newStart);
      segment.endTime = Math.min(state.duration, newEnd);

      markEdited(state);
    },

    // Called on mouse release - no merging needed with push behavior
    finalizeSegmentEdit: (state) => {
      // Just ensure segments are valid (no-op now, but kept for API compatibility)
      state.segments = state.segments.filter(
        (s) => s.endTime - s.startTime >= MIN_SEGMENT_DURATION
      );
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
      const startTime = atTime;
      const endTime = Math.min(atTime + defaultDuration, state.duration);

      // Don't add if it would be zero-length
      if (endTime <= startTime) return;

      // Push existing segments out of the way
      const sorted = [...state.segments].sort(
        (a, b) => a.startTime - b.startTime
      );

      for (const seg of sorted) {
        const segInState = state.segments.find((s) => s.id === seg.id);
        if (!segInState) continue;

        // If new segment overlaps with existing segment
        if (startTime < seg.endTime && endTime > seg.startTime) {
          // Push the existing segment's edge that's closer to the new segment center
          const newCenter = (startTime + endTime) / 2;
          if (newCenter > (seg.startTime + seg.endTime) / 2) {
            // New segment is to the right, push existing segment left
            const newEnd = startTime;
            if (newEnd - segInState.startTime >= MIN_SEGMENT_DURATION) {
              segInState.endTime = newEnd;
            }
          } else {
            // New segment is to the left, push existing segment right
            const newStart = endTime;
            if (segInState.endTime - newStart >= MIN_SEGMENT_DURATION) {
              segInState.startTime = newStart;
            }
          }
        }
      }

      const newSegment: Segment = {
        id: `seg-${Date.now()}`,
        startTime,
        endTime,
        title: "New Segment",
        description: "",
        characters: [],
        sceneTags: [],
        keyDialogue: "",
        confidence: 1,
      };

      state.segments.push(newSegment);
      state.selectedSegmentId = newSegment.id;
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
      // Default to crop mode for mobile aspect ratios (9:16)
      const isMobile = action.payload === "9:16";
      // Apply to all segments
      state.segments.forEach((segment) => {
        if (segment.framing) {
          segment.framing.aspectRatio = action.payload;
          // Also set mode to crop for mobile
          if (isMobile) {
            segment.framing.mode = "crop";
          }
        } else {
          segment.framing = {
            ...DEFAULT_SEGMENT_FRAMING,
            aspectRatio: action.payload,
            ...(isMobile && { mode: "crop" }),
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
