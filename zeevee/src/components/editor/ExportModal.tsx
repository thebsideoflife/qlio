import { useState, useEffect, useCallback } from "react";
import { useSelector, useDispatch } from "react-redux";
import type { RootState } from "@/store/store";
import {
  setLastSegmentRenders,
  clearLastSegmentRenders,
} from "@/store/editorSlice";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  startRender,
  getRenderStatus,
  type SegmentDownload,
} from "@/services/api";
import {
  Download,
  Loader2,
  CheckCircle,
  XCircle,
  Film,
  RefreshCw,
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
  const dispatch = useDispatch();
  const segments = useSelector((state: RootState) => state.editor.segments);
  const lastSegmentRenders = useSelector(
    (state: RootState) => state.editor.lastSegmentRenders
  );

  const [status, setStatus] = useState<RenderStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);
  const [segmentDownloads, setSegmentDownloads] = useState<SegmentDownload[]>(
    []
  );
  const [completedCount, setCompletedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Poll for render status
  useEffect(() => {
    if (!jobId || status === "completed" || status === "failed") return;

    let pollCount = 0;
    let timeoutId: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const result = await getRenderStatus(jobId);
        setProgress(result.progress);
        setCompletedCount(result.completedCount || 0);

        if (result.segmentDownloads) {
          setSegmentDownloads(result.segmentDownloads);
        }

        if (result.status === "completed") {
          setStatus("completed");
          if (result.segmentDownloads) {
            const completedRenders = result.segmentDownloads
              .filter((s) => s.status === "completed" && s.downloadUrl)
              .map((s) => ({
                segmentId: s.segmentId,
                title: s.title,
                url: s.downloadUrl!,
              }));
            dispatch(setLastSegmentRenders(completedRenders));
          }
          return;
        } else if (result.status === "failed") {
          setStatus("failed");
          setError(result.error || "Render failed");
          return;
        }

        pollCount++;
        const nextDelay = Math.min(2000 * Math.pow(1.5, pollCount), 10000);
        timeoutId = setTimeout(poll, nextDelay);
      } catch {
        pollCount++;
        const nextDelay = Math.min(2000 * Math.pow(1.5, pollCount), 10000);
        timeoutId = setTimeout(poll, nextDelay);
      }
    };

    poll();

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [jobId, status, dispatch]);

  const handleStartRender = useCallback(async () => {
    dispatch(clearLastSegmentRenders());
    setStatus("starting");
    setProgress(0);
    setError(null);
    setSegmentDownloads([]);
    setCompletedCount(0);

    try {
      const result = await startRender(projectId, {
        outputFormat: "mp4",
        quality: "standard",
      });
      setJobId(result.jobId);
      setStatus("rendering");
    } catch (err: unknown) {
      setStatus("failed");
      const error = err as { response?: { data?: { error?: string } } };
      setError(error.response?.data?.error || "Failed to start render");
    }
  }, [projectId, dispatch]);

  const handleDownload = useCallback((url: string, title: string) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title}.mp4`;
    a.target = "_blank";
    a.click();
  }, []);

  const handleClose = useCallback(() => {
    if (status !== "rendering" && status !== "starting") {
      setStatus("idle");
      setProgress(0);
      setJobId(null);
      setSegmentDownloads([]);
      setCompletedCount(0);
      setError(null);
      onOpenChange(false);
    }
  }, [status, onOpenChange]);

  const hasCachedRenders = lastSegmentRenders && lastSegmentRenders.length > 0;
  const isProcessing = status === "starting" || status === "rendering";

  // Build render list based on state
  const renderList: Array<{
    segmentId: string;
    title: string;
    status: "pending" | "rendering" | "completed" | "failed";
    downloadUrl?: string;
  }> =
    hasCachedRenders && status === "idle"
      ? lastSegmentRenders.map((r) => ({
          segmentId: r.segmentId,
          title: r.title,
          status: "completed" as const,
          downloadUrl: r.url,
        }))
      : segmentDownloads.length > 0
      ? segmentDownloads
      : segments.map((s) => ({
          segmentId: s.id,
          title: s.title,
          status: isProcessing ? ("rendering" as const) : ("pending" as const),
        }));

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Film className="h-5 w-5" />
            Export {segments.length} Video{segments.length !== 1 ? "s" : ""}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Progress bar when processing */}
          {isProcessing && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {status === "starting"
                    ? "Preparing..."
                    : `Exporting ${completedCount}/${segments.length}`}
                </span>
                <span className="font-medium">{progress}%</span>
              </div>
              <Progress value={progress} className="h-2" />
            </div>
          )}

          {/* Success message */}
          {(status === "completed" ||
            (status === "idle" && hasCachedRenders)) && (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-green-600">
                <CheckCircle className="h-4 w-4" />
                <span className="text-sm font-medium">Ready to download</span>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleStartRender}
                className="h-8 text-xs"
              >
                <RefreshCw className="h-3 w-3 mr-1" />
                Re-render
              </Button>
            </div>
          )}

          {/* Error message */}
          {status === "failed" && (
            <div className="p-3 bg-red-50 dark:bg-red-950/50 rounded-lg border border-red-200 dark:border-red-900">
              <div className="flex items-center gap-2 text-red-600">
                <XCircle className="h-4 w-4" />
                <span className="text-sm font-medium">Export failed</span>
              </div>
              {error && (
                <p className="text-xs text-muted-foreground mt-1">{error}</p>
              )}
            </div>
          )}

          {/* Segment list */}
          <div className="max-h-64 overflow-y-auto space-y-1 rounded-lg border bg-muted/30 p-2">
            {renderList.map((item) => {
              const isCompleted = item.status === "completed";
              const isFailed = item.status === "failed";
              const isPending = item.status === "pending";

              return (
                <div
                  key={item.segmentId}
                  className={`flex items-center justify-between px-3 py-2 rounded-md text-sm ${
                    isCompleted
                      ? "bg-green-500/10"
                      : isFailed
                      ? "bg-red-500/10"
                      : "bg-background/50"
                  }`}
                >
                  <span className="truncate flex-1 mr-2">{item.title}</span>
                  {isCompleted && item.downloadUrl ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-green-600 hover:text-green-700 hover:bg-green-500/20"
                      onClick={() =>
                        handleDownload(item.downloadUrl!, item.title)
                      }
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                  ) : isFailed ? (
                    <XCircle className="h-4 w-4 text-red-500" />
                  ) : isPending ? (
                    <span className="text-xs text-muted-foreground">—</span>
                  ) : (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={handleClose}>
            {status === "completed" || hasCachedRenders ? "Done" : "Cancel"}
          </Button>
          {status === "idle" && !hasCachedRenders && (
            <Button
              onClick={handleStartRender}
              disabled={segments.length === 0}
            >
              Start Export
            </Button>
          )}
          {status === "failed" && (
            <Button onClick={handleStartRender}>Try Again</Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
