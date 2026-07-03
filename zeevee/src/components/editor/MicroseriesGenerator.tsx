import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
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
import type { GenerationMetadata } from "@/hooks/useProjectData";

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
  /** Use Jockey pipeline for Compact / Ep Recap (backend env flags must also be on) */
  jockeyEnabled: boolean;
}

interface MicroseriesGeneratorProps {
  onGenerate: (request: GenerateRequest) => Promise<void>;
  isGenerating: boolean;
  generationStatus?: GenerationJob | null;
  /** Restored from project.metadata after load — not sent on every generate call */
  savedInputs?: GenerationMetadata | null;
  autoFrameEnabled: boolean;
  onAutoFrameChange: (enabled: boolean) => void;
  onPlatformChange?: (platform: string) => void;
}

type Option = {
  value: string;
  label: string;
  icon: LucideIcon | IconType;
  tooltip: string;
  disabled?: boolean;
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
  {
    value: "tiktok",
    label: "TikTok",
    icon: FaTiktok,
    tooltip: "TikTok",
    disabled: true,
  },
  {
    value: "ig",
    label: "Reels",
    icon: FaInstagram,
    tooltip: "Instagram Reels",
    disabled: true,
  },
  {
    value: "shorts",
    label: "Shorts",
    icon: SiYoutubeshorts,
    tooltip: "YouTube Shorts",
    disabled: true,
  },
  {
    value: "facebook",
    label: "Facebook",
    icon: FaFacebook,
    tooltip: "Facebook",
    disabled: true,
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
    value: "highlights",
    label: "Highlights",
    icon: Sparkles,
    tooltip: "Best moments",
  },
  {
    value: "episode_recap",
    label: "Ep Recap",
    icon: Repeat,
    tooltip: "Previously on... 4-6 beats, ~1-1.5 min",
  },
  {
    value: "full_video",
    label: "Full Video",
    icon: LayoutGrid,
    tooltip: "Split into chapters (1-3 min each)",
  },
  {
    value: "trailer",
    label: "Trailer",
    icon: PlayCircle,
    tooltip: "Promo preview",
    disabled: true,
  },
  {
    value: "season_recap",
    label: "Season Recap",
    icon: ListVideo,
    tooltip: "Season summary",
    disabled: true,
  },
];

// Segment duration defaults per format
const SEGMENT_DURATION_DEFAULTS: Record<string, { min: number; max: number }> = {
  highlights: { min: 5, max: 30 },
  compact_video: { min: 60, max: 180 },
  full_video: { min: 60, max: 180 },
  trailer: { min: 60, max: 180 },
  episode_recap: { min: 10, max: 20 },
  season_recap: { min: 60, max: 180 },
};

// Percent presets for compact video
const PERCENT_OPTIONS = [
  { value: "auto", label: "Auto", tooltip: "Let AI decide" },
  { value: "25", label: "25%", tooltip: "Quarter of original" },
  { value: "50", label: "50%", tooltip: "Half of original" },
  { value: "75", label: "75%", tooltip: "Three quarters" },
];

// Default selections
const DEFAULT_ASSET_TYPE = "tv";
const DEFAULT_PLATFORM = "mobile";
const DEFAULT_FORMAT = "compact_video";

const RETAIN_ENABLED = false;

function resolveSavedFormat(saved: GenerationMetadata): string {
  const candidate = saved.format || saved.purpose;
  if (candidate && candidate in SEGMENT_DURATION_DEFAULTS) {
    const option = FORMATS.find((o) => o.value === candidate);
    if (option && !option.disabled) {
      return candidate;
    }
  }
  return DEFAULT_FORMAT;
}

