import { useState, useEffect, useCallback, useMemo, useRef } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  startRender,
  getRenderStatus,
  getProjectJobStatus,
  type SegmentDownload,
} from "@/services/api";
import {
  Download,
  Loader2,
  CheckCircle2,
  XCircle,
  Film,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";

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
    (state: RootState) => state.editor.lastSegmentRenders,
  );

  const [status, setStatus] = useState<RenderStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);
  const [segmentDownloads, setSegmentDownloads] = useState<SegmentDownload[]>(
    [],
  );
  const [completedCount, setCompletedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selectedSegmentIds, setSelectedSegmentIds] = useState<Set<string>>(
    new Set(),
  );

  // Build a map of segment ID -> cached render URL
  const cachedRenderMap = useMemo(() => {
    const map = new Map<string, string>();
    if (lastSegmentRenders) {
      for (const render of lastSegmentRenders) {
        map.set(render.segmentId, render.url);
      }
    }
    return map;
  }, [lastSegmentRenders]);

  // Track whether we've checked for active render job this session
  const checkedActiveJobRef = useRef(false);

  // Initialize with none selected when modal opens
  // Also check for active render job to resume polling (handles page refresh)
  useEffect(() => {
    if (open) {
      setSelectedSegmentIds(new Set());

      // Check for active render job once per modal open (handles page refresh scenario)
      if (!checkedActiveJobRef.current) {
        checkedActiveJobRef.current = true;
        (async () => {
          try {
            const jobStatus = await getProjectJobStatus(projectId);
            if (jobStatus.activeRenderJobId) {
              // Resume polling for the active render
              setJobId(jobStatus.activeRenderJobId);
              setStatus("rendering");
            }
          } catch {
            // Non-fatal - modal will work normally
          }
        })();
      }
    } else {
      // Reset check flag when modal closes
      checkedActiveJobRef.current = false;
    }
  }, [open, projectId]);

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
            const newRenders = result.segmentDownloads
              .filter((s) => s.status === "completed" && s.downloadUrl)
              .map((s) => ({
                segmentId: s.segmentId,
                title: s.title,
                url: s.downloadUrl!,
              }));

            const mergedMap = new Map(
              (lastSegmentRenders || []).map((r) => [r.segmentId, r]),
            );
            for (const render of newRenders) {
              mergedMap.set(render.segmentId, render);
            }

            dispatch(setLastSegmentRenders(Array.from(mergedMap.values())));
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
  }, [jobId, status, dispatch, lastSegmentRenders]);

  const handleStartRender = useCallback(async () => {
    const rendersToKeep = (lastSegmentRenders || []).filter(
      (r) => !selectedSegmentIds.has(r.segmentId),
    );
    if (rendersToKeep.length > 0) {
      dispatch(setLastSegmentRenders(rendersToKeep));
    } else {
      dispatch(clearLastSegmentRenders());
    }

    setStatus("starting");
    setProgress(0);
    setError(null);
    setSegmentDownloads([]);
    setCompletedCount(0);

    try {
      const result = await startRender(projectId, {
        outputFormat: "mp4",
        quality: "standard",
        segmentIds: Array.from(selectedSegmentIds),
      });
      setJobId(result.jobId);
      setStatus("rendering");
    } catch (err: unknown) {
      setStatus("failed");
      const error = err as { response?: { data?: { error?: string } } };
      setError(error.response?.data?.error || "Failed to start render");
    }
  }, [projectId, dispatch, selectedSegmentIds, lastSegmentRenders]);

  const handleDownload = useCallback((url: string, title: string) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title}.mp4`;
    a.target = "_blank";
    a.click();
  }, []);

  const handleClose = useCallback(() => {
    // Always allow closing — renders continue server-side regardless
    setStatus("idle");
    setProgress(0);
    setJobId(null);
    setSegmentDownloads([]);
    setCompletedCount(0);
    setError(null);
    onOpenChange(false);
  }, [onOpenChange]);

  const toggleSegment = useCallback((segmentId: string) => {
    setSelectedSegmentIds((prev) => {
      const next = new Set(prev);
      if (next.has(segmentId)) {
        next.delete(segmentId);
      } else {
        next.add(segmentId);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedSegmentIds(new Set(segments.map((s) => s.id)));
  }, [segments]);

  const selectNone = useCallback(() => {
    setSelectedSegmentIds(new Set());
  }, []);

  const selectUnrendered = useCallback(() => {
    const unrenderedIds = segments
      .filter((s) => !cachedRenderMap.has(s.id))
      .map((s) => s.id);
    setSelectedSegmentIds(new Set(unrenderedIds));
  }, [segments, cachedRenderMap]);

  const isProcessing = status === "starting" || status === "rendering";
  const hasAnySelection = selectedSegmentIds.size > 0;
  const allRendered = segments.every((s) => cachedRenderMap.has(s.id));
  const someRendered = segments.some((s) => cachedRenderMap.has(s.id));
  const unrenderedCount = segments.filter(
    (s) => !cachedRenderMap.has(s.id),
  ).length;

  // Build segment list
  const segmentList = useMemo(() => {
    if (isProcessing && segmentDownloads.length > 0) {
      return segments.map((seg) => {
        const download = segmentDownloads.find((d) => d.segmentId === seg.id);
        const cached = cachedRenderMap.get(seg.id);
        if (download) {
          return {
            segmentId: seg.id,
            title: seg.title,
            status: download.status,
            downloadUrl: download.downloadUrl,
            isSelected: selectedSegmentIds.has(seg.id),
            isBeingRendered: true,
          };
        } else if (cached) {
          return {
            segmentId: seg.id,
            title: seg.title,
            status: "completed" as const,
            downloadUrl: cached,
            isSelected: false,
            isBeingRendered: false,
          };
        } else {
          return {
            segmentId: seg.id,
            title: seg.title,
            status: "pending" as const,
            downloadUrl: undefined,
            isSelected: selectedSegmentIds.has(seg.id),
            isBeingRendered: false,
          };
        }
      });
    }

    return segments.map((seg) => {
      const cached = cachedRenderMap.get(seg.id);
      return {
        segmentId: seg.id,
        title: seg.title,
        status: cached ? ("completed" as const) : ("pending" as const),
        downloadUrl: cached,
        isSelected: selectedSegmentIds.has(seg.id),
        isBeingRendered: false,
      };
    });
  }, [
    segments,
    segmentDownloads,
    cachedRenderMap,
    selectedSegmentIds,
    isProcessing,
  ]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-xl max-h-[80vh] flex flex-col bg-zinc-900 border-zinc-700">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-zinc-100">
            <Film className="h-5 w-5 text-blue-500" />
            Export Segments
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-hidden flex flex-col gap-3 min-h-0">
          {/* Progress */}
          {isProcessing && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-zinc-400">
                  {status === "starting"
                    ? "Preparing..."
                    : `Rendering ${completedCount}/${selectedSegmentIds.size}`}
                </span>
                <span className="text-zinc-100 font-mono">{progress}%</span>
              </div>
              <Progress value={progress} className="h-1.5 bg-zinc-800" />
            </div>
          )}

          {/* Error */}
          {status === "failed" && (
            <div className="p-3 bg-red-950 border border-red-800 rounded-lg">
              <div className="flex items-center gap-2 text-red-400">
                <XCircle className="h-4 w-4" />
                <span className="text-sm font-medium">Export failed</span>
              </div>
              {error && <p className="text-xs text-red-400/70 mt-1">{error}</p>}
            </div>
          )}

          {/* Selection controls */}
          {status === "idle" && (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={selectAll}
                  className="h-7 px-2.5 text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
                >
                  All
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={selectNone}
                  className="h-7 px-2.5 text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
                >
                  None
                </Button>
                {someRendered && unrenderedCount > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={selectUnrendered}
                    className="h-7 px-2.5 text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
                  >
                    Unrendered ({unrenderedCount})
                  </Button>
                )}
              </div>
              <span className="text-xs text-zinc-500 font-mono">
                {selectedSegmentIds.size}/{segments.length}
              </span>
            </div>
          )}

          {/* Status badge */}
          {status === "idle" && someRendered && (
            <div className="flex items-center gap-2 text-emerald-500 text-sm">
              <CheckCircle2 className="h-4 w-4" />
              <span>
                {allRendered
                  ? "All segments rendered"
                  : `${cachedRenderMap.size} of ${segments.length} rendered`}
              </span>
            </div>
          )}

          {/* Segment list */}
          <div className="flex-1 overflow-y-auto min-h-0 space-y-1 pr-1">
            {segmentList.map((item) => {
              const isCompleted = item.status === "completed";
              const isFailed = item.status === "failed";
              const isRendering = item.status === "rendering";
              const canSelect = status === "idle";

              return (
                <div
                  key={item.segmentId}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all",
                    isCompleted &&
                      "bg-emerald-950/50 border border-emerald-800/50",
                    isFailed && "bg-red-950/50 border border-red-800/50",
                    isRendering && "bg-blue-950/50 border border-blue-800/50",
                    !isCompleted &&
                      !isFailed &&
                      !isRendering &&
                      "bg-zinc-800/50 border border-zinc-700/50",
                    canSelect && "cursor-pointer hover:border-zinc-600",
                    canSelect &&
                      item.isSelected &&
                      "border-blue-600 bg-blue-950/30",
                  )}
                  onClick={
                    canSelect ? () => toggleSegment(item.segmentId) : undefined
                  }
                >
                  {/* Checkbox or status icon */}
                  {canSelect ? (
                    <Checkbox
                      checked={item.isSelected}
                      onCheckedChange={() => toggleSegment(item.segmentId)}
                      onClick={(e) => e.stopPropagation()}
                      className="border-zinc-600 data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
                    />
                  ) : isRendering ? (
                    <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                  ) : isCompleted ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  ) : isFailed ? (
                    <XCircle className="h-4 w-4 text-red-500" />
                  ) : (
                    <div className="h-4 w-4 rounded-full border-2 border-zinc-600" />
                  )}

                  {/* Title */}
                  <span
                    className={cn(
                      "flex-1 truncate",
                      isCompleted ? "text-zinc-200" : "text-zinc-300",
                    )}
                  >
                    {item.title}
                  </span>

                  {/* Download or status */}
                  {isCompleted && item.downloadUrl ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-emerald-500 hover:text-emerald-400 hover:bg-emerald-950"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDownload(item.downloadUrl!, item.title);
                      }}
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                  ) : isRendering ? (
                    <span className="text-xs text-blue-400">Rendering...</span>
                  ) : isFailed ? (
                    <span className="text-xs text-red-400">Failed</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-between items-center pt-3 border-t border-zinc-800">
          <span className="text-xs text-zinc-500">
            {isProcessing
              ? "Rendering..."
              : hasAnySelection
                ? `${selectedSegmentIds.size} selected`
                : "Select segments to render"}
          </span>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              onClick={handleClose}
              className="text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
            >
              {status === "completed" || someRendered ? "Done" : "Cancel"}
            </Button>
            {status === "idle" && (
              <Button
                onClick={handleStartRender}
                disabled={!hasAnySelection}
                className="bg-blue-600 hover:bg-blue-500 text-white disabled:bg-zinc-700 disabled:text-zinc-500"
              >
                {someRendered && hasAnySelection ? (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Re-render
                  </>
                ) : (
                  "Export"
                )}
              </Button>
            )}
            {status === "failed" && (
              <Button
                onClick={handleStartRender}
                disabled={!hasAnySelection}
                className="bg-blue-600 hover:bg-blue-500 text-white"
              >
                Retry
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
