import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Tv,
  Film,
  Sparkles,
  Loader2,
  Wand2,
  Smartphone,
  PlayCircle,
  Repeat,
  ListVideo,
  LayoutGrid,
  Scissors,
  FileQuestion,
} from "lucide-react";
import { FaTiktok, FaInstagram, FaFacebook } from "react-icons/fa";
import { SiYoutubeshorts } from "react-icons/si";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { IconType } from "react-icons";
import type { GenerationJob } from "@/services/api";

export interface GenerateRequest {
  userPrompt: string;
  /** From Retain: null when "Auto", else 25 / 50 / 75 */
  targetPercent: number | null;
  /** Segment duration bounds in seconds */
  minSegmentDuration: number;
  maxSegmentDuration: number;
  /** Pass-through metadata */
  format: string;
  assetType: string;
  platform: string;
}

interface MicrodramaGeneratorProps {
  onGenerate: (request: GenerateRequest) => Promise<void>;
  isGenerating: boolean;
  generationStatus?: GenerationJob | null;
  initialUserPrompt?: string;
  autoFrameEnabled: boolean;
  onAutoFrameChange: (enabled: boolean) => void;
}

type Option = {
  value: string;
  label: string;
  icon: LucideIcon | IconType;
  tooltip: string;
};

// Asset Type options
const ASSET_TYPES: Option[] = [
  { value: "tv", label: "TV", icon: Tv, tooltip: "Television series" },
  { value: "movie", label: "Movie", icon: Film, tooltip: "Feature film" },
  {
    value: "other",
    label: "Other",
    icon: FileQuestion,
    tooltip: "Other content",
  },
];

// Distribution Platform options (removed Auto and YouTube)
const PLATFORMS: Option[] = [
  { value: "mobile", label: "Mobile", icon: Smartphone, tooltip: "Mobile app" },
  { value: "tv", label: "Smart TV", icon: Tv, tooltip: "Connected TV" },
  { value: "tiktok", label: "TikTok", icon: FaTiktok, tooltip: "TikTok" },
  {
    value: "ig",
    label: "Reels",
    icon: FaInstagram,
    tooltip: "Instagram Reels",
  },
  {
    value: "shorts",
    label: "Shorts",
    icon: SiYoutubeshorts,
    tooltip: "YouTube Shorts",
  },
  {
    value: "facebook",
    label: "Facebook",
    icon: FaFacebook,
    tooltip: "Facebook",
  },
];

// Format options (removed Tune-In, Bridge, Social)
const FORMATS: Option[] = [
  {
    value: "compact_video",
    label: "Compact",
    icon: Scissors,
    tooltip: "Condense video to target %",
  },
  {
    value: "full_video",
    label: "Full Video",
    icon: LayoutGrid,
    tooltip: "Split into chapters (1-3 min each)",
  },
  {
    value: "highlights",
    label: "Highlights",
    icon: Sparkles,
    tooltip: "Best moments",
  },
  {
    value: "trailer",
    label: "Trailer",
    icon: PlayCircle,
    tooltip: "Promo preview",
  },
  {
    value: "episode_recap",
    label: "Ep Recap",
    icon: Repeat,
    tooltip: "Episode summary",
  },
  {
    value: "season_recap",
    label: "Season Recap",
    icon: ListVideo,
    tooltip: "Season summary",
  },
];

// Retain percentage options — "auto" = no fixed % target (backend)
const RETAIN_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "25", label: "25%" },
  { value: "50", label: "50%" },
  { value: "75", label: "75%" },
];

// Segment duration defaults per format
const SEGMENT_DURATION_DEFAULTS: Record<string, { min: number; max: number }> = {
  highlights: { min: 5, max: 30 },
  compact_video: { min: 60, max: 180 },
  full_video: { min: 60, max: 180 },
  trailer: { min: 60, max: 180 },
  episode_recap: { min: 60, max: 180 },
  season_recap: { min: 60, max: 180 },
};

// Default selections
const DEFAULT_ASSET_TYPE = "tv";
const DEFAULT_PLATFORM = "mobile";
const DEFAULT_FORMAT = "compact_video";
const DEFAULT_RETAIN = "auto";

function retainToTargetPercent(retain: string): number | null {
  if (retain === "auto") return null;
  const n = parseInt(retain, 10);
  if (n === 25 || n === 50 || n === 75) return n;
  return null;
}

