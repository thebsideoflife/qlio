export interface CaptionWord {
  start: number;
  end: number;
  value: string;
}

export interface CaptionLine {
  id: string;
  startTime: number;
  endTime: number;
  text: string;
  words: CaptionWord[];
}

export interface CaptionStyle {
  fontSize: number; // Percentage of video height
  fontFamily: string;
  color: string;
  backgroundColor: string;
  position: { x: number; y: number }; // 0-100 percentage coordinates
  maxWidth: number; // Percentage of video width
  highlightColor?: string; // Color for active word, "none" for no animation
}

export interface CaptionSettings {
  enabled: boolean;
  style: CaptionStyle;
}

// Aspect ratio options for autoframing
export type AspectRatio = "9:16" | "1:1" | "16:9";

// Framing mode: crop focuses on a subject, fit shows the full scene
export type FramingMode = "crop" | "fit";

// Framing settings for a segment
export interface SegmentFraming {
  aspectRatio: AspectRatio;
  mode: FramingMode;
  focusX: number; // 0.0-1.0, horizontal focus point (0=left, 0.5=center, 1=right)
  focusY: number; // 0.0-1.0, vertical focus point (0=top, 0.5=center, 1=bottom)
  aiReasoning?: string; // AI explanation: "Multi-speaker detected", "Single speaker on right"
  isAiGenerated: boolean; // true if AI-generated, false if user overrode
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
}

export const DEFAULT_GLOBAL_FRAMING: GlobalFramingSettings = {
  aspectRatio: "9:16",
  enabled: true,
};

export type CaptionedVideoProps = {
  videoUrl: string;
  segments: Segment[];
  captions: CaptionLine[];
  captionSettings: CaptionSettings;
  globalFraming?: GlobalFramingSettings;
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
    fontSize: 5,
    fontFamily: "Inter, system-ui, sans-serif",
    color: "#ffffff",
    backgroundColor: "rgba(0, 0, 0, 0.8)",
    position: { x: 50, y: 85 },
    maxWidth: 80,
    highlightColor: "#fbbf24",
  },
};
