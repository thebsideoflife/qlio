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
};

type StepConfig = {
  key: string;
  question: string;
  options: SelectionOption[];
};

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
    question: "What are we working from?",
    options: CONTENT_TYPES,
  },
  {
    key: "platform",
    question: "Where will this be published?",
    options: PLATFORMS,
  },
  {
    key: "purpose",
    question: "What are you trying to create?",
    options: PURPOSES,
  },
];

const DEFAULT_SELECTIONS = {
  type: "",
  platform: "",
  purpose: "",
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

  const isComplete = STEPS.every((step) => selections[step.key]);
  const completedSteps = STEPS.filter((step) => selections[step.key]).length;

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
                Step {Math.min(currentStep + 1, STEPS.length)} of {STEPS.length}
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
            scrollRef={scrollRef}
          />
        ) : (
          <CompactView selections={selections} onSelect={updateSelection} />
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
                {completedSteps}/{STEPS.length} Selected
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
  scrollRef,
}: {
  steps: StepConfig[];
  selections: Record<string, string>;
  currentStep: number;
  onSelect: (key: string, value: string) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-4">
      {steps.map((step, index) => {
        const isVisible = index <= currentStep;
        const selectedOption = step.options.find(
          (o) => o.value === selections[step.key]
        );
        const isAnswered = !!selectedOption;

        if (!isVisible) return null;

        return (
          <div
            key={step.key}
            className={cn(
              "space-y-3 transition-all duration-300",
              index === currentStep ? "opacity-100" : "opacity-70"
            )}
          >
            {/* Question bubble */}
            <div className="flex gap-2">
              <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center">
                <Wand2 className="h-3.5 w-3.5 text-primary" />
              </div>
              <div className="bg-muted/50 rounded-2xl rounded-tl-sm px-3 py-2 max-w-[85%]">
                <p className="text-sm font-medium">{step.question}</p>
              </div>
            </div>

            {/* Answer or Options */}
            {isAnswered && index < currentStep ? (
              // Show selected answer as a chat bubble
              <div className="flex justify-end">
                <button
                  onClick={() => onSelect(step.key, "")}
                  className="bg-blue-600 text-white rounded-2xl rounded-tr-sm px-3 py-2 flex items-center gap-2 hover:bg-blue-700 transition-colors"
                >
                  <selectedOption.icon className="h-4 w-4" />
                  <span className="text-sm font-medium">
                    {selectedOption.label}
                  </span>
                </button>
              </div>
            ) : (
              // Show options grid
              <div className="pl-9">
                <ChatOptionGrid
                  options={step.options}
                  selected={selections[step.key]}
                  onSelect={(value) => onSelect(step.key, value)}
                />
              </div>
            )}
          </div>
        );
      })}
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
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => (
        <Tooltip key={opt.value}>
          <TooltipTrigger asChild>
            <button
              onClick={() => onSelect(opt.value)}
              className={cn(
                "flex items-center gap-2 px-3 py-2 rounded-full border text-sm transition-all",
                selected === opt.value
                  ? "border-blue-500 bg-blue-500/10 text-blue-500"
                  : "border-muted hover:bg-muted/50"
              )}
            >
              <opt.icon className="h-4 w-4" />
              <span className="font-medium">{opt.label}</span>
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

/* Compact View */

function CompactView({
  selections,
  onSelect,
}: {
  selections: Record<string, string>;
  onSelect: (key: string, value: string) => void;
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
          onSelect={(v) => onSelect("purpose", v)}
        />
      </Section>
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
