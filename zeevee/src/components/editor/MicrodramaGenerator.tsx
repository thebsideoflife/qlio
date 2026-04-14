import { useState, useEffect, useRef } from "react";
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
  Car,
  Loader2,
  Wand2,
  Smartphone,
  PlayCircle,
  Clock,
  Repeat,
  ListVideo,
  Share2,
  LayoutGrid,
  Scissors,
  RotateCcw,
  MessageSquare,
  SlidersHorizontal,
} from "lucide-react";
import { FaTiktok, FaInstagram, FaYoutube, FaFacebook } from "react-icons/fa";
import { SiYoutubeshorts } from "react-icons/si";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { IconType } from "react-icons";
import type { AspectRatio } from "@/remotion/types";
import type { GenerationJob } from "@/services/api";

interface InitialSelections {
  type?: string;
  platform?: string;
  purpose?: string;
  duration?: string;
  targetPercent?: string;
  userPrompt?: string;
}

interface MicrodramaGeneratorProps {
  onGenerate: (selections: Selections) => Promise<void>;
  isGenerating: boolean;
  generationStatus?: GenerationJob | null;
  onAspectRatioChange?: (ratio: AspectRatio) => void;
  initialSelections?: InitialSelections | null;
  autoFrameEnabled: boolean;
  onAutoFrameChange: (enabled: boolean) => void;
}

// Platform → Aspect Ratio mapping
const PLATFORM_ASPECT_RATIOS: Record<string, AspectRatio> = {
  mobile: "9:16",
  tiktok: "9:16",
  ig: "9:16",
  shorts: "9:16",
  facebook: "1:1",
  youtube: "16:9",
  tv: "16:9",
  auto: "16:9",
};

type Option = {
  value: string;
  label: string;
  icon: LucideIcon | IconType;
  tooltip: string;
};

const CONTENT_TYPES: Option[] = [
  { value: "tv", label: "TV", icon: Tv, tooltip: "Television series" },
  { value: "movie", label: "Movie", icon: Film, tooltip: "Feature film" },
  { value: "ugc", label: "UGC", icon: Sparkles, tooltip: "User-generated" },
];

const PLATFORMS: Option[] = [
  { value: "mobile", label: "Mobile", icon: Smartphone, tooltip: "Mobile app" },
  { value: "tv", label: "Smart TV", icon: Tv, tooltip: "Connected TV" },
  { value: "auto", label: "Auto", icon: Car, tooltip: "In-vehicle" },
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
  { value: "youtube", label: "YouTube", icon: FaYoutube, tooltip: "YouTube" },
];

const PURPOSES: Option[] = [
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
    icon: PlayCircle,
    tooltip: "Highlight reel",
  },
  {
    value: "tunein",
    label: "Tune-In",
    icon: Clock,
    tooltip: "Short promo spots",
  },
  {
    value: "bridge",
    label: "Bridge",
    icon: Share2,
    tooltip: "Transitional content",
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
  {
    value: "social_segment",
    label: "Social",
    icon: Sparkles,
    tooltip: "Social clip",
  },
];

// Duration presets per purpose
const DURATION_PRESETS: Record<string, [string, string]> = {
  // full_video: no duration - uses entire video
  // compact_video: uses percent picker instead
  highlights: ["90s", "2 min"],
  tunein: ["15s", "30s"],
  bridge: ["30s", "60s"],
  episode_recap: ["60s", "90s"],
  season_recap: ["2 min", "3 min"],
  social_segment: ["15s", "30s"],
};

// Percent presets for compact video
const PERCENT_OPTIONS = [
  { value: "25", label: "25%", tooltip: "Quarter of original" },
  { value: "50", label: "50%", tooltip: "Half of original" },
  { value: "75", label: "75%", tooltip: "Three quarters" },
];

export type Selections = {
  type: string;
  platform: string;
  purpose: string;
  duration: string;
  targetPercent: string;
  userPrompt: string;
};

const INITIAL: Selections = {
  type: "",
  platform: "",
  purpose: "",
  duration: "",
  targetPercent: "",
  userPrompt: "",
};

