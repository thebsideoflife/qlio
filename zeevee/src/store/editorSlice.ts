import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type {
  CaptionSettings,
  CaptionWord,
  CaptionStyle,
  CaptionLine,
  SegmentFraming,
  FramingKeyframe,
  AspectRatio,
  GlobalFramingSettings,
} from "@/remotion/types";
import {
  DEFAULT_CAPTION_SETTINGS,
  DEFAULT_SEGMENT_FRAMING,
  DEFAULT_GLOBAL_FRAMING,
  getEffectiveKeyframes,
} from "@/remotion/types";
import { groupWordsIntoCaptions } from "@/remotion/utils";
import { isOriginalCaptionLanguage } from "@/lib/transcript";
import { reanchorKeyframesToTimeline } from "@/lib/timelineKeyframes";
import { sameFrame, snapTimeToFrame } from "@/remotion/framingInterpolation";

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
  selectedKeyframeId: string | null;
  currentTime: number;
  duration: number;
  projectTitle: string;
  assetName: string;
  assetId: string | null;
  // Sync tracking - uses version numbers to avoid race conditions
  projectId: string | null;
  localVersion: number; // Increments on each local edit
  syncedVersion: number; // Tracks last successfully synced version
  isSyncing: boolean;
  /** While the IQ agent is running it owns the cut server-side — autosave stands down. */
  agentRunActive: boolean;
  // Caption state
  transcriptWords: CaptionWord[];
  captions: CaptionLine[];
  captionSettings: CaptionSettings;
  originalLanguage: string | null;
  transcriptionVersion: string | null;
  transcriptionStatus: "pending" | "ready" | "failed" | null;
  translations: Record<string, string>;
  // Framing state
  globalFraming: GlobalFramingSettings;
  /** Probed source fps. Keyframe times snap to this clip-frame grid. */
  sourceFps: number | null;
  // Keyframe toggle — shows keyframe lane + framing controls
  showKeyframes: boolean;
  // Last rendered segments - cached to avoid re-renders
  lastSegmentRenders:
    | {
        segmentId: string;
        title: string;
        url: string;
        contentHash?: string;
      }[]
    | null;
  // Export metadata from Pegasus (cached on project)
  segmentMetadata: import("@/lib/segmentMetadataFingerprint").SegmentMetadataCache[] | null;
  projectThumbnailUrl: string | null;
  /** IQ panel inputs — `project.metadata` generation fields. */
  generationMetadata: GenerationMetadata | null;
}

/** Panel inputs stored on `project.metadata`. */
export interface GenerationMetadata {
  userPrompt?: string | null;
  purpose?: string | null;
  format?: string | null;
  assetType?: string | null;
  platform?: string | null;
  minSegmentDuration?: number | null;
  maxSegmentDuration?: number | null;
  targetPercent?: number | null;
}

const GENERATION_META_KEYS: (keyof GenerationMetadata)[] = [
  "userPrompt",
  "purpose",
  "format",
  "assetType",
  "platform",
  "minSegmentDuration",
  "maxSegmentDuration",
  "targetPercent",
];

function generationMetadataEqual(
  a: GenerationMetadata | null | undefined,
  b: GenerationMetadata,
): boolean {
  for (const key of GENERATION_META_KEYS) {
    if ((a?.[key] ?? null) !== (b[key] ?? null)) return false;
  }
  return true;
}

const initialState: EditorState = {
  segments: [],
  selectedSegmentId: null,
  selectedKeyframeId: null,
  currentTime: 0,
  duration: 0,
  projectTitle: "",
  assetName: "",
  assetId: null,
  // Sync tracking - uses version numbers to avoid race conditions
  projectId: null,
  localVersion: 0,
  syncedVersion: 0,
  isSyncing: false,
  agentRunActive: false,
  // Caption state
  transcriptWords: [],
  captions: [],
  captionSettings: DEFAULT_CAPTION_SETTINGS,
  originalLanguage: null,
  transcriptionVersion: null,
  transcriptionStatus: null,
  translations: {},
  // Framing state
  globalFraming: DEFAULT_GLOBAL_FRAMING,
  sourceFps: null,
  showKeyframes: false,
  // Last rendered segments
  lastSegmentRenders: null,
  segmentMetadata: null,
  projectThumbnailUrl: null,
  generationMetadata: null,
};