export function MicrodramaGenerator({
  onGenerate,
  isGenerating,
  generationStatus,
  initialUserPrompt,
  autoFrameEnabled,
  onAutoFrameChange,
}: MicrodramaGeneratorProps) {
  const [userPrompt, setUserPrompt] = useState(initialUserPrompt || "");

  const [assetType, setAssetType] = useState(DEFAULT_ASSET_TYPE);
  const [platform, setPlatform] = useState(DEFAULT_PLATFORM);
  const [format, setFormat] = useState(DEFAULT_FORMAT);
  const [retain, setRetain] = useState(DEFAULT_RETAIN);

  // Duration bounds state - initialized from format defaults
  const [minDuration, setMinDuration] = useState(
    SEGMENT_DURATION_DEFAULTS[DEFAULT_FORMAT].min,
  );
  const [maxDuration, setMaxDuration] = useState(
    SEGMENT_DURATION_DEFAULTS[DEFAULT_FORMAT].max,
  );

  // Update duration bounds when format changes
  const handleFormatChange = (newFormat: string) => {
    setFormat(newFormat);
    const defaults = SEGMENT_DURATION_DEFAULTS[newFormat] || SEGMENT_DURATION_DEFAULTS.compact_video;
    setMinDuration(defaults.min);
    setMaxDuration(defaults.max);
  };

  // Show Retain picker only for compact_video and highlights
  const showRetainPicker = format === "compact_video" || format === "highlights";

  const maxLength = 500;
  const remaining = maxLength - userPrompt.length;

  const handleGenerate = () => {
    onGenerate({
      userPrompt,
      targetPercent: showRetainPicker ? retainToTargetPercent(retain) : null,
      minSegmentDuration: minDuration,
      maxSegmentDuration: maxDuration,
      format,
      assetType,
      platform,
    });
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-full bg-background">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/50">
          <div className="p-1.5 rounded-md bg-blue-500/10">
            <Wand2 className="h-4 w-4 text-blue-500" />
          </div>
          <span className="font-semibold">IQ Editor</span>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* Asset Type - clickable but visual only */}
          <DemoSection label="Asset Type">
            <DemoOptionGrid
              options={ASSET_TYPES}
              selectedValue={assetType}
              onSelect={setAssetType}
              columns={3}
            />
          </DemoSection>

          {/* Dist. Platform - clickable but visual only */}
          <DemoSection label="Dist. Platform">
            <DemoOptionGrid
              options={PLATFORMS}
              selectedValue={platform}
              onSelect={setPlatform}
              columns={3}
            />
          </DemoSection>

          {/* Format */}
          <DemoSection label="Format">
            <DemoOptionGrid
              options={FORMATS}
              selectedValue={format}
              onSelect={handleFormatChange}
              columns={3}
            />
          </DemoSection>

          {/* Retain - only for compact_video and highlights */}
          {showRetainPicker && (
            <DemoSection label="Retain">
              <DemoRetainPicker
                options={RETAIN_OPTIONS}
                selectedValue={retain}
                onSelect={setRetain}
              />
            </DemoSection>
          )}

          {/* Segment Duration */}
          <DemoSection label="Segment Duration">
            <DemoDurationPicker
              minValue={minDuration}
              maxValue={maxDuration}
              onMinChange={setMinDuration}
              onMaxChange={setMaxDuration}
              minBound={2}
              maxBound={300}
            />
          </DemoSection>

          {/* Instructions - Functional */}
          <div className="space-y-3">
            <div className="space-y-1">
              <textarea
                value={userPrompt}
                onChange={(e) =>
                  setUserPrompt(e.target.value.slice(0, maxLength))
                }
                maxLength={maxLength}
                placeholder="Any special instructions? (optional)"
                className="w-full h-24 px-3 py-2.5 text-sm rounded-lg bg-card border-2 border-dashed border-border focus:border-blue-400 focus:border-solid focus:outline-none resize-none placeholder:text-muted-foreground/50"
              />
              {userPrompt.length > 0 && (
                <div
                  className={cn(
                    "text-xs text-right",
                    remaining < 50
                      ? "text-amber-500"
                      : "text-muted-foreground/60",
                  )}
                >
                  {remaining}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Generate Button */}
        <div className="p-4 border-t bg-muted/50 space-y-3">
          {/* Auto-frame toggle */}
          <div className="flex items-center justify-between px-1">
            <Label
              htmlFor="auto-frame-toggle"
              className="text-xs font-semibold text-muted-foreground cursor-pointer"
            >
              Auto-frame after generating
            </Label>
            <Switch
              id="auto-frame-toggle"
              checked={autoFrameEnabled}
              onCheckedChange={onAutoFrameChange}
              disabled={isGenerating}
            />
          </div>

          <Button
            onClick={handleGenerate}
            disabled={isGenerating}
            className="w-full h-11 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-lg disabled:opacity-40 font-semibold text-sm"
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {generationStatus?.status === "pending" &&
                  "Starting Analysis..."}
                {generationStatus?.status === "generating" &&
                  "Generating Segments..."}
                {generationStatus?.status === "framing" &&
                  "Applying Framing..."}
                {!generationStatus && "Analyzing Video..."}
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                Generate Segments
              </>
            )}
          </Button>
          {isGenerating && generationStatus && (
            <p className="text-xs text-muted-foreground text-center">
              {generationStatus.status === "framing"
                ? "Analyzing framing for each segment..."
                : "This may take 1-2 minutes for longer videos"}
            </p>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

/* ============ Demo Components (Display Only) ============ */

function DemoSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {label}
      </Label>
      {children}
    </div>
  );
}

