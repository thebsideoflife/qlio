import { useState, useRef } from "react";
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
import { ArrowRight, Upload, Loader2, AlertCircle } from "lucide-react";
import {
  getUploadCredentials,
  type UploadCredentialsResponse,
} from "@/services/api";
import { uploadToS3 } from "@/services/s3Upload";
import { cn } from "@/lib/utils";
import type { AppDispatch } from "@/store/store";

// Maximum video duration in seconds (2 hours)
const MAX_VIDEO_DURATION_SECONDS = 120 * 60;

interface UploadWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function UploadWizard({ open, onOpenChange }: UploadWizardProps) {
  const [step, setStep] = useState(1);
  const dispatch = useDispatch<AppDispatch>();
  const [file, setFile] = useState<File | null>(null);

  // Track asset creation and upload status
  const [assetId, setAssetId] = useState<string | null>(null);
  const [isCreatingAsset, setIsCreatingAsset] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<
    "idle" | "uploading" | "done" | "error"
  >("idle");
  const [uploadPercentage, setUploadPercentage] = useState(0);
  const [durationError, setDurationError] = useState<string | null>(null);

  // Store upload info for background upload
  const uploadInfoRef = useRef<UploadCredentialsResponse | null>(null);

  const handleNext = async () => {
    if (step === 1) {
      if (!file) return;
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
    setUploadPercentage(0);
    setDurationError(null);

    // 1. Get Duration on Client Side
    let duration = 0;
    try {
      duration = await new Promise<number>((resolve) => {
        const video = document.createElement("video");
        video.preload = "metadata";
        video.onloadedmetadata = () => {
          window.URL.revokeObjectURL(video.src);
          resolve(video.duration);
        };
        video.onerror = () => {
          console.warn("Failed to load video metadata");
          resolve(0); // non-fatal
        };
        video.src = window.URL.createObjectURL(file);
      });
      console.log("Client-side video duration:", duration);
    } catch (err) {
      console.warn("Error getting video duration:", err);
    }

    // 2. Validate duration (max 2 hours)
    if (duration > MAX_VIDEO_DURATION_SECONDS) {
      const durationMinutes = Math.round(duration / 60);
      setDurationError(
        `Video is too long (${durationMinutes} minutes). Maximum allowed duration is 120 minutes.`,
      );
      setIsCreatingAsset(false);
      setUploadProgress("idle");
      return;
    }

    try {
      // 2. Get temporary credentials for multipart upload
      const uploadInfo = await getUploadCredentials(file.type, {
        filename: file.name,
        duration,
      });

      uploadInfoRef.current = uploadInfo;
      setAssetId(uploadInfo.assetId);
      setIsCreatingAsset(false);

      // 3. Add to Store (Optimistic update)
      const newAsset = {
        id: uploadInfo.assetId,
        title: file.name,
        status: "uploading" as const,
        format: "1080p",
        size: `${(file.size / (1024 * 1024)).toFixed(1)} MB`,
        segmentCount: 0,
        createdAt: new Date().toISOString(),
        uploadProgress: 0,
      };

      dispatch(addAsset(newAsset));

      // Close wizard immediately to let upload run in background
      closeWizard();

      // 4. Start multipart upload in background with progress tracking
      uploadToS3(uploadInfo, file, (progress) => {
        setUploadPercentage(progress.percentage);
        console.log(`Upload progress: ${progress.percentage}%`);
        dispatch(
          updateAssetStatus({
            id: uploadInfo.assetId,
            status: "uploading",
            progress: progress.percentage,
          }),
        );
      })
        .then(() => {
          setUploadProgress("done");
          console.log("Multipart upload finished successfully");
          dispatch(
            updateAssetStatus({
              id: uploadInfo.assetId,
              status: "indexing",
            }),
          );
        })
        .catch((err) => {
          console.error("Multipart upload failed", err);
          dispatch(
            updateAssetStatus({
              id: uploadInfo.assetId,
              status: "failed",
            }),
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
      setDurationError(null);
    }, 300);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setDurationError(null); // Clear any previous duration error
    }
  };

  const renderStepContent = () => {
    return (
      <div className="flex flex-col items-center justify-center h-full border-2 border-dashed rounded-xl p-10 mt-4 bg-muted/20 hover:bg-muted/40 transition-colors">
        <input
          type="file"
          id="video-upload"
          className="hidden"
          accept="video/mp4,video/quicktime,video/webm,video/x-m4v"
          onChange={handleFileChange}
          disabled={isCreatingAsset || uploadProgress === "uploading"}
        />
        <Label
          htmlFor="video-upload"
          className={cn(
            "cursor-pointer flex flex-col items-center gap-4",
            (isCreatingAsset || uploadProgress === "uploading") &&
              "opacity-50 cursor-not-allowed",
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
            Select a video file to upload. You can create a microseries from it
            later.
          </p>
        </DialogHeader>

        <div className="py-4 min-h-[300px]">
          {renderStepContent()}
          {durationError && (
            <div className="mt-4 p-3 bg-destructive/10 border border-destructive/20 rounded-lg flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
              <p className="text-sm text-destructive">{durationError}</p>
            </div>
          )}
        </div>

        <DialogFooter className="flex justify-end sm:justify-end">
          <Button
            onClick={handleNext}
            disabled={
              !file || isCreatingAsset || uploadProgress === "uploading"
            }
          >
            {isCreatingAsset || uploadProgress === "uploading" ? (
              <>
                Uploading {uploadPercentage > 0 && `(${uploadPercentage}%)`}{" "}
                <Loader2 className="w-4 h-4 ml-2 animate-spin" />
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
