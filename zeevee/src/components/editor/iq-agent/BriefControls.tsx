/**
 * Input controls that open a run. Defaults handed to the agent — anything the
 * producer says in the thread overrides them.
 *
 * Hydrated from `project.metadata` only (via savedInputs).
 */

import { useEffect, useRef, useState } from "react";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Film,
  FileQuestion,
  LayoutGrid,
  ListVideo,
  PlayCircle,
  Repeat,
  Scissors,
  Smartphone,
  Sparkles,
  Tv,
} from "lucide-react";
import { FaFacebook, FaInstagram, FaTiktok } from "react-icons/fa";
import { SiYoutubeshorts } from "react-icons/si";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { IconType } from "react-icons";
import type { AgentBrief } from "@/services/agentTypes";
import type { GenerationMetadata } from "@/store/editorSlice";

export type Option = {
  value: string;
  label: string;
  icon: LucideIcon | IconType;
  tooltip: string;
  disabled?: boolean;
};

const ASSET_TYPES: Option[] = [
  { value: "tv", label: "TV", icon: Tv, tooltip: "Television series" },
  { value: "movie", label: "Movie", icon: Film, tooltip: "Feature film" },
  { value: "other", label: "Other", icon: FileQuestion, tooltip: "Other content" },
];

const PLATFORMS: Option[] = [
  { value: "mobile", label: "Mobile", icon: Smartphone, tooltip: "Mobile app" },
  { value: "tv", label: "Smart TV", icon: Tv, tooltip: "Connected TV" },
  { value: "tiktok", label: "TikTok", icon: FaTiktok, tooltip: "TikTok", disabled: true },
  { value: "ig", label: "Reels", icon: FaInstagram, tooltip: "Instagram Reels", disabled: true },
  { value: "shorts", label: "Shorts", icon: SiYoutubeshorts, tooltip: "YouTube Shorts", disabled: true },
  { value: "facebook", label: "Facebook", icon: FaFacebook, tooltip: "Facebook", disabled: true },
];

const FORMATS: Option[] = [
  { value: "compact_video", label: "Compact", icon: Scissors, tooltip: "Condense the whole video" },
  { value: "highlights", label: "Highlights", icon: Sparkles, tooltip: "Best moments only" },
  { value: "episode_recap", label: "Ep Recap", icon: Repeat, tooltip: "Previously on… 4–6 beats, ~90s" },
  { value: "full_video", label: "Full Video", icon: LayoutGrid, tooltip: "Split into chapters" },
  { value: "trailer", label: "Trailer", icon: PlayCircle, tooltip: "Promo preview", disabled: true },
  { value: "season_recap", label: "Season Recap", icon: ListVideo, tooltip: "Season summary", disabled: true },
];

const SEGMENT_DURATION_DEFAULTS: Record<string, { min: number; max: number }> = {
  highlights: { min: 5, max: 30 },
  compact_video: { min: 60, max: 180 },
  full_video: { min: 60, max: 180 },
  trailer: { min: 60, max: 180 },
  episode_recap: { min: 10, max: 20 },
  season_recap: { min: 60, max: 180 },
};

const RETAIN_OPTIONS = [
  { value: "auto", label: "Auto", tooltip: "The editor decides" },
  { value: "25", label: "25%", tooltip: "A quarter of the source" },
  { value: "50", label: "50%", tooltip: "Half of the source" },
  { value: "75", label: "75%", tooltip: "Three quarters" },
];

const DEFAULT_ASSET_TYPE = "tv";
const DEFAULT_PLATFORM = "mobile";
const DEFAULT_FORMAT = "compact_video";

