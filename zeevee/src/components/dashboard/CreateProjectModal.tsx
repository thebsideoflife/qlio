import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Tv,
  Film,
  Sparkles,
  Car,
  Scissors,
  BookOpen,
  Flame,
  Megaphone,
  Clapperboard,
  Eye,
  Languages,
  ArrowRight,
  ArrowLeft,
  Loader2,
} from "lucide-react";
import { FaTiktok, FaInstagram, FaYoutube } from "react-icons/fa";
import { SiYoutubeshorts } from "react-icons/si";
import { cn } from "@/lib/utils";
import { createProject } from "@/services/api";
import { useNavigate } from "react-router-dom";

interface CreateProjectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assetId: string;
}

const STEPS = [
  {
    id: 1,
    title: "Asset Type",
    description: "What kind of content do you want to edit?",
  },
  {
    id: 2,
    title: "Target Platform",
    description: "Select your target platform",
  },
  {
    id: 3,
    title: "Target Audience",
    description: "Define your intended audience",
  },
  {
    id: 4,
    title: "Business Driver",
    description: "What's the purpose of this content?",
  },
  { id: 5, title: "Output Language", description: "Select the language" },
];

export function CreateProjectModal({
  open,
  onOpenChange,
  assetId,
}: CreateProjectModalProps) {
  const [step, setStep] = useState(1);
  const [isCreating, setIsCreating] = useState(false);
  const navigate = useNavigate();

  const [selections, setSelections] = useState<Record<string, any>>({
    type: "",
    platform: "",
    format: "",
    audience: { gender: "all", age: ["18-24"] },
    driver: "",
    language: "english",
  });

  const handleNext = async () => {
    if (step < STEPS.length) {
      setStep(step + 1);
    } else {
      // Finish & Create Project
      await handleFinish();
    }
  };

  const handleFinish = async () => {
    setIsCreating(true);
    try {
      const result = await createProject(assetId, selections);
      console.log("Project created:", result);
      setIsCreating(false);
      onOpenChange(false);
      // Navigate to editor or show success?
      // Assuming we want to edit the project now.
      // Note: The editor currently takes assetId. We might need to change it to take projectId eventually.
      // For now, I'll navigate to editor with assetId as before, but maybe we should pass projectId?
      // The user asked for a separate video object. The Editor likely needs to load the "Project" not just the Asset.
      // But refactoring the Editor is out of scope unless necessary.
      // I'll stick to navigating to editor for now.
      // TODO: Update Editor to work with Project ID or load project data.
      if (result && result.projectId) {
        navigate(`/editor/${result.projectId}`);
      } else {
        console.error("Project ID missing in response", result);
        // Fallback or alert?
      }
    } catch (error) {
      console.error("Failed to create project:", error);
      alert("Failed to create project. Please try again.");
      setIsCreating(false);
    }
  };

  const handleBack = () => {
    if (step > 1) setStep(step - 1);
  };

  const renderStepContent = () => {
    switch (step) {
      case 1: // Asset Type
        return (
          <div className="grid grid-cols-3 gap-4 mt-4">
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
        );
      case 2: // Platform
        return (
          <div className="grid grid-cols-3 gap-4 mt-4">
            <SelectionCard
              icon={FaTiktok}
              label="TikTok"
              selected={selections.platform === "tiktok"}
              onClick={() =>
                setSelections({ ...selections, platform: "tiktok" })
              }
            />
            <SelectionCard
              icon={FaInstagram}
              label="IG Reels"
              selected={selections.platform === "ig"}
              onClick={() => setSelections({ ...selections, platform: "ig" })}
            />
            <SelectionCard
              icon={SiYoutubeshorts}
              label="Shorts"
              selected={selections.platform === "shorts"}
              onClick={() =>
                setSelections({ ...selections, platform: "shorts" })
              }
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
              label="Automotive"
              selected={selections.platform === "auto"}
              onClick={() => setSelections({ ...selections, platform: "auto" })}
            />
          </div>
        );
      case 3: // Audience
        return (
          <div className="space-y-6 mt-4">
            <div className="space-y-3">
              <Label>Gender</Label>
              <div className="flex gap-4">
                {["Male", "Female", "All"].map((g) => (
                  <Button
                    key={g}
                    variant={
                      selections.audience.gender === g.toLowerCase()
                        ? "default"
                        : "outline"
                    }
                    onClick={() =>
                      setSelections({
                        ...selections,
                        audience: {
                          ...selections.audience,
                          gender: g.toLowerCase(),
                        },
                      })
                    }
                    className="flex-1"
                  >
                    {g}
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-3">
              <Label>Age Range</Label>
              <div className="grid grid-cols-1 gap-2">
                {["13-17", "18-24", "25-34"].map((range) => (
                  <div
                    key={range}
                    className={cn(
                      "flex items-center gap-2 p-3 border rounded-md cursor-pointer transition-colors",
                      selections.audience.age.includes(range)
                        ? "border-primary bg-primary/10"
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
                    <div
                      className={cn(
                        "h-4 w-4 rounded border flex items-center justify-center",
                        selections.audience.age.includes(range)
                          ? "bg-primary border-primary text-primary-foreground"
                          : "border-muted-foreground"
                      )}
                    >
                      {selections.audience.age.includes(range) && (
                        <div className="h-2 w-2 bg-current rounded-sm" />
                      )}
                    </div>
                    <span className="text-sm">{range}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      case 4: // Driver
        return (
          <div className="grid grid-cols-3 gap-4 mt-4">
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
              label="Viewership"
              selected={selections.driver === "viewership"}
              onClick={() =>
                setSelections({ ...selections, driver: "viewership" })
              }
            />
          </div>
        );
      case 5: // Language
        return (
          <div className="grid grid-cols-3 gap-4 mt-4">
            <SelectionCard
              icon={Languages}
              label="English"
              selected={selections.language === "english"}
              onClick={() =>
                setSelections({ ...selections, language: "english" })
              }
            />
            <SelectionCard
              icon={Languages}
              label="Spanish"
              selected={selections.language === "spanish"}
              onClick={() =>
                setSelections({ ...selections, language: "spanish" })
              }
            />
            <SelectionCard
              icon={Languages}
              label="..."
              selected={false}
              onClick={() => {}}
              className="opacity-50"
            />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(val) => {
        if (!isCreating) onOpenChange(val);
      }}
    >
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>
            Create Microdrama - Step {step} of {STEPS.length}
          </DialogTitle>
          <p className="text-sm text-muted-foreground mt-1.5">
            {STEPS[step - 1].description}
          </p>
        </DialogHeader>

        <div className="py-4 min-h-[300px]">{renderStepContent()}</div>

        <DialogFooter className="flex justify-between sm:justify-between">
          <Button
            variant="ghost"
            onClick={handleBack}
            disabled={step === 1 || isCreating}
          >
            <ArrowLeft className="w-4 h-4 mr-2" /> Back
          </Button>
          <Button onClick={handleNext} disabled={isCreating}>
            {isCreating ? (
              <>
                Creating Project{" "}
                <Loader2 className="w-4 h-4 ml-2 animate-spin" />
              </>
            ) : step === STEPS.length ? (
              <>
                Finish <ArrowRight className="w-4 h-4 ml-2" />
              </>
            ) : (
              <>
                Next <ArrowRight className="w-4 h-4 ml-2" />
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
        "flex flex-col items-center justify-center gap-3 p-6 rounded-xl border-2 cursor-pointer transition-all hover:bg-accent/50",
        selected ? "border-blue-500 bg-blue-500/10" : "border-muted",
        className
      )}
    >
      <div
        className={cn(
          "p-3 rounded-lg",
          selected ? "bg-blue-500 text-white" : "bg-muted text-foreground"
        )}
      >
        <Icon className="h-8 w-8" />
      </div>
      <span className="font-medium text-center">{label}</span>
    </div>
  );
}