export function MicroseriesGenerator({
  onGenerate,
  isGenerating,
  generationStatus,
  savedInputs,
  autoFrameEnabled,
  onAutoFrameChange,
  onPlatformChange,
}: MicroseriesGeneratorProps) {
  const [userPrompt, setUserPrompt] = useState("");

  const [assetType, setAssetType] = useState(DEFAULT_ASSET_TYPE);
  const [platform, setPlatform] = useState(DEFAULT_PLATFORM);
  const [format, setFormat] = useState(DEFAULT_FORMAT);

  // Target percent for compact_video mode ("auto" means let AI decide)
  const [targetPercent, setTargetPercent] = useState<string>("auto");

  const [jockeyEnabled, setJockeyEnabled] = useState(false);

  // Duration bounds state - initialized from format defaults
  const [minDuration, setMinDuration] = useState(
    SEGMENT_DURATION_DEFAULTS[DEFAULT_FORMAT].min,
  );
  const [maxDuration, setMaxDuration] = useState(
    SEGMENT_DURATION_DEFAULTS[DEFAULT_FORMAT].max,
  );

  useEffect(() => {
    if (!savedInputs) return;

    setUserPrompt(savedInputs.userPrompt?.trim() || "");

    const restoredFormat = resolveSavedFormat(savedInputs);
    setFormat(restoredFormat);

    const formatDefaults =
      SEGMENT_DURATION_DEFAULTS[restoredFormat] ||
      SEGMENT_DURATION_DEFAULTS.compact_video;
    setMinDuration(
      typeof savedInputs.minSegmentDuration === "number"
        ? savedInputs.minSegmentDuration
        : formatDefaults.min,
    );
    setMaxDuration(
      typeof savedInputs.maxSegmentDuration === "number"
        ? savedInputs.maxSegmentDuration
        : formatDefaults.max,
    );

    if (
      savedInputs.targetPercent != null &&
      savedInputs.targetPercent > 0 &&
      savedInputs.targetPercent <= 100
    ) {
      setTargetPercent(String(savedInputs.targetPercent));
    } else {
      setTargetPercent("auto");
    }

    if (
      savedInputs.assetType &&
      ASSET_TYPES.some((o) => o.value === savedInputs.assetType)
    ) {
      setAssetType(savedInputs.assetType);
    }

    if (
      savedInputs.platform &&
      PLATFORMS.some((o) => o.value === savedInputs.platform)
    ) {
      setPlatform(savedInputs.platform);
      onPlatformChange?.(savedInputs.platform);
    }
    // Only restore when project metadata loads — not when parent callbacks change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedInputs]);

  // Whether we're in compact video mode
  const isCompactVideo = format === "compact_video";
  const isJockeyFormat =
    format === "compact_video" || format === "episode_recap";

  // Update duration bounds when format changes
  const handleFormatChange = (newFormat: string) => {
    setFormat(newFormat);
    const defaults = SEGMENT_DURATION_DEFAULTS[newFormat] || SEGMENT_DURATION_DEFAULTS.compact_video;
    setMinDuration(defaults.min);
    setMaxDuration(defaults.max);
    // Reset to Auto when switching to compact video
    if (newFormat === "compact_video") {
      setTargetPercent("auto");
    }
  };


  const maxLength = 8000;
  const remaining = maxLength - userPrompt.length;

  const handleGenerate = () => {
    onGenerate({
      userPrompt,
      targetPercent:
        RETAIN_ENABLED && isCompactVideo && targetPercent !== "auto"
          ? parseInt(targetPercent, 10)
          : null,
      minSegmentDuration: minDuration,
      maxSegmentDuration: maxDuration,
      format,
      assetType,
      platform,
      jockeyEnabled: isJockeyFormat && jockeyEnabled,
    });
  };

  return (
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
              onSelect={(value) => {
                setPlatform(value);
                onPlatformChange?.(value);
              }}
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

          {/* Retain Percentage - only for compact_video */}
          {isCompactVideo && (
            <DemoSection label="Retain">
              <RetainPicker
                selected={targetPercent}
                onSelect={setTargetPercent}
                disabled={!RETAIN_ENABLED}
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
                onKeyDown={(e) => e.stopPropagation()}
                maxLength={maxLength}
                placeholder="Any special instructions? (optional)"
                className="w-full h-40 px-3 py-2.5 text-sm rounded-lg bg-card border-2 border-dashed border-border focus:border-blue-400 focus:border-solid focus:outline-none resize-y min-h-32 placeholder:text-muted-foreground/50"
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
          {isJockeyFormat && (
            <div className="flex items-center justify-between px-1">
              <Label
                htmlFor="jockey-toggle"
                className="text-xs font-semibold text-muted-foreground cursor-pointer"
              >
                Jockey mode
              </Label>
              <Switch
                id="jockey-toggle"
                checked={jockeyEnabled}
                onCheckedChange={setJockeyEnabled}
              />
            </div>
          )}

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
                : "Stay tuned — this may take a few minutes for longer videos."}
            </p>
          )}
        </div>
      </div>
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
        const isDisabled = opt.disabled === true;
        return (
          <Tooltip key={opt.value}>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={isDisabled}
                onClick={() => {
                  if (!isDisabled) onSelect(opt.value);
                }}
                className={cn(
                  "flex flex-col items-center gap-1 p-2.5 rounded-lg border-2 transition-all",
                  isDisabled && "cursor-not-allowed",
                  isDisabled && !isSelected && "opacity-50",
                  isSelected && !isDisabled &&
                    "bg-blue-600 border-blue-600 text-white shadow-md",
                  isSelected && isDisabled &&
                    "bg-blue-100 border-blue-300 text-blue-800 dark:bg-blue-950/60 dark:border-blue-700 dark:text-blue-300",
                  !isSelected &&
                    "bg-card border-border hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30",
                  isDisabled && "hover:border-border hover:bg-card",
                )}
              >
                <opt.icon
                  className={cn(
                    "h-5 w-5",
                    isSelected && !isDisabled && "text-white",
                    isSelected && isDisabled &&
                      "text-blue-700 dark:text-blue-300",
                    !isSelected && "text-muted-foreground",
                  )}
                />
                <span
                  className={cn(
                    "text-[10px] font-semibold leading-tight text-center",
                    isSelected && !isDisabled && "text-white",
                    isSelected && isDisabled &&
                      "text-blue-800 dark:text-blue-300",
                    !isSelected && "text-foreground",
                  )}
                >
                  {opt.label}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {isDisabled ? "Coming soon" : opt.tooltip}
            </TooltipContent>
          </Tooltip>
        );
      })}
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
  const [minInput, setMinInput] = useState(String(minValue));
  const [maxInput, setMaxInput] = useState(String(maxValue));

  // Sync local state when parent values change (e.g., format switch)
  useEffect(() => {
    setMinInput(String(minValue));
  }, [minValue]);

  useEffect(() => {
    setMaxInput(String(maxValue));
  }, [maxValue]);

  const handleMinBlur = () => {
    const val = parseInt(minInput, 10);
    if (!isNaN(val) && val >= minBound && val < maxValue) {
      onMinChange(val);
    } else {
      setMinInput(String(minValue));
    }
  };

  const handleMaxBlur = () => {
    const val = parseInt(maxInput, 10);
    if (!isNaN(val) && val > minValue && val <= maxBound) {
      onMaxChange(val);
    } else {
      setMaxInput(String(maxValue));
    }
  };

  return (
    <div className="flex gap-3">
      <div className="flex-1">
        <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1 block">
          Min (sec)
        </label>
        <input
          type="text"
          inputMode="numeric"
          value={minInput}
          onChange={(e) => setMinInput(e.target.value)}
          onBlur={handleMinBlur}
          onKeyDown={(e) => e.key === "Enter" && handleMinBlur()}
          className="w-full px-3 py-2 text-sm rounded-lg bg-card border-2 border-border focus:border-blue-400 focus:outline-none"
        />
      </div>
      <div className="flex-1">
        <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1 block">
          Max (sec)
        </label>
        <input
          type="text"
          inputMode="numeric"
          value={maxInput}
          onChange={(e) => setMaxInput(e.target.value)}
          onBlur={handleMaxBlur}
          onKeyDown={(e) => e.key === "Enter" && handleMaxBlur()}
          className="w-full px-3 py-2 text-sm rounded-lg bg-card border-2 border-border focus:border-blue-400 focus:outline-none"
        />
      </div>
    </div>
  );
}