export interface BriefControlsProps {
  disabled: boolean;
  savedInputs?: GenerationMetadata | null;
  onPlatformChange?: (platform: string) => void;
  onChange: (brief: AgentBrief) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function resolveFormat(candidate: string | undefined | null): string {
  if (!candidate) return DEFAULT_FORMAT;
  const option = FORMATS.find((o) => o.value === candidate);
  return option && !option.disabled ? candidate : DEFAULT_FORMAT;
}

export function BriefControls({
  disabled,
  savedInputs,
  onPlatformChange,
  onChange,
}: BriefControlsProps) {
  const [assetType, setAssetType] = useState(DEFAULT_ASSET_TYPE);
  const [platform, setPlatform] = useState(DEFAULT_PLATFORM);
  const [format, setFormat] = useState(DEFAULT_FORMAT);
  const [retain, setRetain] = useState("auto");
  const [minDuration, setMinDuration] = useState(
    SEGMENT_DURATION_DEFAULTS[DEFAULT_FORMAT].min,
  );
  const [maxDuration, setMaxDuration] = useState(
    SEGMENT_DURATION_DEFAULTS[DEFAULT_FORMAT].max,
  );
  const [userPrompt, setUserPrompt] = useState("");
  // Hold onChange until project.metadata has been applied once.
  const [publishReady, setPublishReady] = useState(false);

  const didHydrateRef = useRef(false);
  const hydratedFormatRef = useRef<string | null>(null);
  const platformTouchedRef = useRef(false);

  // Restore from project.metadata when it arrives. Allow one follow-up pass
  // when a real format migrates in after a stub-only first hydrate.
  useEffect(() => {
    if (!savedInputs) return;

    const incomingFormat = savedInputs.format ?? savedInputs.purpose ?? null;
    const shouldHydrate =
      !didHydrateRef.current ||
      (!hydratedFormatRef.current && Boolean(incomingFormat));
    if (!shouldHydrate) return;

    didHydrateRef.current = true;
    if (incomingFormat) hydratedFormatRef.current = String(incomingFormat);

    const restoredFormat = resolveFormat(incomingFormat);
    setFormat(restoredFormat);

    const defaults =
      SEGMENT_DURATION_DEFAULTS[restoredFormat] ??
      SEGMENT_DURATION_DEFAULTS.compact_video;
    setMinDuration(
      typeof savedInputs.minSegmentDuration === "number"
        ? savedInputs.minSegmentDuration
        : defaults.min,
    );
    setMaxDuration(
      typeof savedInputs.maxSegmentDuration === "number"
        ? savedInputs.maxSegmentDuration
        : defaults.max,
    );
    setRetain(
      savedInputs.targetPercent != null &&
        savedInputs.targetPercent > 0 &&
        savedInputs.targetPercent <= 100
        ? String(savedInputs.targetPercent)
        : "auto",
    );
    if (
      savedInputs.assetType &&
      ASSET_TYPES.some((o) => o.value === savedInputs.assetType)
    ) {
      setAssetType(savedInputs.assetType);
    }
    if (
      !platformTouchedRef.current &&
      savedInputs.platform &&
      PLATFORMS.some((o) => o.value === savedInputs.platform)
    ) {
      setPlatform(savedInputs.platform);
      onPlatformChange?.(savedInputs.platform);
    }
    setUserPrompt(savedInputs.userPrompt?.trim() ?? "");
    setPublishReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedInputs]);

  useEffect(() => {
    if (!publishReady) return;
    onChange({
      format,
      assetType,
      platform,
      targetPercent: retain === "auto" ? null : Number.parseInt(retain, 10),
      minSegmentDuration: minDuration,
      maxSegmentDuration: maxDuration,
      userPrompt: userPrompt.trim() || undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    publishReady,
    format,
    assetType,
    platform,
    retain,
    minDuration,
    maxDuration,
    userPrompt,
  ]);

  const handleFormatChange = (next: string) => {
    setFormat(next);
    const defaults =
      SEGMENT_DURATION_DEFAULTS[next] ?? SEGMENT_DURATION_DEFAULTS.compact_video;
    setMinDuration(defaults.min);
    setMaxDuration(defaults.max);
    if (next === "compact_video") setRetain("auto");
  };

  const maxLength = 8000;

  return (
    <div className={cn("space-y-5", disabled && "opacity-60 pointer-events-none")}>
      <Field label="Asset Type">
        <OptionGrid options={ASSET_TYPES} value={assetType} onSelect={setAssetType} />
      </Field>

      <Field label="Dist. Platform">
        <OptionGrid
          options={PLATFORMS}
          value={platform}
          onSelect={(value) => {
            platformTouchedRef.current = true;
            setPlatform(value);
            onPlatformChange?.(value);
          }}
        />
      </Field>

      <Field label="Format">
        <OptionGrid options={FORMATS} value={format} onSelect={handleFormatChange} />
      </Field>
      {format === "compact_video" && (
        <Field label="Retain" hint="How much of the source should survive the cut">
          <div className="flex flex-wrap gap-2">
            {RETAIN_OPTIONS.map((opt) => (
              <Tooltip key={opt.value}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setRetain(opt.value)}
                    className={cn(
                      "px-4 py-2 rounded-lg text-sm font-medium transition-all border-2",
                      retain === opt.value
                        ? "bg-blue-600 border-blue-600 text-white shadow-md"
                        : "bg-card border-border hover:border-blue-400 text-foreground",
                    )}
                  >
                    {opt.label}
                  </button>
                </TooltipTrigger>
                <TooltipContent>{opt.tooltip}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        </Field>
      )}

      <Field
        label="Segment Duration"
        hint="Bounds the editor works to. It will flag anything outside them."
      >
        <div className="flex gap-3">
          <NumberField
            label="Min (sec)"
            value={minDuration}
            onCommit={(v) => setMinDuration(clamp(v, 1, maxDuration - 1))}
          />
          <NumberField
            label="Max (sec)"
            value={maxDuration}
            onCommit={(v) => setMaxDuration(clamp(v, minDuration + 1, 3600))}
          />
        </div>
      </Field>

      <Field label="Instructions" hint="Optional. Anything the editor should know.">
        <textarea
          value={userPrompt}
          onChange={(e) => setUserPrompt(e.target.value.slice(0, maxLength))}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder="e.g. Keep the Mara/Elias thread and drop the subplot entirely."
          className="w-full h-28 px-3 py-2.5 text-sm rounded-lg bg-card border-2 border-dashed border-border focus:border-blue-400 focus:border-solid focus:outline-none resize-y placeholder:text-muted-foreground/50"
        />
      </Field>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {label}
      </Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground/70">{hint}</p>}
    </div>
  );
}

function OptionGrid({
  options,
  value,
  onSelect,
}: {
  options: Option[];
  value: string;
  onSelect: (value: string) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {options.map((opt) => {
        const selected = value === opt.value;
        const isDisabled = opt.disabled === true;
        return (
          <Tooltip key={opt.value}>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={isDisabled}
                onClick={() => !isDisabled && onSelect(opt.value)}
                className={cn(
                  "flex flex-col items-center gap-1 p-2.5 rounded-lg border-2 transition-all",
                  isDisabled && "cursor-not-allowed opacity-50",
                  selected && !isDisabled
                    ? "bg-blue-600 border-blue-600 text-white shadow-md"
                    : "bg-card border-border hover:border-blue-400",
                )}
              >
                <opt.icon
                  className={cn(
                    "h-5 w-5",
                    selected && !isDisabled ? "text-white" : "text-muted-foreground",
                  )}
                />
                <span
                  className={cn(
                    "text-[10px] font-semibold leading-tight text-center",
                    selected && !isDisabled ? "text-white" : "text-foreground",
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

function NumberField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [lastValue, setLastValue] = useState(value);
  if (lastValue !== value) {
    setLastValue(value);
    setDraft(String(value));
  }

  const commit = () => {
    const parsed = Number.parseInt(draft, 10);
    if (Number.isFinite(parsed)) onCommit(parsed);
    setDraft(String(value));
  };

  return (
    <div className="flex-1">
      <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1 block">
        {label}
      </label>
      <input
        type="text"
        inputMode="numeric"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit();
        }}
        className="w-full px-3 py-2 text-sm rounded-lg bg-card border-2 border-border focus:border-blue-400 focus:outline-none"
      />
    </div>
  );
}