function DemoOptionGrid({
  options,
  selectedValue,
  onSelect,
  columns = 3,
}: {
  options: Option[];
  selectedValue: string;
  onSelect: (value: string) => void;
  columns?: number;
}) {
  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {options.map((opt) => {
        const isSelected = selectedValue === opt.value;
        return (
          <Tooltip key={opt.value}>
            <TooltipTrigger asChild>
              <button
                onClick={() => onSelect(opt.value)}
                className={cn(
                  "flex flex-col items-center gap-1 p-2.5 rounded-lg border-2 transition-all",
                  isSelected
                    ? "bg-blue-600 border-blue-600 text-white shadow-md"
                    : "bg-card border-border hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30",
                )}
              >
                <opt.icon
                  className={cn(
                    "h-5 w-5",
                    isSelected ? "text-white" : "text-muted-foreground",
                  )}
                />
                <span
                  className={cn(
                    "text-[10px] font-semibold leading-tight text-center",
                    isSelected ? "text-white" : "text-foreground",
                  )}
                >
                  {opt.label}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{opt.tooltip}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

function DemoRetainPicker({
  options,
  selectedValue,
  onSelect,
}: {
  options: { value: string; label: string }[];
  selectedValue: string;
  onSelect: (value: string) => void;
}) {
  return (
    <div className="flex gap-2">
      {options.map((opt) => {
        const isSelected = selectedValue === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => onSelect(opt.value)}
            className={cn(
              "px-4 py-2 rounded-xl text-sm font-medium transition-all",
              isSelected
                ? "bg-blue-600 text-white shadow-md"
                : "bg-card border-2 border-border hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30",
            )}
          >
            {opt.label}
          </button>
        );
      })}
      <div className="px-4 py-2 rounded-xl text-sm font-medium bg-card border-2 border-dashed border-border text-muted-foreground">
        Other
      </div>
    </div>
  );
}

function DemoDurationPicker({
  minValue,
  maxValue,
  onMinChange,
  onMaxChange,
  minBound,
  maxBound,
}: {
  minValue: number;
  maxValue: number;
  onMinChange: (value: number) => void;
  onMaxChange: (value: number) => void;
  minBound: number;
  maxBound: number;
}) {
  const handleMinChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    if (!isNaN(val) && val >= minBound && val < maxValue) {
      onMinChange(val);
    }
  };

  const handleMaxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    if (!isNaN(val) && val > minValue && val <= maxBound) {
      onMaxChange(val);
    }
  };

  return (
    <div className="flex gap-3">
      <div className="flex-1">
        <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1 block">
          Min (sec)
        </label>
        <input
          type="number"
          value={minValue}
          onChange={handleMinChange}
          min={minBound}
          max={maxValue - 1}
          className="w-full px-3 py-2 text-sm rounded-lg bg-card border-2 border-border focus:border-blue-400 focus:outline-none"
        />
      </div>
      <div className="flex-1">
        <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1 block">
          Max (sec)
        </label>
        <input
          type="number"
          value={maxValue}
          onChange={handleMaxChange}
          min={minValue + 1}
          max={maxBound}
          className="w-full px-3 py-2 text-sm rounded-lg bg-card border-2 border-border focus:border-blue-400 focus:outline-none"
        />
      </div>
    </div>
  );
}
