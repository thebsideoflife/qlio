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

interface MicrodramaGeneratorProps {
  onGenerate: (selections: any) => Promise<void>;
  isGenerating: boolean;
}

type SelectionOption = {
  value: string;
  label: string;
  icon: LucideIcon | IconType;
  tooltip: string;
  durations?: string[]; // Available durations for this purpose
};

type StepConfig = {
  key: string;
  question: string;
  options: SelectionOption[];
};

// Duration options per purpose (auto = let agent decide)
const AUTO_DURATION = "Auto";
const DURATIONS: Record<string, string[]> = {
  binge: ["3 min", "5 min", "10 min"], // No auto - it's the full video
  highlights: [AUTO_DURATION, "15s", "30s", "60s", "90s"],
  trailer: [AUTO_DURATION, "90s", "2 min", "2.5 min"],
  tunein: [AUTO_DURATION, "15s", "30s"],
  bridge: [AUTO_DURATION, "30s", "60s", "90s"],
  episode_recap: [AUTO_DURATION, "60s", "90s", "2 min"],
  season_recap: [AUTO_DURATION, "2 min", "3 min", "5 min"],
  social_segment: [AUTO_DURATION, "15s", "30s", "60s"],
};

// Check if purpose supports auto duration
const supportsAutoDuration = (purpose: string) => purpose !== "binge";

const CONTENT_TYPES: SelectionOption[] = [
  { value: "tv", label: "TV", icon: Tv, tooltip: "Television series content" },
  {
    value: "movie",
    label: "Movie",
    icon: Film,
    tooltip: "Feature film content",
  },
  {
    value: "ugc",
    label: "UGC",
    icon: Sparkles,
    tooltip: "User-generated content",
  },
];

const PLATFORMS: SelectionOption[] = [
  {
    value: "mobile",
    label: "Mobile",
    icon: Smartphone,
    tooltip: "Native mobile app delivery",
  },
  {
    value: "tv",
    label: "Smart TV",
    icon: Tv,
    tooltip: "Connected TV platforms",
  },
  {
    value: "auto",
    label: "Automotive",
    icon: Car,
    tooltip: "In-vehicle entertainment",
  },
  {
    value: "tiktok",
    label: "TikTok",
    icon: FaTiktok,
    tooltip: "TikTok vertical video",
  },
  {
    value: "ig",
    label: "Reels",
    icon: FaInstagram,
    tooltip: "Instagram Reels format",
  },
  {
    value: "shorts",
    label: "YT Shorts",
    icon: SiYoutubeshorts,
    tooltip: "YouTube Shorts format",
  },
  {
    value: "facebook",
    label: "Facebook",
    icon: FaFacebook,
    tooltip: "Facebook video feed",
  },
  {
    value: "youtube",
    label: "YouTube",
    icon: FaYoutube,
    tooltip: "Standard YouTube video",
  },
];

const PURPOSES: SelectionOption[] = [
  {
    value: "binge",
    label: "Binge",
    icon: LayoutGrid,
    tooltip: "Split into episodes, keep all content for extended viewing",
  },
  {
    value: "highlights",
    label: "Highlights",
    icon: Scissors,
    tooltip: "Extract best moments, cut everything else",
  },
  {
    value: "trailer",
    label: "Trailer",
    icon: PlayCircle,
    tooltip: "2-2.5 minute promotional preview",
  },
  {
    value: "tunein",
    label: "Tune-In",
    icon: Clock,
    tooltip: "Hero (30s) or Social (15s) tune-in spots",
  },
  {
    value: "bridge",
    label: "Bridge",
    icon: Share2,
    tooltip: "Transitional content between releases",
  },
  {
    value: "episode_recap",
    label: "Episode Recap",
    icon: Repeat,
    tooltip: "Summary of a single episode",
  },
  {
    value: "season_recap",
    label: "Season Recap",
    icon: ListVideo,
    tooltip: "Summary of an entire season",
  },
  {
    value: "social_segment",
    label: "Social Segment",
    icon: Sparkles,
    tooltip: "Shareable social media clip",
  },
];

