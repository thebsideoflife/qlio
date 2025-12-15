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

export interface Segment {
  id: string;
  startTime: number;
  endTime: number;
  title: string;
}

export type CaptionedVideoProps = {
  videoUrl: string;
  segments: Segment[];
  captions: CaptionLine[];
  captionSettings: CaptionSettings;
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
