import type { WordEdit } from "./captionGrouping";

export interface CaptionWord {
  start: number;
  end: number;
  value: string;
}

export interface CaptionLine {
  id: string;
  startTime: number;
  endTime: number;
  /** When the last word ended; `endTime` may extend past it by the hold. */
  speechEndTime?: number;
  text: string;
  /** Present on Whisper originals. Translations are line text only. */
  words?: CaptionWord[];
}

export interface CaptionStyle {
  fontSize: number; // Percentage of video height
  fontFamily: string;
  fontWeight?: string; // CSS font-weight, e.g. "400", "600", "700"
  color: string;
  backgroundColor: string;
  position: { x: number; y: number }; // 0-100 percentage coordinates
  maxWidth: number; // Percentage of video width
  highlightColor?: string; // Color for active word, "none" for no animation
}

export interface CaptionSettings {
  enabled: boolean;
  style: CaptionStyle;
  /** key: the word's original "start-end"; value: new text (empty = deleted), or text plus corrected timing. */
  wordEdits?: Record<string, WordEdit>;
  /** ISO-639-1 of the captions currently shown / exported. Defaults to original. */
  activeLanguage?: string;
}

// Aspect ratio options for autoframing
export type AspectRatio = "9:16" | "1:1" | "16:9";

// Framing mode: crop focuses on a subject, fit shows the full scene
export type FramingMode = "crop" | "fit";

// A single framing keyframe within a segment
export interface FramingKeyframe {
  id: string; // unique ID for UI operations
  time: number; // seconds from segment start. Placement is n / fps (clip frame grid). Resizing pins interiors to the source timeline.
  focusX: number; // 0.0-1.0
  focusY: number; // 0.0-1.0
  zoom: number; // 0.0=fit (full frame visible), 1.0=max crop (tightest)
  aiReasoning?: string;
  isAiGenerated: boolean;
}

// Framing settings for a segment
export interface SegmentFraming {
  aspectRatio: AspectRatio;
  mode: FramingMode; // legacy compat — derived from first keyframe zoom
  focusX: number; // legacy compat — first keyframe value
  focusY: number; // legacy compat
  aiReasoning?: string;
  isAiGenerated: boolean;
  keyframes?: FramingKeyframe[]; // if empty/undefined, legacy fields = single keyframe
}

/**
 * Convert a SegmentFraming to an array of keyframes.
 * If the framing already has keyframes, returns them.
 * Otherwise, synthesizes a single keyframe from the legacy fields.
 */
export function getEffectiveKeyframes(
  framing: SegmentFraming,
): FramingKeyframe[] {
  if (framing.keyframes?.length) return framing.keyframes;
  return [
    {
      id: "legacy-0",
      time: 0,
      focusX: framing.focusX,
      focusY: framing.focusY,
      zoom: framing.mode === "crop" ? 1.0 : 0.0,
      isAiGenerated: framing.isAiGenerated,
      aiReasoning: framing.aiReasoning,
    },
  ];
}

// Default framing settings
export const DEFAULT_SEGMENT_FRAMING: SegmentFraming = {
  aspectRatio: "9:16",
  mode: "fit",
  focusX: 0.5,
  focusY: 0.5,
  isAiGenerated: false,
};

export interface Segment {
  id: string;
  startTime: number;
  endTime: number;
  title: string;
  framing?: SegmentFraming;
}

// Global framing settings that apply to the entire video
export interface GlobalFramingSettings {
  aspectRatio: AspectRatio;
  enabled: boolean;
  // Square-top portrait mode: render the source video as a 1:1 square aligned to
  // the top of a 9:16 frame (black below). Wipes out all per-segment keyframe
  // framing while on (non-destructive — toggle off to restore). Only honored
  // when `enabled === true`.
  squareTop?: boolean;
}

export const DEFAULT_GLOBAL_FRAMING: GlobalFramingSettings = {
  aspectRatio: "9:16",
  enabled: true,
  squareTop: false,
};

export type CaptionedVideoProps = {
  videoUrl: string;
  segments: Segment[];
  captions: CaptionLine[];
  captionSettings: CaptionSettings;
  globalFraming?: GlobalFramingSettings;
  /** Source video width/height. Defaults to 16:9 when omitted. */
  sourceAspect?: number;
  /** Source video frame rate. When set, calculateMetadata uses it as composition fps. */
  sourceFps?: number;
};

// Snap positions for caption placement
export const SNAP_POSITIONS = [
  { x: 50, y: 10, label: "Top" },
  { x: 50, y: 50, label: "Center" },
  { x: 50, y: 85, label: "Bottom" },
] as const;

export const DEFAULT_CAPTION_SETTINGS: CaptionSettings = {
  enabled: true,
  style: {
    fontSize: 3,
    fontFamily: "Inter, system-ui, sans-serif",
    fontWeight: "600",
    color: "#ffffff",
    backgroundColor: "rgba(0,0,0,0.5)",
    position: { x: 50, y: 85 },
    maxWidth: 95,
    highlightColor: "#60a5fa",
  },
};
