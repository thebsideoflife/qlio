import { useState, useEffect, useCallback } from "react";
import { useSelector } from "react-redux";
import type { RootState } from "@/store/store";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { startRender, getRenderStatus } from "@/services/api";
import {
  Download,
  Loader2,
  CheckCircle,
  XCircle,
  Film,
  Captions as CaptionsIcon,
  Crop,
} from "lucide-react";

interface ExportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}

type RenderStatus = "idle" | "starting" | "rendering" | "completed" | "failed";

export function ExportModal({
  open,
  onOpenChange,
  projectId,
}: ExportModalProps) {
  const segments = useSelector((state: RootState) => state.editor.segments);
  const captions = useSelector((state: RootState) => state.editor.captions);
  const captionSettings = useSelector(
    (state: RootState) => state.editor.captionSettings
  );
  const globalFraming = useSelector(
    (state: RootState) => state.editor.globalFraming
  );

  const [outputFormat, setOutputFormat] = useState<"mp4" | "webm">("mp4");
  const [quality, setQuality] = useState<"draft" | "standard" | "high">(
    "standard"
  );
  const [status, setStatus] = useState<RenderStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Calculate estimated duration
  const totalDuration = segments.reduce(
    (sum, seg) => sum + (seg.endTime - seg.startTime),
    0
  );

  // Poll for render status with exponential backoff
  useEffect(() => {
    if (!jobId || status === "completed" || status === "failed") return;

    let pollCount = 0;
    let timeoutId: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const result = await getRenderStatus(jobId);
        setProgress(result.progress);

        if (result.status === "completed") {
          setStatus("completed");
          setDownloadUrl(result.downloadUrl || null);
          return; // Stop polling
        } else if (result.status === "failed") {
          setStatus("failed");
          setError(result.error || "Render failed");
          return; // Stop polling
        }

        // Exponential backoff: 2s → 3s → 5s → 8s → 10s (max)
        pollCount++;
        const nextDelay = Math.min(2000 * Math.pow(1.5, pollCount), 10000);
        timeoutId = setTimeout(poll, nextDelay);
      } catch (err) {
        // Continue polling on error (network issues, etc)
        pollCount++;
        const nextDelay = Math.min(2000 * Math.pow(1.5, pollCount), 10000);
        timeoutId = setTimeout(poll, nextDelay);
      }
    };

    // Start first poll immediately
    poll();

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [jobId, status]);

  const handleStartRender = useCallback(async () => {
    setStatus("starting");
    setProgress(0);
    setError(null);
    setDownloadUrl(null);

    try {
      // Only send render options - all project data (segments, captions, framing)
      // is read from the database by the backend for data integrity
      const result = await startRender(projectId, {
        outputFormat,
        quality,
      });

      setJobId(result.jobId);
      setStatus("rendering");
    } catch (err: unknown) {
      setStatus("failed");
      const error = err as { response?: { data?: { error?: string } } };
      setError(error.response?.data?.error || "Failed to start render");
    }
  }, [projectId, outputFormat, quality]);

  const handleDownload = useCallback(() => {
    if (downloadUrl) {
      window.open(downloadUrl, "_blank");
    }
  }, [downloadUrl]);

  const handleClose = useCallback(() => {
    if (status !== "rendering" && status !== "starting") {
      setStatus("idle");
      setProgress(0);
      setJobId(null);
      setDownloadUrl(null);
      setError(null);
      onOpenChange(false);
    }
  }, [status, onOpenChange]);

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Film className="h-5 w-5" />
            Export Video
          </DialogTitle>
          <DialogDescription>
            Render your edited video with captions burned in.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Summary */}
          <div className="bg-muted rounded-lg p-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Segments</span>
              <span className="font-medium">{segments.length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Duration</span>
              <span className="font-medium">
                {formatDuration(totalDuration)}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Captions</span>
              <span className="font-medium flex items-center gap-1">
                {captionSettings.enabled ? (
                  <>
                    <CaptionsIcon className="h-3 w-3" />
                    {captions.length} lines
                  </>
                ) : (
                  "Disabled"
                )}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Framing</span>
              <span className="font-medium flex items-center gap-1">
                {globalFraming.enabled ? (
                  <>
                    <Crop className="h-3 w-3" />
                    {globalFraming.aspectRatio}
                  </>
                ) : (
                  "Original"
                )}
              </span>
            </div>
          </div>

          {/* Settings */}
          {status === "idle" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Format</Label>
                <Select
                  value={outputFormat}
                  onValueChange={(v) => setOutputFormat(v as "mp4" | "webm")}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mp4">MP4 (H.264)</SelectItem>
                    <SelectItem value="webm">WebM (VP8)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Quality</Label>
                <Select
                  value={quality}
                  onValueChange={(v) =>
                    setQuality(v as "draft" | "standard" | "high")
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">Draft (Fast)</SelectItem>
                    <SelectItem value="standard">Standard</SelectItem>
                    <SelectItem value="high">High Quality</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {/* Progress */}
          {(status === "starting" || status === "rendering") && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">
                  {status === "starting"
                    ? "Starting render..."
                    : `Rendering... ${progress}%`}
                </span>
              </div>
              <Progress value={progress} />
              <p className="text-xs text-muted-foreground">
                This may take a few minutes. You can close this dialog and check
                back later.
              </p>
            </div>
          )}

          {/* Success */}
          {status === "completed" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-green-600">
                <CheckCircle className="h-5 w-5" />
                <span className="font-medium">Render complete!</span>
              </div>
              <Button onClick={handleDownload} className="w-full">
                <Download className="h-4 w-4 mr-2" />
                Download Video
              </Button>
            </div>
          )}

          {/* Error */}
          {status === "failed" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-red-600">
                <XCircle className="h-5 w-5" />
                <span className="font-medium">Render failed</span>
              </div>
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button onClick={() => setStatus("idle")} variant="outline">
                Try Again
              </Button>
            </div>
          )}
        </div>

        {/* Actions */}
        {status === "idle" && (
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              onClick={handleStartRender}
              disabled={segments.length === 0}
            >
              <Film className="h-4 w-4 mr-2" />
              Start Render
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
