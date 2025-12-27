import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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

interface GenerationStatus {
  status: "pending" | "generating" | "completed" | "failed";
  jobId: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

interface MicrodramaGeneratorProps {
  onGenerate: (selections: any) => Promise<void>;
  isGenerating: boolean;
  generationStatus?: GenerationStatus | null;
  onAspectRatioChange?: (ratio: AspectRatio) => void;
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
    value: "full_video",
    label: "Full Video",
    icon: LayoutGrid,
    tooltip: "Split into microdrama chapters",
  },
  {
    value: "highlights",
    label: "Highlights",
    icon: Scissors,
    tooltip: "Best moments",
  },
  {
    value: "trailer",
    label: "Trailer",
    icon: PlayCircle,
    tooltip: "Promo preview",
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
  highlights: ["30s", "60s"],
  trailer: ["90s", "2 min"],
  tunein: ["15s", "30s"],
  bridge: ["30s", "60s"],
  episode_recap: ["60s", "90s"],
  season_recap: ["2 min", "3 min"],
  social_segment: ["15s", "30s"],
};

type Selections = {
  type: string;
  platform: string;
  purpose: string;
  duration: string;
  userPrompt: string;
};

const INITIAL: Selections = {
  type: "",
  platform: "",
  purpose: "",
  duration: "",
  userPrompt: "",
};

export function MicrodramaGenerator({
  onGenerate,
  isGenerating,
  generationStatus,
  onAspectRatioChange,
}: MicrodramaGeneratorProps) {
  const [selections, setSelections] = useState<Selections>(INITIAL);
  const [viewMode, setViewMode] = useState<"chat" | "compact">("chat");
  const scrollRef = useRef<HTMLDivElement>(null);

  const needsDuration =
    selections.purpose && selections.purpose !== "full_video";
  const isComplete =
    selections.type &&
    selections.platform &&
    selections.purpose &&
    (selections.purpose === "full_video" || selections.duration);

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

      // Purpose change → reset duration
      if (key === "purpose") {
        updated.duration = value === "full_video" ? "" : "Auto";
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

            {/* Duration - only when not full_video */}
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
        <div className="p-4 border-t bg-muted/50">
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
                {generationStatus?.status === "generating" &&
                  "Generating Segments..."}
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
            <p className="text-xs text-muted-foreground text-center mt-2">
              This may take 1-2 minutes for longer videos
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
                      : "bg-card border-2 border-border hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 text-foreground"
                  )}
                >
                  <opt.icon
                    className={cn(
                      "h-4 w-4",
                      isSelected ? "text-white" : "text-muted-foreground"
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
  presets: [string, string];
  selected: string;
  onSelect: (value: string) => void;
}) {
  const [customValue, setCustomValue] = useState("");
  const [editing, setEditing] = useState(false);

  const options = ["Auto", presets[0], presets[1]];
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
              opt === "Auto" && !isSelected && "border-dashed"
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
              : "bg-card border-border hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 text-muted-foreground"
          )}
        >
          {isCustom ? selected : "Other"}
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
                    : "bg-card border-border hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30"
                )}
              >
                <opt.icon
                  className={cn(
                    "h-5 w-5",
                    isSelected ? "text-white" : "text-muted-foreground"
                  )}
                />
                <span
                  className={cn(
                    "text-[10px] font-semibold leading-tight text-center",
                    isSelected ? "text-white" : "text-foreground"
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
      <div className="flex justify-end">
        <div className="w-[85%] space-y-1">
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value.slice(0, maxLength))}
            maxLength={maxLength}
            placeholder="Any special instructions? (optional)"
            className="w-full h-16 px-3 py-2 text-sm rounded-2xl rounded-br-sm bg-blue-50 dark:bg-blue-950/30 border-2 border-blue-200 dark:border-blue-800 focus:border-blue-400 focus:outline-none resize-none placeholder:text-muted-foreground/50"
          />
          {value.length > 0 && (
            <div
              className={cn(
                "text-xs text-right pr-1",
                remaining < 50 ? "text-amber-500" : "text-muted-foreground/60"
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
          className="w-full h-14 px-3 py-2 text-sm rounded-lg bg-card border-2 border-dashed border-border focus:border-blue-400 focus:border-solid focus:outline-none resize-none placeholder:text-muted-foreground/50"
        />
        {value.length > 0 && (
          <div
            className={cn(
              "text-xs text-right",
              remaining < 50 ? "text-amber-500" : "text-muted-foreground/60"
            )}
          >
            {remaining}
          </div>
        )}
      </div>
    </GridSection>
  );
}