export function MicrodramaGenerator({
  onGenerate,
  isGenerating,
  generationStatus,
  onAspectRatioChange,
  initialSelections,
  autoFrameEnabled,
  onAutoFrameChange,
}: MicrodramaGeneratorProps) {
  const [selections, setSelections] = useState<Selections>(() => ({
    type: initialSelections?.type || "",
    platform: initialSelections?.platform || "",
    purpose: initialSelections?.purpose || "",
    duration: initialSelections?.duration || "",
    targetPercent: initialSelections?.targetPercent || "",
    userPrompt: initialSelections?.userPrompt || "",
  }));
  const [viewMode, setViewMode] = useState<"chat" | "compact">("chat");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Purpose-specific logic
  const isCompactVideo = selections.purpose === "compact_video";
  const isFullVideo = selections.purpose === "full_video";
  const needsDuration = !!selections.purpose && !isFullVideo && !isCompactVideo;
  const needsPercent = isCompactVideo;

  // Completion check: compact_video needs percent, full_video needs nothing, others need duration
  const isComplete =
    selections.type &&
    selections.platform &&
    selections.purpose &&
    (isFullVideo ||
      (isCompactVideo ? selections.targetPercent : selections.duration));

  // Auto-scroll when selections change
  useEffect(() => {
    if (viewMode === "chat" && scrollRef.current) {
      setTimeout(() => {
        scrollRef.current?.scrollTo({
          top: scrollRef.current.scrollHeight,
          behavior: "smooth",
        });
      }, 100);
    }
  }, [selections, viewMode]);

  const select = (key: keyof Selections, value: string) => {
    setSelections((prev) => {
      const updated = { ...prev, [key]: value };

      // Platform → aspect ratio
      if (key === "platform" && onAspectRatioChange) {
        const ratio = PLATFORM_ASPECT_RATIOS[value];
        if (ratio) onAspectRatioChange(ratio);
      }

      // Purpose change → set defaults
      if (key === "purpose") {
        if (value === "compact_video") {
          // Default to 50% for compact video
          updated.targetPercent = "50";
          updated.duration = "";
        } else if (value === "full_video") {
          // Full video doesn't need duration or percent
          updated.duration = "";
          updated.targetPercent = "";
        } else {
          // Other purposes use duration
          updated.duration = "Auto";
          updated.targetPercent = "";
        }
      }

      return updated;
    });
  };

  const reset = () => setSelections(INITIAL);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-full bg-background">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/50">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-md bg-blue-500/10">
              <Wand2 className="h-4 w-4 text-blue-500" />
            </div>
            <span className="font-semibold">IQ Editor</span>
          </div>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={reset}
                >
                  <RotateCcw className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Reset all</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() =>
                    setViewMode(viewMode === "chat" ? "compact" : "chat")
                  }
                >
                  {viewMode === "chat" ? (
                    <SlidersHorizontal className="h-4 w-4" />
                  ) : (
                    <MessageSquare className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {viewMode === "chat" ? "Grid view" : "Chat view"}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Content */}
        {viewMode === "chat" ? (
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-5">
            {/* Content Type */}
            <ChatQuestion
              question="What kind of content?"
              options={CONTENT_TYPES}
              selected={selections.type}
              onSelect={(v) => select("type", v)}
            />

            {/* Platform */}
            {selections.type && (
              <ChatQuestion
                question="Where will this live?"
                options={PLATFORMS}
                selected={selections.platform}
                onSelect={(v) => select("platform", v)}
              />
            )}

            {/* Purpose */}
            {selections.type && selections.platform && (
              <ChatQuestion
                question="What do you want to create?"
                options={PURPOSES}
                selected={selections.purpose}
                onSelect={(v) => select("purpose", v)}
              />
            )}

            {/* Percent picker - for compact_video */}
            {selections.type && selections.platform && needsPercent && (
              <div className="space-y-3">
                <div className="inline-block bg-muted rounded-2xl rounded-bl-sm px-4 py-2.5 max-w-[85%]">
                  <p className="text-sm font-medium">How much to keep?</p>
                </div>
                <PercentPicker
                  selected={selections.targetPercent}
                  onSelect={(v) => select("targetPercent", v)}
                />
              </div>
            )}

            {/* Duration - for other purposes (not full_video or compact_video) */}
            {selections.type && selections.platform && needsDuration && (
              <div className="space-y-3">
                <div className="inline-block bg-muted rounded-2xl rounded-bl-sm px-4 py-2.5 max-w-[85%]">
                  <p className="text-sm font-medium">How long?</p>
                </div>
                <DurationPicker
                  presets={DURATION_PRESETS[selections.purpose]}
                  selected={selections.duration}
                  onSelect={(v) => select("duration", v)}
                />
              </div>
            )}

            {/* Optional User Prompt */}
            {selections.type && selections.platform && selections.purpose && (
              <UserPromptSection
                value={selections.userPrompt}
                onChange={(v) => select("userPrompt", v)}
                viewMode="chat"
              />
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 space-y-5">
            <GridSection label="Content Type">
              <OptionGrid
                options={CONTENT_TYPES}
                selected={selections.type}
                onSelect={(v) => select("type", v)}
                columns={3}
              />
            </GridSection>

            <GridSection label="Platform">
              <OptionGrid
                options={PLATFORMS}
                selected={selections.platform}
                onSelect={(v) => select("platform", v)}
                columns={4}
              />
            </GridSection>

            <GridSection label="Purpose">
              <OptionGrid
                options={PURPOSES}
                selected={selections.purpose}
                onSelect={(v) => select("purpose", v)}
                columns={4}
              />
            </GridSection>

            {needsPercent && (
              <GridSection label="Keep Percentage">
                <PercentPicker
                  selected={selections.targetPercent}
                  onSelect={(v) => select("targetPercent", v)}
                />
              </GridSection>
            )}

            {needsDuration && (
              <GridSection label="Duration">
                <DurationPicker
                  presets={DURATION_PRESETS[selections.purpose]}
                  selected={selections.duration}
                  onSelect={(v) => select("duration", v)}
                />
              </GridSection>
            )}

            {/* Optional User Prompt */}
            {selections.purpose && (
              <UserPromptSection
                value={selections.userPrompt}
                onChange={(v) => select("userPrompt", v)}
                viewMode="compact"
              />
            )}
          </div>
        )}

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
            onClick={() => onGenerate(selections)}
            disabled={isGenerating || !isComplete}
            className="w-full h-11 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-lg disabled:opacity-40 font-semibold text-sm"
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {generationStatus?.status === "pending" &&
                  "Starting Analysis..."}
                {generationStatus?.status === "detecting_scenes" &&
                  "Detecting Scenes..."}
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
              {generationStatus.status === "detecting_scenes"
                ? "Scene detection may take a few minutes for longer videos"
                : generationStatus.status === "framing"
                  ? "Analyzing framing for each segment..."
                  : "This may take 1-2 minutes for longer videos"}
            </p>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

/* ============ Chat View Components ============ */

function ChatQuestion({
  question,
  options,
  selected,
  onSelect,
}: {
  question: string;
  options: Option[];
  selected: string;
  onSelect: (value: string) => void;
}) {
  return (
    <div className="space-y-3">
      {/* Question bubble */}
      <div className="inline-block bg-muted rounded-2xl rounded-bl-sm px-4 py-2.5 max-w-[85%]">
        <p className="text-sm font-medium">{question}</p>
      </div>

      {/* Options */}
      <div className="flex flex-wrap gap-2 pl-1">
        {options.map((opt) => {
          const isSelected = selected === opt.value;
          return (
            <Tooltip key={opt.value}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => onSelect(opt.value)}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all",
                    isSelected
                      ? "bg-blue-600 text-white shadow-md"
                      : "bg-card border-2 border-border hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 text-foreground",
                  )}
                >
                  <opt.icon
                    className={cn(
                      "h-4 w-4",
                      isSelected ? "text-white" : "text-muted-foreground",
                    )}
                  />
                  <span>{opt.label}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{opt.tooltip}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

function DurationPicker({
  presets,
  selected,
  onSelect,
}: {
  presets?: [string, string];
  selected: string;
  onSelect: (value: string) => void;
}) {
  const [customValue, setCustomValue] = useState("");
  const [editing, setEditing] = useState(false);

  // Default presets if none provided
  const safePresets = presets ?? ["30s", "60s"];
  const options = ["Auto", safePresets[0], safePresets[1]];
  const isCustom = selected && !options.includes(selected);

  const submitCustom = () => {
    if (customValue.trim()) onSelect(customValue.trim());
    setEditing(false);
  };

  return (
    <div className="flex flex-wrap gap-2 pl-1">
      {options.map((opt) => {
        const isSelected = selected === opt;
        return (
          <button
            key={opt}
            onClick={() => onSelect(opt)}
            className={cn(
              "px-3 py-2 rounded-xl text-sm font-medium transition-all",
              isSelected
                ? "bg-blue-600 text-white shadow-md"
                : "bg-card border-2 border-border hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 text-foreground",
              opt === "Auto" && !isSelected && "border-dashed",
            )}
          >
            {opt}
          </button>
        );
      })}

      {editing ? (
        <input
          type="text"
          value={customValue}
          onChange={(e) => setCustomValue(e.target.value)}
          onBlur={submitCustom}
          onKeyDown={(e) => e.key === "Enter" && submitCustom()}
          placeholder="45s"
          autoFocus
          className="w-16 px-3 py-2 rounded-xl text-sm font-medium text-center bg-blue-600 text-white border-2 border-blue-600 focus:outline-none"
        />
      ) : (
        <button
          onClick={() => {
            setCustomValue(isCustom ? selected : "");
            setEditing(true);
          }}
          className={cn(
            "px-3 py-2 rounded-xl text-sm font-medium transition-all border-2 border-dashed",
            isCustom
              ? "bg-blue-600 text-white border-blue-600 shadow-md"
              : "bg-card border-border hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 text-muted-foreground",
          )}
        >
          {isCustom ? selected : "Other"}
        </button>
      )}
    </div>
  );
}

/**
 * Percent picker for compact video mode.
 * Allows selecting 25%, 50%, 75% or custom percentage.
 */
function PercentPicker({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [customValue, setCustomValue] = useState("");

  const isCustom =
    selected && !PERCENT_OPTIONS.some((opt) => opt.value === selected);

  const submitCustom = () => {
    if (customValue.trim()) {
      // Parse and validate percentage
      const num = parseInt(customValue.replace("%", "").trim(), 10);
      if (!isNaN(num) && num > 0 && num <= 100) {
        onSelect(String(num));
      }
    }
    setEditing(false);
  };

  return (
    <div className="flex flex-wrap gap-2 pl-1">
      {PERCENT_OPTIONS.map((opt) => {
        const isSelected = selected === opt.value;
        return (
          <Tooltip key={opt.value}>
            <TooltipTrigger asChild>
              <button
                onClick={() => onSelect(opt.value)}
                className={cn(
                  "px-4 py-2 rounded-xl text-sm font-medium transition-all",
                  isSelected
                    ? "bg-blue-600 text-white shadow-md"
                    : "bg-card border-2 border-border hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 text-foreground",
                )}
              >
                {opt.label}
              </button>
            </TooltipTrigger>
            <TooltipContent>{opt.tooltip}</TooltipContent>
          </Tooltip>
        );
      })}

      {editing ? (
        <input
          type="text"
          value={customValue}
          onChange={(e) => setCustomValue(e.target.value)}
          onBlur={submitCustom}
          onKeyDown={(e) => e.key === "Enter" && submitCustom()}
          placeholder="40%"
          autoFocus
          className="w-16 px-3 py-2 rounded-xl text-sm font-medium text-center bg-blue-600 text-white border-2 border-blue-600 focus:outline-none"
        />
      ) : (
        <button
          onClick={() => {
            setCustomValue(isCustom ? `${selected}%` : "");
            setEditing(true);
          }}
          className={cn(
            "px-3 py-2 rounded-xl text-sm font-medium transition-all border-2 border-dashed",
            isCustom
              ? "bg-blue-600 text-white border-blue-600 shadow-md"
              : "bg-card border-border hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 text-muted-foreground",
          )}
        >
          {isCustom ? `${selected}%` : "Other"}
        </button>
      )}
    </div>
  );
}

/* ============ Grid View Components ============ */

function GridSection({
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

function OptionGrid({
  options,
  selected,
  onSelect,
  columns = 3,
}: {
  options: Option[];
  selected: string;
  onSelect: (value: string) => void;
  columns?: number;
}) {
  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {options.map((opt) => {
        const isSelected = selected === opt.value;
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

/* ============ User Prompt Section ============ */

function UserPromptSection({
  value,
  onChange,
  viewMode,
}: {
  value: string;
  onChange: (value: string) => void;
  viewMode: "chat" | "compact";
}) {
  const maxLength = 500;
  const remaining = maxLength - value.length;

  if (viewMode === "chat") {
    return (
      <div className="w-full">
        <div className="w-full space-y-1">
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value.slice(0, maxLength))}
            maxLength={maxLength}
            placeholder="Any special instructions? (optional)"
            className="w-full h-24 px-3 py-2.5 text-sm rounded-2xl rounded-br-sm bg-blue-50 dark:bg-blue-950/30 border-2 border-blue-200 dark:border-blue-800 focus:border-blue-400 focus:outline-none resize-none placeholder:text-muted-foreground/50"
          />
          {value.length > 0 && (
            <div
              className={cn(
                "text-xs text-right pr-1",
                remaining < 50 ? "text-amber-500" : "text-muted-foreground/60",
              )}
            >
              {remaining}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Compact view
  return (
    <GridSection label="Instructions (optional)">
      <div className="space-y-1">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value.slice(0, maxLength))}
          maxLength={maxLength}
          placeholder="e.g., Focus on the romantic subplot..."
          className="w-full h-24 px-3 py-2.5 text-sm rounded-lg bg-card border-2 border-dashed border-border focus:border-blue-400 focus:border-solid focus:outline-none resize-none placeholder:text-muted-foreground/50"
        />
        {value.length > 0 && (
          <div
            className={cn(
              "text-xs text-right",
              remaining < 50 ? "text-amber-500" : "text-muted-foreground/60",
            )}
          >
            {remaining}
          </div>
        )}
      </div>
    </GridSection>
  );
}
