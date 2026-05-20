import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, ArrowRight } from "lucide-react";
import { createProject } from "@/services/api";
import { useNavigate } from "react-router-dom";

interface CreateProjectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assetId: string;
}

export function CreateProjectModal({
  open,
  onOpenChange,
  assetId,
}: CreateProjectModalProps) {
  const [isCreating, setIsCreating] = useState(false);
  const navigate = useNavigate();

  const handleCreate = async () => {
    setIsCreating(true);
    try {
      const result = await createProject(assetId, {});
      setIsCreating(false);
      onOpenChange(false);
      if (result?.projectId) {
        navigate(`/editor/${result.projectId}`);
      } else {
        console.error("Project ID missing in response", result);
      }
    } catch (error) {
      console.error("Failed to create project:", error);
      alert("Failed to create project. Please try again.");
      setIsCreating(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(val) => {
        if (!isCreating) onOpenChange(val);
      }}
    >
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Create Microseries</DialogTitle>
          <p className="text-sm text-muted-foreground mt-1.5">
            Start editing this video. You can configure format and style in the
            editor.
          </p>
        </DialogHeader>

        <DialogFooter className="mt-4">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isCreating}
          >
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={isCreating}>
            {isCreating ? (
              <>
                Creating… <Loader2 className="w-4 h-4 ml-2 animate-spin" />
              </>
            ) : (
              <>
                Open in Editor <ArrowRight className="w-4 h-4 ml-2" />
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