// Helper to mark state as edited
// Note: Does NOT clear lastSegmentRenders - user decides when to re-render
const markEdited = (state: EditorState) => {
  state.localVersion++;
};

// Minimum segment duration (100ms)
const MIN_SEGMENT_DURATION = 0.1;

// Short segment threshold — segments under 5s only get 1 keyframe
const SHORT_SEGMENT_THRESHOLD = 5;

// Deterministic ID counter for reducers (no Math.random in reducers)
let reducerIdCounter = 0;
function nextId(prefix: string) {
  return `${prefix}-${++reducerIdCounter}`;
}

/** Placement times live on the clip frame grid. Reanchor does not use this. */
function snapPlacementTime(time: number, fps: number | null): number {
  if (time <= 0) return 0;
  return snapTimeToFrame(time, fps);
}

function snapFramingPlacement(
  framing: SegmentFraming,
  fps: number | null,
): SegmentFraming {
  if (!framing.keyframes?.length) return framing;
  return {
    ...framing,
    keyframes: framing.keyframes.map((kf) => ({
      ...kf,
      time: snapPlacementTime(kf.time, fps),
    })),
  };
}

/**
 * Build a valid framing object for a sub-range of a segment.
 * Keyframes are filtered to the range [0, newDuration], times are offset,
 * and a keyframe at time=0 is guaranteed. Returns undefined if source has no framing.
 */
function sliceFraming(
  source: SegmentFraming | undefined,
  rangeStartInSegment: number,
  newDuration: number,
  fps: number | null,
): SegmentFraming | undefined {
  if (!source) return undefined;
  const kfs = getEffectiveKeyframes(source);
  const rangeEnd = rangeStartInSegment + newDuration;

  // Filter keyframes that fall within the new range, adjust times
  const sliced: FramingKeyframe[] = kfs
    .filter((kf) => kf.time >= rangeStartInSegment && kf.time < rangeEnd)
    .map((kf) => ({
      ...kf,
      id: nextId("kf-sl"),
      time: snapPlacementTime(kf.time - rangeStartInSegment, fps),
    }));

  // Sort after offset adjustment
  sliced.sort((a, b) => a.time - b.time);

  // Ensure there's always a keyframe at time 0
  if (sliced.length === 0 || sliced[0].time > 0) {
    const before = [...kfs]
      .filter((kf) => kf.time <= rangeStartInSegment)
      .sort((a, b) => b.time - a.time)[0];
    const base = before || kfs[0];
    sliced.unshift({
      ...base,
      id: nextId("kf-sl"),
      time: 0,
    });
  }

  // Clamp any keyframe that ended up past the new duration
  const clamped = sliced.filter((kf) => kf.time >= 0 && kf.time < newDuration);
  if (clamped.length === 0) {
    const fallback = sliced[0] || kfs[0];
    clamped.push({ ...fallback, time: 0, id: nextId("kf-fb") });
  }

  const result: SegmentFraming = {
    ...source,
    keyframes: clamped.sort((a, b) => a.time - b.time),
  };
  syncLegacyFromKeyframes(result);
  return result;
}

/**
 * Pin keyframes to the source timeline after a segment's start/end change.
 * Interior times stay put; the first/last settings stretch to the new bounds.
 */
function reanchorSegmentKeyframes(
  state: EditorState,
  segment: Segment,
  oldStart: number,
) {
  if (!segment.framing?.keyframes?.length) return;
  const before = segment.framing.keyframes.length;
  segment.framing.keyframes = reanchorKeyframesToTimeline(
    segment.framing.keyframes,
    oldStart,
    segment.startTime,
    segment.endTime,
  );
  if (segment.framing.keyframes.length === 0) {
    segment.framing.keyframes = [
      {
        id: nextId("kf-fb"),
        time: 0,
        focusX: segment.framing.focusX,
        focusY: segment.framing.focusY,
        zoom: segment.framing.mode === "crop" ? 1.0 : 0.0,
        isAiGenerated: false,
      },
    ];
  }
  syncLegacyFromKeyframes(segment.framing);
  if (
    before !== segment.framing.keyframes.length &&
    state.selectedKeyframeId &&
    !segment.framing.keyframes.some((kf) => kf.id === state.selectedKeyframeId)
  ) {
    state.selectedKeyframeId = segment.framing.keyframes[0]?.id ?? null;
  }
}

