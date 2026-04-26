import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Loader2,
  Wand2,
  Sparkles,
  RectangleHorizontal,
  RectangleVertical,
  Square,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AspectRatio } from "@/remotion/types";
import type { GenerationJob } from "@/services/api";

export interface GenerateRequest {
  userPrompt: string;
}

interface MicrodramaGeneratorProps {
  onGenerate: (request: GenerateRequest) => Promise<void>;
  isGenerating: boolean;
  generationStatus?: GenerationJob | null;
  onAspectRatioChange?: (ratio: AspectRatio) => void;
  initialUserPrompt?: string;
  autoFrameEnabled: boolean;
  onAutoFrameChange: (enabled: boolean) => void;
}

const ASPECT_RATIOS: { value: AspectRatio; label: string; icon: typeof Square }[] = [
  { value: "16:9", label: "16:9", icon: RectangleHorizontal },
  { value: "9:16", label: "9:16", icon: RectangleVertical },
  { value: "1:1", label: "1:1", icon: Square },
];

export function MicrodramaGenerator({
  onGenerate,
  isGenerating,
  generationStatus,
  onAspectRatioChange,
  initialUserPrompt,
  autoFrameEnabled,
  onAutoFrameChange,
}: MicrodramaGeneratorProps) {
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("9:16");
  const [userPrompt, setUserPrompt] = useState(initialUserPrompt || "");

  const maxLength = 500;
  const remaining = maxLength - userPrompt.length;

  const handleAspectRatioChange = (ratio: AspectRatio) => {
    setAspectRatio(ratio);
    onAspectRatioChange?.(ratio);
  };

  const handleGenerate = () => {
    onGenerate({ userPrompt });
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
        {/* Aspect Ratio */}
        <div className="space-y-3">
          <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Format
          </Label>
          <div className="grid grid-cols-3 gap-2">
            {ASPECT_RATIOS.map((option) => {
              const isSelected = aspectRatio === option.value;
              return (
                <button
                  key={option.value}
                  onClick={() => handleAspectRatioChange(option.value)}
                  className={cn(
                    "flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all font-semibold",
                    isSelected
                      ? "bg-blue-600 border-blue-600 text-white shadow-md"
                      : "bg-card border-border hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 text-foreground",
                  )}
                >
                  <option.icon
                    className={cn(
                      "h-6 w-6",
                      isSelected ? "text-white" : "text-muted-foreground",
                    )}
                  />
                  <span className="text-sm">{option.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Instructions */}
        <div className="space-y-3">
          <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Instructions (optional)
          </Label>
          <div className="space-y-1">
            <textarea
              value={userPrompt}
              onChange={(e) =>
                setUserPrompt(e.target.value.slice(0, maxLength))
              }
              maxLength={maxLength}
              placeholder="e.g., Focus on the funniest moments, keep the energy high..."
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
  );
}