function RetainPicker({
  selected,
  onSelect,
  disabled = false,
}: {
  selected: string;
  onSelect: (value: string) => void;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [customValue, setCustomValue] = useState("");

  const isCustom =
    selected &&
    !PERCENT_OPTIONS.some((opt) => opt.value === selected);

  const submitCustom = () => {
    if (customValue.trim()) {
      const num = parseInt(customValue.replace("%", "").trim(), 10);
      if (!isNaN(num) && num > 0 && num <= 100) {
        onSelect(String(num));
      }
    }
    setEditing(false);
  };

  return (
    <div
      className={cn(
        "flex flex-wrap gap-2",
        disabled && "opacity-50 pointer-events-none",
      )}
    >
      {PERCENT_OPTIONS.map((opt) => {
        const isSelected = selected === opt.value;
        return (
          <Tooltip key={opt.value}>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onSelect(opt.value)}
                className={cn(
                  "px-4 py-2 rounded-lg text-sm font-medium transition-all border-2",
                  disabled && "cursor-not-allowed",
                  isSelected
                    ? "bg-blue-600 border-blue-600 text-white shadow-md"
                    : "bg-card border-border hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 text-foreground",
                  disabled && "hover:border-border hover:bg-card",
                )}
              >
                {opt.label}
              </button>
            </TooltipTrigger>
            <TooltipContent>{opt.tooltip}</TooltipContent>
          </Tooltip>
        );
      })}

      {editing && !disabled ? (
        <input
          type="text"
          value={customValue}
          onChange={(e) => setCustomValue(e.target.value)}
          onBlur={submitCustom}
          onKeyDown={(e) => e.key === "Enter" && submitCustom()}
          placeholder="40%"
          autoFocus
          className="w-16 px-3 py-2 rounded-lg text-sm font-medium text-center bg-blue-600 text-white border-2 border-blue-600 focus:outline-none"
        />
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setCustomValue(isCustom ? `${selected}%` : "");
            setEditing(true);
          }}
          className={cn(
            "px-3 py-2 rounded-lg text-sm font-medium transition-all border-2 border-dashed",
            disabled && "cursor-not-allowed",
            isCustom
              ? "bg-blue-600 text-white border-blue-600 shadow-md"
              : "bg-card border-border hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 text-muted-foreground",
            disabled && "hover:border-border hover:bg-card",
          )}
        >
          {isCustom ? `${selected}%` : "Other"}
        </button>
      )}
    </div>
  );
}