/** Sync legacy SegmentFraming fields from the first keyframe */
function syncLegacyFromKeyframes(framing: SegmentFraming) {
  const kfs = framing.keyframes;
  if (!kfs || kfs.length === 0) return;
  const sorted = [...kfs].sort((a, b) => a.time - b.time);
  const first = sorted[0];
  framing.focusX = first.focusX;
  framing.focusY = first.focusY;
  framing.mode = first.zoom >= 0.5 ? "crop" : "fit";
  framing.isAiGenerated = first.isAiGenerated;
  framing.aiReasoning = first.aiReasoning;
}

/**
 * Ensure framing.keyframes is a real array (not undefined/empty).
 * For legacy segments that only have top-level focusX/mode etc.,
 * this materializes a concrete keyframe from those fields.
 * Returns the materialized keyframes array (same reference as framing.keyframes).
 */
let materializeCounter = 0;
function ensureMaterializedKeyframes(
  framing: SegmentFraming,
): FramingKeyframe[] {
  if (framing.keyframes && framing.keyframes.length > 0) {
    return framing.keyframes;
  }
  framing.keyframes = getEffectiveKeyframes(framing).map((kf) => ({
    ...kf,
    id: `kf-mat-${++materializeCounter}`,
  }));
  return framing.keyframes;
}

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
      action: PayloadAction<{ title: string; assetName: string; assetId?: string | null }>,
    ) => {
      state.projectTitle = action.payload.title;
      state.assetName = action.payload.assetName;
      if (action.payload.assetId !== undefined) {
        state.assetId = action.payload.assetId;
      }
    },
    updateProjectTitle: (state, action: PayloadAction<string>) => {
      state.projectTitle = action.payload;
      markEdited(state);
    },
    setProjectTitleFromServer: (state, action: PayloadAction<string>) => {
      state.projectTitle = action.payload;
    },
    selectSegment: (state, action: PayloadAction<string | null>) => {
      state.selectedSegmentId = action.payload;
      state.selectedKeyframeId = null; // Reset keyframe selection when changing segments
    },
    updateSegmentTitle: (
      state,
      action: PayloadAction<{ id: string; title: string }>,
    ) => {
      const segment = state.segments.find((s) => s.id === action.payload.id);
      if (!segment) return;
      segment.title = action.payload.title;
      markEdited(state);
    },

    // Segment editing with push behavior - adjacent segments contract when one expands
    updateSegmentTime: (
      state,
      action: PayloadAction<{ id: string; start: number; end: number }>,
    ) => {
      const { id, start, end } = action.payload;
      const segmentIndex = state.segments.findIndex((s) => s.id === id);
      if (segmentIndex === -1) return;

      const segment = state.segments[segmentIndex];
      const oldStart = segment.startTime;
      const oldEnd = segment.endTime;

      // Sort segments by start time to find neighbors
      const sorted = [...state.segments].sort(
        (a, b) => a.startTime - b.startTime,
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
                const prevOldStart = prevSegInState.startTime;
                prevSegInState.endTime = newPrevEnd;
                reanchorSegmentKeyframes(state, prevSegInState, prevOldStart);
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
                const nextOldStart = nextSegInState.startTime;
                nextSegInState.startTime = newNextStart;
                reanchorSegmentKeyframes(state, nextSegInState, nextOldStart);
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
      reanchorSegmentKeyframes(state, segment, oldStart);

      markEdited(state);
    },

    // Called on mouse release — clean up keyframes after resize
    finalizeSegmentEdit: (state) => {
      state.segments = state.segments.filter(
        (s) => s.endTime - s.startTime >= MIN_SEGMENT_DURATION,
      );
      // Drop keyframes that fell outside during a live drag (idempotent
      // if updateSegmentTime already reanchored).
      for (const seg of state.segments) {
        reanchorSegmentKeyframes(state, seg, seg.startTime);
      }
    },
    splitSegment: (
      state,
      action: PayloadAction<{ id: string; atTime?: number }>,
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

        // Split time relative to segment start (for keyframe slicing)
        const splitRel = splitPoint - segment.startTime;
        const dur1 = splitRel;
        const dur2 = segment.endTime - splitPoint;

        const newSegment1: Segment = {
          ...segment,
          endTime: splitPoint,
          id: `${segment.id}-a`,
          title: `${segment.title} (Part 1)`,
          framing: sliceFraming(segment.framing, 0, dur1, state.sourceFps),
        };
        const newSegment2: Segment = {
          ...segment,
          startTime: splitPoint,
          id: `${segment.id}-b`,
          title: `${segment.title} (Part 2)`,
          framing: sliceFraming(segment.framing, splitRel, dur2, state.sourceFps),
        };

        state.segments.splice(index, 1, newSegment1, newSegment2);
        // Select the first half so the user stays oriented
        state.selectedSegmentId = newSegment1.id;
        state.selectedKeyframeId = null;
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
        (a, b) => a.startTime - b.startTime,
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
              const pushedOldStart = segInState.startTime;
              segInState.endTime = newEnd;
              reanchorSegmentKeyframes(state, segInState, pushedOldStart);
            }
          } else {
            // New segment is to the left, push existing segment right
            const newStart = endTime;
            if (segInState.endTime - newStart >= MIN_SEGMENT_DURATION) {
              const pushedOldStart = segInState.startTime;
              segInState.startTime = newStart;
              reanchorSegmentKeyframes(state, segInState, pushedOldStart);
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
    setAgentRunActive: (state, action: PayloadAction<boolean>) => {
      state.agentRunActive = action.payload;
      if (action.payload) {
        // The agent's writes are authoritative; anything queued locally would
        // only overwrite them with a staler copy.
        state.syncedVersion = state.localVersion;
      }
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
      // Dedupe words by timestamp (can happen from chunk overlap in long videos)
      const seen = new Set<string>();
      const dedupedWords = action.payload.filter((word) => {
        const key = `${word.start}-${word.end}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // Apply any existing word edits to the transcript
      const wordEdits = state.captionSettings.wordEdits || {};
      const transcriptWithEdits = dedupedWords.map((word) => {
        const key = `${word.start}-${word.end}`;
        // Check if key exists (not just truthy) to handle empty string deletions
        if (key in wordEdits) {
          return { ...word, value: wordEdits[key] };
        }
        return word;
      });
      state.transcriptWords = transcriptWithEdits;
      const active = state.captionSettings.activeLanguage;
      const showingOriginal =
        isOriginalCaptionLanguage(active, state.originalLanguage) ||
        !active ||
        !state.translations[active];
      if (showingOriginal) {
        state.captions = groupWordsIntoCaptions(transcriptWithEdits);
      }
    },
    setCaptionLanguageMeta: (
      state,
      action: PayloadAction<{
        originalLanguage: string | null;
        transcriptionVersion?: string | null;
        transcriptionStatus: "pending" | "ready" | "failed" | null;
        translations: Record<string, string>;
      }>,
    ) => {
      state.originalLanguage = action.payload.originalLanguage;
      if (action.payload.transcriptionVersion !== undefined) {
        state.transcriptionVersion = action.payload.transcriptionVersion;
      }
      state.transcriptionStatus = action.payload.transcriptionStatus;
      state.translations = action.payload.translations;
    },
    setTranslations: (
      state,
      action: PayloadAction<Record<string, string>>,
    ) => {
      state.translations = action.payload;
    },
    setCaptionLines: (state, action: PayloadAction<CaptionLine[]>) => {
      state.captions = action.payload;
    },
    setActiveCaptionLanguage: (
      state,
      action: PayloadAction<{ language: string; lines?: CaptionLine[] }>,
    ) => {
      state.captionSettings.activeLanguage = action.payload.language;
      if (action.payload.lines) {
        state.captions = action.payload.lines;
      } else {
        state.captions = groupWordsIntoCaptions(state.transcriptWords);
      }
      markEdited(state);
    },
    applyTranslatedCaptionLanguage: (
      state,
      action: PayloadAction<{
        language: string;
        lines: CaptionLine[];
        translationUrl: string;
        transcriptionVersion?: string | null;
      }>,
    ) => {
      if (state.transcriptionStatus !== "ready") return;
      const version = action.payload.transcriptionVersion;
      if (
        version &&
        state.transcriptionVersion &&
        version !== state.transcriptionVersion
      ) {
        return;
      }
      if (version) state.transcriptionVersion = version;
      state.translations[action.payload.language] =
        action.payload.translationUrl;
      state.captionSettings.activeLanguage = action.payload.language;
      state.captions = action.payload.lines;
      markEdited(state);
    },
    restoreActiveCaptionLanguage: (
      state,
      action: PayloadAction<{ language: string; lines?: CaptionLine[] }>,
    ) => {
      state.captionSettings.activeLanguage = action.payload.language;
      state.captions = action.payload.lines
        ? action.payload.lines
        : groupWordsIntoCaptions(state.transcriptWords);
    },
    setCaptionSettings: (state, action: PayloadAction<CaptionSettings>) => {
      state.captionSettings = action.payload;
      // Note: setCaptionSettings from API load should NOT set dirty
    },
    updateCaptionStyle: (
      state,
      action: PayloadAction<Partial<CaptionStyle>>,
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
      action: PayloadAction<{ x: number; y: number }>,
    ) => {
      state.captionSettings.style.position = action.payload;
      markEdited(state);
    },
    updateCaptionWord: (
      state,
      action: PayloadAction<{
        start: number;
        end: number;
        newValue: string;
      }>,
    ) => {
      const { start, end, newValue } = action.payload;
      const transcriptWord = state.transcriptWords.find(
        (word) =>
          Math.abs(word.start - start) < 0.01 &&
          Math.abs(word.end - end) < 0.01,
      );
      if (!transcriptWord) return;

      transcriptWord.value = newValue;
      const key = `${transcriptWord.start}-${transcriptWord.end}`;
      if (!state.captionSettings.wordEdits) {
        state.captionSettings.wordEdits = {};
      }
      state.captionSettings.wordEdits[key] = newValue;

      const active = state.captionSettings.activeLanguage;
      const showingOriginal =
        isOriginalCaptionLanguage(active, state.originalLanguage) ||
        !active ||
        !state.translations[active];
      if (showingOriginal) {
        state.captions = groupWordsIntoCaptions(state.transcriptWords);
      }
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
    setSquareTopEnabled: (state, action: PayloadAction<boolean>) => {
      state.globalFraming.squareTop = action.payload;
      markEdited(state);
    },
    setSourceFps: (state, action: PayloadAction<number | null>) => {
      state.sourceFps = action.payload;
    },
    setSegmentFraming: (
      state,
      action: PayloadAction<{ segmentId: string; framing: SegmentFraming }>,
    ) => {
      const segment = state.segments.find(
        (s) => s.id === action.payload.segmentId,
      );
      if (segment) {
        segment.framing = snapFramingPlacement(
          action.payload.framing,
          state.sourceFps,
        );
        markEdited(state);
      }
    },
    applyFramingUpdates: (
      state,
      action: PayloadAction<{
        updates: {
          segmentId: string;
          framing: SegmentFraming;
          atStartTime: number;
          atEndTime: number;
        }[];
      }>,
    ) => {
      let applied = false;
      for (const {
        segmentId,
        framing,
        atStartTime,
        atEndTime,
      } of action.payload.updates) {
        const segment = state.segments.find((s) => s.id === segmentId);
        if (!segment) continue;
        if (
          segment.startTime !== atStartTime ||
          segment.endTime !== atEndTime
        ) {
          continue;
        }
        segment.framing = snapFramingPlacement(framing, state.sourceFps);
        applied = true;
      }
      if (applied) markEdited(state);
    },
    updateSegmentFraming: (
      state,
      action: PayloadAction<{
        segmentId: string;
        framing: Partial<SegmentFraming>;
      }>,
    ) => {
      const segment = state.segments.find(
        (s) => s.id === action.payload.segmentId,
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
      action: PayloadAction<{ segmentId: string; focusX: number }>,
    ) => {
      const segment = state.segments.find(
        (s) => s.id === action.payload.segmentId,
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
      action: PayloadAction<Partial<SegmentFraming>>,
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

    toggleShowKeyframes: (state) => {
      state.showKeyframes = !state.showKeyframes;
    },

    // Keyframe CRUD actions
    selectKeyframe: (state, action: PayloadAction<string | null>) => {
      state.selectedKeyframeId = action.payload;
    },
    setSegmentKeyframes: (
      state,
      action: PayloadAction<{
        segmentId: string;
        keyframes: FramingKeyframe[];
      }>,
    ) => {
      const segment = state.segments.find(
        (s) => s.id === action.payload.segmentId,
      );
      if (!segment) return;
      if (!segment.framing) {
        segment.framing = { ...DEFAULT_SEGMENT_FRAMING };
      }
      segment.framing.keyframes = action.payload.keyframes
        .map((kf) => ({
          ...kf,
          time: snapPlacementTime(kf.time, state.sourceFps),
        }))
        .sort((a, b) => a.time - b.time);
      syncLegacyFromKeyframes(segment.framing);
      // Select first keyframe
      if (segment.framing.keyframes.length > 0) {
        state.selectedKeyframeId = segment.framing.keyframes[0].id;
      }
      markEdited(state);
    },
    addFramingKeyframe: (
      state,
      action: PayloadAction<{ segmentId: string; keyframe: FramingKeyframe }>,
    ) => {
      const segment = state.segments.find(
        (s) => s.id === action.payload.segmentId,
      );
      if (!segment || !segment.framing) return;
      // Enforce single keyframe for short segments
      const segDuration = segment.endTime - segment.startTime;
      if (segDuration < SHORT_SEGMENT_THRESHOLD) return;
      const kfs = ensureMaterializedKeyframes(segment.framing);
      const time = snapPlacementTime(
        action.payload.keyframe.time,
        state.sourceFps,
      );
      if (time <= 0 || time >= segDuration) return;
      if (kfs.some((k) => sameFrame(k.time, time, state.sourceFps))) return;
      kfs.push({
        ...action.payload.keyframe,
        time,
      });
      kfs.sort((a, b) => a.time - b.time);
      syncLegacyFromKeyframes(segment.framing);
      state.selectedKeyframeId = action.payload.keyframe.id;
      markEdited(state);
    },
    updateFramingKeyframe: (
      state,
      action: PayloadAction<{
        segmentId: string;
        keyframeId: string;
        changes: Partial<FramingKeyframe>;
      }>,
    ) => {
      const segment = state.segments.find(
        (s) => s.id === action.payload.segmentId,
      );
      if (!segment?.framing) return;
      const materialized = ensureMaterializedKeyframes(segment.framing);
      // Resolve the target keyframe — if caller used "legacy-0", find the first materialized one
      let targetId = action.payload.keyframeId;
      if (targetId === "legacy-0" && materialized.length > 0) {
        targetId = materialized[0].id;
        state.selectedKeyframeId = targetId;
      }
      const kf = materialized.find((k) => k.id === targetId);
      if (!kf) return;
      const changes = { ...action.payload.changes };
      if (changes.time != null) {
        changes.time = snapPlacementTime(changes.time, state.sourceFps);
      }
      Object.assign(kf, changes);
      kf.isAiGenerated = false; // User is overriding
      materialized.sort((a, b) => a.time - b.time);
      syncLegacyFromKeyframes(segment.framing);
      markEdited(state);
    },
    removeFramingKeyframe: (
      state,
      action: PayloadAction<{ segmentId: string; keyframeId: string }>,
    ) => {
      const segment = state.segments.find(
        (s) => s.id === action.payload.segmentId,
      );
      if (!segment?.framing) return;
      const kfs = ensureMaterializedKeyframes(segment.framing);
      // Enforce min 1 keyframe
      if (kfs.length <= 1) return;
      const kf = kfs.find((k) => k.id === action.payload.keyframeId);
      if (!kf) return;
      const sorted = [...kfs].sort((a, b) => a.time - b.time);
      const isFirst = sorted[0].id === kf.id;
      if (isFirst) {
        // Second keyframe absorbs the space — move it to time 0
        sorted[1].time = 0;
      }
      segment.framing.keyframes = kfs.filter(
        (k) => k.id !== action.payload.keyframeId,
      );
      syncLegacyFromKeyframes(segment.framing);
      // If we deleted the selected keyframe, select the new first one
      if (state.selectedKeyframeId === action.payload.keyframeId) {
        state.selectedKeyframeId = segment.framing.keyframes[0]?.id ?? null;
      }
      markEdited(state);
    },

    // Reset state when leaving editor
    resetEditor: () => initialState,

    // Render tracking - per-segment renders
    setLastSegmentRenders: (
      state,
      action: PayloadAction<
        {
          segmentId: string;
          title: string;
          url: string;
          contentHash?: string;
        }[]
      >,
    ) => {
      state.lastSegmentRenders = action.payload;
    },
    // Clear cache when user clicks re-render
    clearLastSegmentRenders: (state) => {
      state.lastSegmentRenders = null;
    },
    setSegmentMetadata: (
      state,
      action: PayloadAction<
        import("@/lib/segmentMetadataFingerprint").SegmentMetadataCache[]
      >,
    ) => {
      state.segmentMetadata = action.payload;
    },
    setProjectThumbnailUrl: (
      state,
      action: PayloadAction<string | null>,
    ) => {
      state.projectThumbnailUrl = action.payload;
    },
    /** Load from API — does not mark dirty. */
    setGenerationMetadata: (
      state,
      action: PayloadAction<GenerationMetadata | null>,
    ) => {
      state.generationMetadata = action.payload;
    },
    /** Producer edited panel inputs — picked up by the 10s project sync. */
    updateGenerationMetadata: (
      state,
      action: PayloadAction<GenerationMetadata>,
    ) => {
      const next: GenerationMetadata = {
        ...(state.generationMetadata ?? {}),
        ...action.payload,
      };
      if (generationMetadataEqual(state.generationMetadata, next)) return;
      state.generationMetadata = next;
      markEdited(state);
    },
  },
});

export const {
  setProjectId,
  setSegments,
  setProjectMetadata,
  updateProjectTitle,
  setProjectTitleFromServer,
  selectSegment,
  updateSegmentTitle,
  updateSegmentTime,
  finalizeSegmentEdit,
  splitSegment,
  addSegment,
  deleteSegment,
  setSyncing,
  markSynced,
  setAgentRunActive,
  setCurrentTime,
  setDuration,
  // Caption actions
  setTranscriptWords,
  setCaptionLanguageMeta,
  setTranslations,
  setCaptionLines,
  setActiveCaptionLanguage,
  applyTranslatedCaptionLanguage,
  restoreActiveCaptionLanguage,
  setCaptionSettings,
  updateCaptionStyle,
  setCaptionsEnabled,
  updateCaptionPosition,
  updateCaptionWord,
  // Framing actions
  setGlobalFraming,
  setGlobalAspectRatio,
  setFramingEnabled,
  setSquareTopEnabled,
  setSourceFps,
  setSegmentFraming,
  applyFramingUpdates,
  updateSegmentFraming,
  updateSegmentFocusX,
  applyFramingToAllSegments,
  // Keyframe actions
  toggleShowKeyframes,
  selectKeyframe,
  setSegmentKeyframes,
  addFramingKeyframe,
  updateFramingKeyframe,
  removeFramingKeyframe,
  resetEditor,
  // Render tracking
  setLastSegmentRenders,
  clearLastSegmentRenders,
  setSegmentMetadata,
  setProjectThumbnailUrl,
  setGenerationMetadata,
  updateGenerationMetadata,
} = editorSlice.actions;
export default editorSlice.reducer;
