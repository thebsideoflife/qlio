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
import { useDispatch } from "react-redux";
import { addAsset, updateAssetStatus } from "@/store/assetsSlice";
import { ArrowRight, Upload, Loader2 } from "lucide-react";
import { getUploadUrl, uploadToS3 } from "@/services/api";
import { cn } from "@/lib/utils";
import type { AppDispatch } from "@/store/store";

interface UploadWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function UploadWizard({ open, onOpenChange }: UploadWizardProps) {
  // We only have 1 step now, but keeping structure for simplicity if we add more upload-specific steps
  const [step, setStep] = useState(1);
  const dispatch = useDispatch<AppDispatch>();
  const [file, setFile] = useState<File | null>(null);

  // Track asset creation and upload status
  const [assetId, setAssetId] = useState<string | null>(null);
  const [isCreatingAsset, setIsCreatingAsset] = useState(false); // Creating DB record
  const [uploadProgress, setUploadProgress] = useState<
    "idle" | "uploading" | "done" | "error"
  >("idle");

  const handleNext = async () => {
    if (step === 1) {
      if (!file) return;
      // Start upload process if not already started
      if (!assetId && !isCreatingAsset) {
        await startUploadProcess();
      }
    } else {
      closeWizard();
    }
  };

  const startUploadProcess = async () => {
    if (!file) return;
    setIsCreatingAsset(true);
    setUploadProgress("uploading");

    try {
      // 1. Get Signed URL (Basic metadata for file)
      const { uploadUrl, assetId: newAssetId } = await getUploadUrl(file.type, {
        filename: file.name,
      });

      setAssetId(newAssetId);
      setIsCreatingAsset(false);

      // 2. Add to Store (Optimistic update)
      const newAsset = {
        id: newAssetId,
        title: file.name,
        thumbnail:
          "https://images.unsplash.com/photo-1626814026160-2237a95fc5a0?w=800&auto=format&fit=crop&q=60", // Placeholder
        status: "uploading" as const,
        format: "1080p",
        size: `${(file.size / (1024 * 1024)).toFixed(1)} MB`,
        segmentCount: 0,
        createdAt: new Date().toISOString(),
      };
      // @ts-ignore
      dispatch(addAsset(newAsset));

      // Close wizard immediately to let upload run in background
      closeWizard();

      // 3. Start Upload to S3 in background (don't await here for UI block, but we want to catch errors)
      // We'll let it run and update status on completion/fail.
      uploadToS3(uploadUrl, file)
        .then(() => {
          setUploadProgress("done");
          console.log("Background upload finished");
          // Optimistically update status to indexing
          dispatch(
            updateAssetStatus({
              id: newAssetId,
              status: "indexing",
            })
          );
          // Wizard already closed
        })
        .catch((err) => {
          console.error("Background upload failed", err);
          // Update status to failed
          dispatch(
            updateAssetStatus({
              id: newAssetId,
              status: "failed",
            })
          );
        });
    } catch (error) {
      console.error("Failed to start upload:", error);
      setIsCreatingAsset(false);
      setUploadProgress("error");
      alert("Failed to initiate upload. Please try again.");
    }
  };

  const closeWizard = () => {
    onOpenChange(false);
    // Delay reset to avoid UI flicker while closing
    setTimeout(() => {
      setStep(1);
      setFile(null);
      setAssetId(null);
      setUploadProgress("idle");
      setIsCreatingAsset(false);
    }, 300);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
    }
  };

  const renderStepContent = () => {
    return (
      <div className="flex flex-col items-center justify-center h-full border-2 border-dashed rounded-xl p-10 mt-4 bg-muted/20 hover:bg-muted/40 transition-colors">
        <input
          type="file"
          id="video-upload"
          className="hidden"
          accept="video/mp4,video/quicktime,video/webm"
          onChange={handleFileChange}
          disabled={isCreatingAsset || uploadProgress === "uploading"}
        />
        <Label
          htmlFor="video-upload"
          className={cn(
            "cursor-pointer flex flex-col items-center gap-4",
            (isCreatingAsset || uploadProgress === "uploading") &&
              "opacity-50 cursor-not-allowed"
          )}
        >
          <div className="p-4 bg-background rounded-full shadow-sm">
            {uploadProgress === "uploading" ? (
              <Loader2 className="w-8 h-8 text-primary animate-spin" />
            ) : (
              <Upload className="w-8 h-8 text-primary" />
            )}
          </div>
          <div className="text-center">
            <h3 className="text-lg font-semibold">
              {file ? file.name : "Select Video File"}
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              {file
                ? `${(file.size / (1024 * 1024)).toFixed(2)} MB`
                : "MP4, MOV or WebM"}
            </p>
          </div>
          {!file && (
            <Button variant="secondary" className="mt-2" asChild>
              <span className="cursor-pointer">Choose File</span>
            </Button>
          )}
        </Label>
      </div>
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(val) => {
        // Prevent closing if critical create is happening
        if (!isCreatingAsset && uploadProgress !== "uploading")
          onOpenChange(val);
      }}
    >
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>Upload Video</span>
          </DialogTitle>
          <p className="text-sm text-muted-foreground mt-1.5">
            Select a video file to upload. You can create a microdrama from it
            later.
          </p>
        </DialogHeader>

        <div className="py-4 min-h-[300px]">{renderStepContent()}</div>

        <DialogFooter className="flex justify-end sm:justify-end">
          <Button
            onClick={handleNext}
            disabled={
              !file || isCreatingAsset || uploadProgress === "uploading"
            }
          >
            {isCreatingAsset || uploadProgress === "uploading" ? (
              <>
                Uploading <Loader2 className="w-4 h-4 ml-2 animate-spin" />
              </>
            ) : uploadProgress === "done" ? (
              "Done"
            ) : (
              <>
                Start Upload <ArrowRight className="w-4 h-4 ml-2" />
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Removed SelectionCard as it is no longer used here
