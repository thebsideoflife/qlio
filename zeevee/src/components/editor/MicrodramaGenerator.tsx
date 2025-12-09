import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Tv,
  Film,
  Sparkles,
  Car,
  Megaphone,
  Clapperboard,
  Eye,
  Loader2,
  Wand2,
} from "lucide-react";
import { FaTiktok, FaInstagram, FaYoutube } from "react-icons/fa";
import { SiYoutubeshorts } from "react-icons/si";
import { cn } from "@/lib/utils";

interface MicrodramaGeneratorProps {
  onGenerate: (selections: any) => Promise<void>;
  isGenerating: boolean;
}

export function MicrodramaGenerator({
  onGenerate,
  isGenerating,
}: MicrodramaGeneratorProps) {
  const [selections, setSelections] = useState<Record<string, any>>({
    type: "",
    platform: "",
    audience: { gender: "all", age: ["18-24"] },
    driver: "",
    language: "english",
  });

  const handleGenerate = () => {
    onGenerate(selections);
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto p-4 space-y-8">
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-lg font-semibold text-primary">
          <Wand2 className="h-5 w-5" />
          <h3>AI Director</h3>
        </div>
        <p className="text-xs text-muted-foreground">
          Configure the parameters below and let our AI director find the
          perfect segments for your microdrama.
        </p>
      </div>
      {/* 1. Asset Type */}
      <section className="space-y-3">
        <Label className="text-sm font-medium">Content Type</Label>
        <div className="grid grid-cols-3 gap-2">
          <SelectionCard
            icon={Tv}
            label="TV"
            selected={selections.type === "tv"}
            onClick={() => setSelections({ ...selections, type: "tv" })}
          />
          <SelectionCard
            icon={Film}
            label="Movie"
            selected={selections.type === "movie"}
            onClick={() => setSelections({ ...selections, type: "movie" })}
          />
          <SelectionCard
            icon={Sparkles}
            label="UGC"
            selected={selections.type === "ugc"}
            onClick={() => setSelections({ ...selections, type: "ugc" })}
          />
        </div>
      </section>
      {/* 2. Platform */}
      <section className="space-y-3">
        <Label className="text-sm font-medium">Target Platform</Label>
        <div className="grid grid-cols-3 gap-2">
          <SelectionCard
            icon={FaTiktok}
            label="TikTok"
            selected={selections.platform === "tiktok"}
            onClick={() => setSelections({ ...selections, platform: "tiktok" })}
          />
          <SelectionCard
            icon={FaInstagram}
            label="Reels"
            selected={selections.platform === "ig"}
            onClick={() => setSelections({ ...selections, platform: "ig" })}
          />
          <SelectionCard
            icon={SiYoutubeshorts}
            label="Shorts"
            selected={selections.platform === "shorts"}
            onClick={() => setSelections({ ...selections, platform: "shorts" })}
          />
          <SelectionCard
            icon={FaYoutube}
            label="YouTube"
            selected={selections.platform === "youtube"}
            onClick={() =>
              setSelections({ ...selections, platform: "youtube" })
            }
          />
          <SelectionCard
            icon={Tv}
            label="SmartTV"
            selected={selections.platform === "tv"}
            onClick={() => setSelections({ ...selections, platform: "tv" })}
          />
          <SelectionCard
            icon={Car}
            label="Auto"
            selected={selections.platform === "auto"}
            onClick={() => setSelections({ ...selections, platform: "auto" })}
          />
        </div>
      </section>
      {/* 3. Audience */}
      <section className="space-y-4">
        <Label className="text-sm font-medium">Target Audience</Label>

        <div className="space-y-2">
          <span className="text-xs text-muted-foreground">Gender</span>
          <div className="flex gap-2">
            {["Male", "Female", "All"].map((g) => (
              <Button
                key={g}
                variant={
                  selections.audience.gender === g.toLowerCase()
                    ? "default"
                    : "outline"
                }
                size="sm"
                onClick={() =>
                  setSelections({
                    ...selections,
                    audience: {
                      ...selections.audience,
                      gender: g.toLowerCase(),
                    },
                  })
                }
                className="flex-1 h-8 text-xs"
              >
                {g}
              </Button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <span className="text-xs text-muted-foreground">Age Range</span>
          <div className="flex flex-wrap gap-2">
            {["13-17", "18-24", "25-34", "35+"].map((range) => (
              <div
                key={range}
                className={cn(
                  "flex items-center gap-2 px-3 py-1.5 border rounded-full cursor-pointer transition-colors text-xs",
                  selections.audience.age.includes(range)
                    ? "border-primary bg-primary/10 text-primary"
                    : "hover:bg-muted"
                )}
                onClick={() => {
                  const current = selections.audience.age;
                  const newAge = current.includes(range)
                    ? current.filter((a: string) => a !== range)
                    : [...current, range];
                  setSelections({
                    ...selections,
                    audience: { ...selections.audience, age: newAge },
                  });
                }}
              >
                {range}
              </div>
            ))}
          </div>
        </div>
      </section>
      {/* 4. Driver */}
      <section className="space-y-3">
        <Label className="text-sm font-medium">Business Driver</Label>
        <div className="grid grid-cols-3 gap-2">
          <SelectionCard
            icon={Megaphone}
            label="Marketing"
            selected={selections.driver === "marketing"}
            onClick={() =>
              setSelections({ ...selections, driver: "marketing" })
            }
          />
          <SelectionCard
            icon={Clapperboard}
            label="Teaser"
            selected={selections.driver === "teaser"}
            onClick={() => setSelections({ ...selections, driver: "teaser" })}
          />
          <SelectionCard
            icon={Eye}
            label="Views"
            selected={selections.driver === "viewership"}
            onClick={() =>
              setSelections({ ...selections, driver: "viewership" })
            }
          />
        </div>
      </section>
      <Button
        onClick={handleGenerate}
        disabled={isGenerating}
        className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white shadow-lg"
      >
        {isGenerating ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Analyzing Video...
          </>
        ) : (
          <>
            <Sparkles className="w-4 h-4 mr-2" />
            Generate Segments
          </>
        )}
      </Button>
      <div className="h-4" /> {/* Spacer */}
    </div>
  );
}

interface SelectionCardProps {
  icon: any;
  label: string;
  selected: boolean;
  onClick: () => void;
  className?: string;
}

function SelectionCard({
  icon: Icon,
  label,
  selected,
  onClick,
  className,
}: SelectionCardProps) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "flex flex-col items-center justify-center gap-2 p-3 rounded-lg border cursor-pointer transition-all hover:bg-accent/50",
        selected ? "border-blue-500 bg-blue-500/10" : "border-muted",
        className
      )}
    >
      <Icon
        className={cn(
          "h-5 w-5",
          selected ? "text-blue-500" : "text-muted-foreground"
        )}
      />
      <span className={cn("text-xs font-medium", selected && "text-blue-500")}>
        {label}
      </span>
    </div>
  );
}