const STEPS: StepConfig[] = [
  {
    key: "type",
    question: "What kind of content are we working with?",
    options: CONTENT_TYPES,
  },
  {
    key: "platform",
    question: "Where should this live?",
    options: PLATFORMS,
  },
  {
    key: "purpose",
    question: "What would you like to create?",
    options: PURPOSES,
  },
];

const DEFAULT_SELECTIONS = {
  type: "",
  platform: "",
  purpose: "",
  duration: "",
};

export function MicrodramaGenerator({
  onGenerate,
  isGenerating,
}: MicrodramaGeneratorProps) {
  const [selections, setSelections] =
    useState<Record<string, string>>(DEFAULT_SELECTIONS);
  const [viewMode, setViewMode] = useState<"chat" | "compact">("chat");
  const [currentStep, setCurrentStep] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const updateSelection = (key: string, value: string) => {
    setSelections((prev) => ({ ...prev, [key]: value }));
  };

  const handleChatSelect = (key: string, value: string) => {
    updateSelection(key, value);
    // Auto-advance to next step after selection
    setTimeout(() => {
      if (currentStep < STEPS.length - 1) {
        setCurrentStep((prev) => prev + 1);
      }
    }, 300);
  };

  const handleReset = () => {
    setSelections(DEFAULT_SELECTIONS);
    setCurrentStep(0);
  };

  // Set duration when purpose changes - default to Auto if supported
  const handlePurposeChange = (value: string) => {
    const defaultDuration = value && supportsAutoDuration(value) ? AUTO_DURATION : "";
    setSelections((prev) => ({ ...prev, purpose: value, duration: defaultDuration }));
  };

  const availableDurations = selections.purpose ? DURATIONS[selections.purpose] || [] : [];
  const isComplete = STEPS.every((step) => selections[step.key]) && selections.duration;
  const completedSteps = STEPS.filter((step) => selections[step.key]).length + (selections.duration ? 1 : 0);
  const totalSteps = STEPS.length + 1; // +1 for duration

  // Auto-scroll to bottom when step changes
  useEffect(() => {
    if (viewMode === "chat" && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [currentStep, viewMode]);

  return (
    <TooltipProvider delayDuration={500}>
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center justify-between p-3 border-b">
          <div className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-primary" />
            <span className="font-semibold text-sm">IQ Director</span>
            {viewMode === "chat" && (
              <span className="text-xs text-muted-foreground">
                Step {Math.min(currentStep + 1, totalSteps)} of {totalSteps}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={handleReset}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Reset</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() =>
                    setViewMode(viewMode === "chat" ? "compact" : "chat")
                  }
                >
                  {viewMode === "chat" ? (
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                  ) : (
                    <MessageSquare className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {viewMode === "chat" ? "Compact view" : "Chat view"}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Content */}
        {viewMode === "chat" ? (
          <ChatView
            steps={STEPS}
            selections={selections}
            currentStep={currentStep}
            onSelect={handleChatSelect}
            onPurposeChange={handlePurposeChange}
            availableDurations={availableDurations}
            scrollRef={scrollRef}
          />
        ) : (
          <CompactView
            selections={selections}
            onSelect={updateSelection}
            onPurposeChange={handlePurposeChange}
            availableDurations={availableDurations}
          />
        )}

        {/* Generate Button */}
        <div className="p-3 border-t mt-auto">
          <Button
            onClick={() => onGenerate(selections)}
            disabled={isGenerating || !isComplete}
            className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white shadow-lg disabled:opacity-50"
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Analyzing Video...
              </>
            ) : !isComplete ? (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                {completedSteps}/{totalSteps} Selected
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                Generate Segments
              </>
            )}
          </Button>
        </div>
      </div>
    </TooltipProvider>
  );
}

/* Chat View */

function ChatView({
  steps,
  selections,
  currentStep,
  onSelect,
  onPurposeChange,
  availableDurations,
  scrollRef,
}: {
  steps: StepConfig[];
  selections: Record<string, string>;
  currentStep: number;
  onSelect: (key: string, value: string) => void;
  onPurposeChange: (value: string) => void;
  availableDurations: string[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const showDurationStep = currentStep >= steps.length - 1 && selections.purpose;

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-4">
      {steps.map((step, index) => {
        const isVisible = index <= currentStep;
        const selectedOption = step.options.find(
          (o) => o.value === selections[step.key]
        );
        const isAnswered = !!selectedOption;
        const isPurposeStep = step.key === "purpose";

        if (!isVisible) return null;

        return (
          <div
            key={step.key}
            className={cn(
              "space-y-3 transition-all duration-300",
              index === currentStep && !showDurationStep ? "opacity-100" : "opacity-70"
            )}
          >
            {/* Question bubble */}
            <div className="bg-muted/30 rounded-xl px-3 py-2">
              <p className="text-sm text-muted-foreground">{step.question}</p>
            </div>

            {/* Answer or Options */}
            {isAnswered && (index < currentStep || (isPurposeStep && showDurationStep)) ? (
              // Show selected answer as a chat bubble
              <div className="flex justify-end">
                <button
                  onClick={() => isPurposeStep ? onPurposeChange("") : onSelect(step.key, "")}
                  className="bg-blue-500/90 text-white rounded-xl px-3 py-1.5 flex items-center gap-2 hover:bg-blue-600 transition-colors shadow-sm"
                >
                  <selectedOption.icon className="h-3.5 w-3.5" />
                  <span className="text-sm">
                    {selectedOption.label}
                  </span>
                </button>
              </div>
            ) : (
              // Show options grid
              <div>
                <ChatOptionGrid
                  options={step.options}
                  selected={selections[step.key]}
                  onSelect={(value) => isPurposeStep ? onPurposeChange(value) : onSelect(step.key, value)}
                />
              </div>
            )}
          </div>
        );
      })}

      {/* Duration Step */}
      {showDurationStep && (
        <div className="space-y-3 transition-all duration-300 opacity-100">
          <div className="bg-muted/30 rounded-xl px-3 py-2">
            <p className="text-sm text-muted-foreground">How long should it be?</p>
          </div>
          <div>
            <DurationPicker
              durations={availableDurations}
              selected={selections.duration}
              onSelect={(value) => onSelect("duration", value)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ChatOptionGrid({
  options,
  selected,
  onSelect,
}: {
  options: SelectionOption[];
  selected: string;
  onSelect: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => (
        <Tooltip key={opt.value}>
          <TooltipTrigger asChild>
            <button
              onClick={() => onSelect(opt.value)}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-sm transition-all",
                selected === opt.value
                  ? "border-blue-400/50 bg-blue-500/10 text-blue-400"
                  : "border-muted/50 hover:bg-muted/30 hover:border-muted"
              )}
            >
              <opt.icon className="h-3.5 w-3.5" />
              <span>{opt.label}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>{opt.tooltip}</p>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

function DurationPicker({
  durations,
  selected,
  onSelect,
}: {
  durations: string[];
  selected: string;
  onSelect: (value: string) => void;
}) {
  const [customValue, setCustomValue] = useState("");
  const [isEditingCustom, setIsEditingCustom] = useState(false);
  
  // Check if current selection is a custom value (not a preset)
  const isCustomSelected = selected && !durations.includes(selected);

  const handleCustomSubmit = () => {
    if (customValue.trim()) {
      onSelect(customValue.trim());
    }
    setIsEditingCustom(false);
  };

  const handleCustomClick = () => {
    setCustomValue(isCustomSelected ? selected : "");
    setIsEditingCustom(true);
  };

  return (
    <div className="flex flex-wrap gap-1.5 items-center">
      {durations.map((duration) => {
        const isAuto = duration === AUTO_DURATION;
        const isSelected = selected === duration;

        return (
          <button
            key={duration}
            onClick={() => onSelect(duration)}
            className={cn(
              "px-2.5 py-1 rounded-lg border text-xs font-medium transition-all",
              isSelected
                ? "border-blue-400/50 bg-blue-500/10 text-blue-400"
                : "border-muted/50 hover:bg-muted/30 hover:border-muted",
              isAuto && !isSelected && "border-dashed"
            )}
          >
            {duration}
          </button>
        );
      })}

      {/* Custom duration input */}
      {isEditingCustom ? (
        <input
          type="text"
          value={customValue}
          onChange={(e) => setCustomValue(e.target.value)}
          onBlur={handleCustomSubmit}
          onKeyDown={(e) => e.key === "Enter" && handleCustomSubmit()}
          placeholder="45s"
          autoFocus
          className="w-14 px-2.5 py-1 rounded-lg border border-blue-400/50 bg-blue-500/10 text-xs font-medium text-center focus:outline-none text-blue-400"
        />
      ) : (
        <button
          onClick={handleCustomClick}
          className={cn(
            "px-2.5 py-1 rounded-lg border border-dashed text-xs font-medium transition-all",
            isCustomSelected
              ? "border-blue-400/50 bg-blue-500/10 text-blue-400"
              : "border-muted/50 hover:bg-muted/30 text-muted-foreground"
          )}
        >
          {isCustomSelected ? selected : "Other"}
        </button>
      )}
    </div>
  );
}

/* Compact View */

function CompactView({
  selections,
  onSelect,
  onPurposeChange,
  availableDurations,
}: {
  selections: Record<string, string>;
  onSelect: (key: string, value: string) => void;
  onPurposeChange: (value: string) => void;
  availableDurations: string[];
}) {
  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-4">
      <Section label="Content Type">
        <CompactOptionGrid
          options={CONTENT_TYPES}
          selected={selections.type}
          onSelect={(v) => onSelect("type", v)}
        />
      </Section>

      <Section label="Target Platform">
        <CompactOptionGrid
          options={PLATFORMS}
          selected={selections.platform}
          onSelect={(v) => onSelect("platform", v)}
        />
      </Section>

      <Section label="Purpose">
        <CompactOptionGrid
          options={PURPOSES}
          selected={selections.purpose}
          onSelect={onPurposeChange}
        />
      </Section>

      {selections.purpose && availableDurations.length > 0 && (
        <Section label="Duration">
          <DurationPicker
            durations={availableDurations}
            selected={selections.duration}
            onSelect={(v) => onSelect("duration", v)}
          />
        </Section>
      )}
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <Label className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      {children}
    </section>
  );
}

function CompactOptionGrid({
  options,
  selected,
  onSelect,
}: {
  options: SelectionOption[];
  selected: string;
  onSelect: (value: string) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {options.map((opt) => (
        <Tooltip key={opt.value}>
          <TooltipTrigger asChild>
            <div
              onClick={() => onSelect(opt.value)}
              className={cn(
                "flex flex-col items-center justify-center gap-1 p-2 rounded-md border cursor-pointer transition-all hover:bg-accent/50",
                selected === opt.value
                  ? "border-blue-500 bg-blue-500/10"
                  : "border-muted"
              )}
            >
              <opt.icon
                className={cn(
                  "h-4 w-4",
                  selected === opt.value
                    ? "text-blue-500"
                    : "text-muted-foreground"
                )}
              />
              <span
                className={cn(
                  "text-[10px] font-medium text-center leading-tight",
                  selected === opt.value && "text-blue-500"
                )}
              >
                {opt.label}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>{opt.tooltip}</p>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
