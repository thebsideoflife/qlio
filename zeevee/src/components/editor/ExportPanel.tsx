import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useSelector, useDispatch } from "react-redux";
import type { RootState } from "@/store/store";
import {
  setLastSegmentRenders,
  setSegmentMetadata,
  setProjectThumbnailUrl,
} from "@/store/editorSlice";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  startRender,
  getRenderStatus,
  getProjectJobStatus,
  generateExportMetadata,
  pollExportMetadataStatus,
  type GenerateExportMetadataResponse,
  type SegmentDownload,
} from "@/services/api";
import {
  Download,
  Loader2,
  CheckCircle2,
  XCircle,
  Save,
  RefreshCw,
} from "lucide-react";
import { cn, formatSegmentLabel } from "@/lib/utils";
import {
  computeSegmentRenderFingerprint,
  isSegmentRenderStale,
  type SegmentRenderCache,
} from "@/lib/segmentRenderFingerprint";
import {
  isSegmentMetadataStale,
  filterIabTagsForFields,
  type SegmentMetadataCache,
} from "@/lib/segmentMetadataFingerprint";
import {
  IAB_FORM_FACTOR_IDS,
  IAB_GENRE_IDS,
} from "@/lib/iabContentTaxonomy";
import {
  buildExportMetadataDocument,
  downloadExportMetadataJson,
  normalizeContentAdvisory,
} from "@/lib/exportMetadataJson";

interface ExportPanelProps {
  projectId: string;
  onDone?: () => void;
}

type RenderStatus = "idle" | "starting" | "rendering" | "completed" | "failed";
type VideoFormat = "mp4-h264" | "mp4-h265" | "mov" | "webm";
type DescriptionLength = "short" | "two_sentences" | "paragraph";

const DESCRIPTION_LENGTH_OPTIONS: {
  value: DescriptionLength;
  label: string;
}[] = [
  { value: "short", label: "Short" },
  { value: "two_sentences", label: "Two Sentences" },
  { value: "paragraph", label: "Paragraph" },
];

function formatSceneDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function ExportPanel({ projectId, onDone }: ExportPanelProps) {
  const dispatch = useDispatch();
  const segments = useSelector((state: RootState) => state.editor.segments);
  const captionSettings = useSelector(
    (state: RootState) => state.editor.captionSettings,
  );
  const globalFraming = useSelector(
    (state: RootState) => state.editor.globalFraming,
  );
  const lastSegmentRenders = useSelector(
    (state: RootState) => state.editor.lastSegmentRenders,
  );
  const segmentMetadata = useSelector(
    (state: RootState) => state.editor.segmentMetadata,
  );
  const projectTitle = useSelector(
    (state: RootState) => state.editor.projectTitle,
  );
  const projectThumbnailUrl = useSelector(
    (state: RootState) => state.editor.projectThumbnailUrl,
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
    () => new Set(),
  );
  const [renderingSegmentCount, setRenderingSegmentCount] = useState(0);

  const [metadataLoading, setMetadataLoading] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [metadataSegmentErrors, setMetadataSegmentErrors] = useState<
    Map<string, string>
  >(() => new Map());
  const [metadataSegmentWarnings, setMetadataSegmentWarnings] = useState<
    Map<string, string>
  >(() => new Map());
  const metadataInFlightRef = useRef(false);
  const [metadataResumeChecked, setMetadataResumeChecked] = useState(false);
  const segmentMetadataRef = useRef(segmentMetadata);
  segmentMetadataRef.current = segmentMetadata;
  const lastMetadataDownloadJobRef = useRef<string | null>(null);

  const [metadataEnabled, setMetadataEnabled] = useState(true);
  const [includeTitles, setIncludeTitles] = useState(true);
  const [includeDescriptions, setIncludeDescriptions] = useState(true);
  const [descriptionLengths, setDescriptionLengths] = useState<
    Set<DescriptionLength>
  >(() => new Set(["short"]));
  const [includeThumbnails, setIncludeThumbnails] = useState(true);
  const [descriptiveTab, setDescriptiveTab] = useState(true);
  const [contentAdvisory, setContentAdvisory] = useState(true);
  const [mood, setMood] = useState(true);
  const [theme, setTheme] = useState(true);
  const [tone, setTone] = useState(true);

  const [videoFormat, setVideoFormat] = useState<VideoFormat>("mp4-h264");

  const [adsEnabled, setAdsEnabled] = useState(true);
  const [adLoad, setAdLoad] = useState(8);
  const [adPre, setAdPre] = useState(true);
  const [adMid, setAdMid] = useState(false);
  const [adPost, setAdPost] = useState(false);
  const [includeIab, setIncludeIab] = useState(true);
  const [iabFormFactor, setIabFormFactor] = useState(true);
  const [iabGenres, setIabGenres] = useState(true);

  const cachedRenderMap = useMemo(() => {
    const map = new Map<string, SegmentRenderCache>();
    if (lastSegmentRenders) {
      for (const render of lastSegmentRenders) {
        map.set(render.segmentId, render);
      }
    }
    return map;
  }, [lastSegmentRenders]);

  const cachedMetadataMap = useMemo(() => {
    const map = new Map<string, SegmentMetadataCache>();
    if (segmentMetadata) {
      for (const meta of segmentMetadata) {
        map.set(meta.segmentId, meta);
      }
    }
    return map;
  }, [segmentMetadata]);

  const metadataOptions = useMemo(
    () => ({
      includeTitles,
      includeDescriptions,
      descriptionLengths: Array.from(descriptionLengths),
      descriptiveTags: descriptiveTab
        ? {
            contentAdvisory,
            mood,
            theme,
            tone,
          }
        : undefined,
      includeIab,
      iabFields: includeIab
        ? {
            formFactor: iabFormFactor,
            genres: iabGenres,
          }
        : undefined,
      includeThumbnails,
    }),
    [
      includeTitles,
      includeDescriptions,
      descriptionLengths,
      descriptiveTab,
      contentAdvisory,
      mood,
      theme,
      tone,
      includeIab,
      iabFormFactor,
      iabGenres,
      includeThumbnails,
    ],
  );

  const staleMetadataSegmentIds = useMemo(() => {
    if (!metadataEnabled) return [];
    return segments
      .filter((seg) => selectedSegmentIds.has(seg.id))
      .filter((seg) => {
        return isSegmentMetadataStale(
          cachedMetadataMap.get(seg.id),
          seg.startTime,
          seg.endTime,
          metadataOptions,
        );
      })
      .map((s) => s.id);
  }, [
    segments,
    selectedSegmentIds,
    cachedMetadataMap,
    metadataEnabled,
    metadataOptions,
  ]);

  const staleMetadataKey = staleMetadataSegmentIds.join(",");

  const applyMetadataResult = useCallback(
    (result: GenerateExportMetadataResponse) => {
      const merged = new Map(
        (segmentMetadataRef.current || []).map((m) => [m.segmentId, m]),
      );
      for (const seg of result.segments) {
        merged.set(seg.segmentId, seg);
      }
      dispatch(setSegmentMetadata(Array.from(merged.values())));

      if (result.projectThumbnailUrl) {
        dispatch(setProjectThumbnailUrl(result.projectThumbnailUrl));
      }

      if (result.errors?.length) {
        setMetadataSegmentErrors(
          new Map(result.errors.map((e) => [e.segmentId, e.error])),
        );
        setMetadataError(
          `${result.errors.length} scene(s) failed metadata generation.`,
        );
      } else {
        setMetadataSegmentErrors(new Map());
        setMetadataError(null);
      }

      if (result.warnings?.length) {
        setMetadataSegmentWarnings(
          new Map(result.warnings.map((w) => [w.segmentId, w.message])),
        );
      } else {
        setMetadataSegmentWarnings(new Map());
      }
    },
    [dispatch],
  );

  const buildMetadataDocument = useCallback(() => {
    const metaMap = new Map<string, SegmentMetadataCache>();
    for (const m of segmentMetadataRef.current || []) {
      metaMap.set(m.segmentId, m);
    }
    return buildExportMetadataDocument({
      projectId,
      projectTitle: projectTitle || "Untitled",
      projectThumbnailUrl,
      segments,
      selectedSegmentIds,
      metadataBySegmentId: metaMap,
      options: metadataOptions,
    });
  }, [
    projectId,
    projectTitle,
    projectThumbnailUrl,
    segments,
    selectedSegmentIds,
    metadataOptions,
  ]);

  const handleDownloadMetadataJson = useCallback(() => {
    downloadExportMetadataJson(buildMetadataDocument());
  }, [buildMetadataDocument]);

  const runMetadataGeneration = useCallback(
    async (segmentIds: string[]) => {
      if (segmentIds.length === 0 || metadataInFlightRef.current) return;

      metadataInFlightRef.current = true;
      setMetadataLoading(true);
      setMetadataError(null);

      try {
        const result = await generateExportMetadata(projectId, {
          segmentIds,
          options: metadataOptions,
        });
        applyMetadataResult(result);
      } catch (err: unknown) {
        const apiError = err as { response?: { data?: { error?: string } } };
        setMetadataError(
          apiError.response?.data?.error || "Failed to generate metadata",
        );
      } finally {
        metadataInFlightRef.current = false;
        setMetadataLoading(false);
      }
    },
    [projectId, metadataOptions, applyMetadataResult],
  );

  const isProcessing = status === "starting" || status === "rendering";
  const hasAnySelection = selectedSegmentIds.size > 0;
  const someRendered = segments.some((s) => {
    const cached = cachedRenderMap.get(s.id);
    if (!cached?.url) return false;
    const hash = computeSegmentRenderFingerprint(
      s,
      captionSettings,
      globalFraming,
    );
    return !isSegmentRenderStale(cached, hash);
  });

  // Initialize selection when project changes (not on segment updates)
  useEffect(() => {
    setSelectedSegmentIds(new Set(segments.map((s) => s.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Resume active render + export-metadata jobs on mount
  useEffect(() => {
    let cancelled = false;
    setMetadataResumeChecked(false);

    (async () => {
      try {
        const jobStatus = await getProjectJobStatus(projectId);
        if (cancelled) return;

        if (jobStatus.activeRenderJobId) {
          setJobId(jobStatus.activeRenderJobId);
          setStatus("rendering");
        }

        const metaJob = jobStatus.exportMetadataJob;
        if (
          metaJob &&
          (metaJob.status === "pending" || metaJob.status === "generating")
        ) {
          metadataInFlightRef.current = true;
          setMetadataLoading(true);
          try {
            const result = await pollExportMetadataStatus(projectId);
            if (!cancelled) applyMetadataResult(result);
          } catch (err: unknown) {
            if (!cancelled) {
              const apiError = err as {
                response?: { data?: { error?: string } };
              };
              setMetadataError(
                apiError.response?.data?.error ||
                  "Failed to resume metadata generation",
              );
            }
          } finally {
            if (!cancelled) {
              metadataInFlightRef.current = false;
              setMetadataLoading(false);
            }
          }
        }
      } catch {
        // Non-fatal
      } finally {
        if (!cancelled) setMetadataResumeChecked(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, applyMetadataResult]);

  // Auto-generate stale metadata when the panel opens or options/selection change
  // Skip auto-retry if there's an active error (user can manually retry)
  useEffect(() => {
    if (!metadataResumeChecked || !metadataEnabled) return;
    if (staleMetadataSegmentIds.length === 0) return;
    if (metadataInFlightRef.current || metadataLoading) return;
    if (metadataError) return; // Don't auto-retry on error — avoid API hammering
    runMetadataGeneration(staleMetadataSegmentIds);
  }, [
    metadataResumeChecked,
    metadataEnabled,
    staleMetadataKey,
    metadataLoading,
    metadataError,
    runMetadataGeneration,
    staleMetadataSegmentIds,
  ]);

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
              .map((s) => {
                const segment = segments.find((seg) => seg.id === s.segmentId);
                return {
                  segmentId: s.segmentId,
                  title: s.title,
                  url: s.downloadUrl!,
                  contentHash: segment
                    ? computeSegmentRenderFingerprint(
                        segment,
                        captionSettings,
                        globalFraming,
                      )
                    : undefined,
                };
              });

            const mergedMap = new Map(
              (lastSegmentRenders || []).map((r) => [r.segmentId, r]),
            );
            for (const render of newRenders) {
              mergedMap.set(render.segmentId, render);
            }

            dispatch(setLastSegmentRenders(Array.from(mergedMap.values())));
          }

          if (
            metadataEnabled &&
            jobId &&
            lastMetadataDownloadJobRef.current !== jobId
          ) {
            lastMetadataDownloadJobRef.current = jobId;
            downloadExportMetadataJson(buildMetadataDocument());
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
  }, [
    jobId,
    status,
    dispatch,
    lastSegmentRenders,
    segments,
    captionSettings,
    globalFraming,
    metadataEnabled,
    buildMetadataDocument,
  ]);

  const handleStartRender = useCallback(async () => {
    if (isProcessing) return; // Prevent concurrent renders

    setStatus("starting");
    setProgress(0);
    setError(null);
    setSegmentDownloads([]);
    setCompletedCount(0);
    setRenderingSegmentCount(selectedSegmentIds.size);

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
      const apiError = err as { response?: { data?: { error?: string } } };
      setError(apiError.response?.data?.error || "Failed to start render");
    }
  }, [projectId, selectedSegmentIds, isProcessing]);

  const handleRerenderSegment = useCallback(
    async (segmentId: string) => {
      if (isProcessing) return; // Prevent concurrent renders

      setStatus("starting");
      setProgress(0);
      setError(null);
      setSegmentDownloads([]);
      setCompletedCount(0);
      setRenderingSegmentCount(1);

      try {
        const result = await startRender(projectId, {
          outputFormat: "mp4",
          quality: "standard",
          segmentIds: [segmentId],
        });
        setJobId(result.jobId);
        setStatus("rendering");
      } catch (err: unknown) {
        setStatus("failed");
        const apiError = err as { response?: { data?: { error?: string } } };
        setError(apiError.response?.data?.error || "Failed to start render");
      }
    },
    [projectId, isProcessing],
  );

  const handleDownload = useCallback((url: string, title: string) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title}.mp4`;
    a.target = "_blank";
    a.click();
  }, []);

  const handleDone = useCallback(() => {
    setStatus("idle");
    setProgress(0);
    setJobId(null);
    setSegmentDownloads([]);
    setCompletedCount(0);
    setError(null);
    onDone?.();
  }, [onDone]);

  const toggleSegment = useCallback(
    (segmentId: string) => {
      if (isProcessing) return;
      setSelectedSegmentIds((prev) => {
        const next = new Set(prev);
        if (next.has(segmentId)) {
          next.delete(segmentId);
        } else {
          next.add(segmentId);
        }
        return next;
      });
    },
    [isProcessing],
  );

  const selectAll = useCallback(() => {
    setSelectedSegmentIds(new Set(segments.map((s) => s.id)));
  }, [segments]);

  const selectNone = useCallback(() => {
    setSelectedSegmentIds(new Set());
  }, []);

  const toggleDescriptionLength = useCallback((length: DescriptionLength) => {
    setDescriptionLengths((prev) => {
      const next = new Set(prev);
      if (next.has(length)) {
        if (next.size > 1) next.delete(length);
      } else {
        next.add(length);
      }
      return next;
    });
  }, []);

  const segmentRows = useMemo(() => {
    return segments.map((seg, index) => {
      const download = segmentDownloads.find((d) => d.segmentId === seg.id);
      const cached = cachedRenderMap.get(seg.id);
      const isSelected = selectedSegmentIds.has(seg.id);
      const contentHash = computeSegmentRenderFingerprint(
        seg,
        captionSettings,
        globalFraming,
      );
      const isStale = isSegmentRenderStale(cached, contentHash);

      let renderStatus: "pending" | "rendering" | "completed" | "failed" =
        "pending";
      let downloadUrl: string | undefined;

      if (isProcessing && download) {
        renderStatus = download.status as typeof renderStatus;
        downloadUrl = download.downloadUrl;
      } else if (cached?.url && !isStale) {
        renderStatus = "completed";
        downloadUrl = cached.url;
      } else if (cached?.url && isStale) {
        renderStatus = "completed";
      }

      const durationSec = Math.max(0, seg.endTime - seg.startTime);

      return {
        id: seg.id,
        label: seg.title,
        index: index + 1,
        description: seg.description,
        duration: formatSceneDuration(durationSec),
        isSelected,
        renderStatus,
        downloadUrl,
        isStale,
        showRerender: isStale && !isProcessing,
        showDownload: !!downloadUrl && !isStale && renderStatus === "completed",
      };
    });
  }, [
    segments,
    segmentDownloads,
    cachedRenderMap,
    selectedSegmentIds,
    isProcessing,
    captionSettings,
    globalFraming,
  ]);

  const metadataDisabled = !metadataEnabled || isProcessing;
  const descriptiveChildrenDisabled = !descriptiveTab || metadataDisabled;
  const iabChildrenDisabled = !includeIab || metadataDisabled;

  const selectedMetadataRows = useMemo(() => {
    return segments
      .map((seg, index) => ({ segment: seg, index: index + 1 }))
      .filter(({ segment }) => selectedSegmentIds.has(segment.id))
      .map(({ segment, index }) => {
        const meta = cachedMetadataMap.get(segment.id);
        const stale = isSegmentMetadataStale(
          meta,
          segment.startTime,
          segment.endTime,
          metadataOptions,
        );
        return { segment, meta, index, stale };
      });
  }, [segments, selectedSegmentIds, cachedMetadataMap, metadataOptions]);

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4 sm:gap-5">
      <header className="shrink-0">
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Export</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Choose scenes and export settings, then render your microseries.
        </p>
      </header>

      {(isProcessing || status === "failed") && (
        <div className="shrink-0 space-y-2 rounded-lg border border-border bg-card px-4 py-3">
          {isProcessing && (
            <>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {status === "starting"
                    ? "Preparing export…"
                    : `Rendering ${completedCount} of ${renderingSegmentCount} scenes`}
                </span>
                <span className="font-mono text-xs tabular-nums">
                  {progress}%
                </span>
              </div>
              <Progress value={progress} className="h-1.5" />
            </>
          )}
          {status === "failed" && (
            <div className="flex items-start gap-2 text-sm text-destructive">
              <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">Export failed</p>
                {error && (
                  <p className="text-xs text-destructive/80 mt-0.5">{error}</p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col flex-1 min-h-0 rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain lg:overflow-hidden">
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,1.75fr)_minmax(0,1fr)] lg:h-full lg:min-h-0 divide-y lg:divide-y-0 lg:divide-x divide-border">
            {/* Scenes */}
            <ExportColumn className="lg:min-w-0">
              <ColumnHeader
                title="Scenes"
                trailing={
                  <div className="flex items-center gap-3">
                    {!isProcessing && (
                      <div className="flex items-center gap-1.5 text-xs">
                        <button
                          type="button"
                          onClick={selectAll}
                          className="text-muted-foreground hover:text-foreground transition-colors"
                        >
                          All
                        </button>
                        <span className="text-muted-foreground/40">/</span>
                        <button
                          type="button"
                          onClick={selectNone}
                          className="text-muted-foreground hover:text-foreground transition-colors"
                        >
                          None
                        </button>
                      </div>
                    )}
                    <span className="text-xs font-medium tabular-nums text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                      {selectedSegmentIds.size}/{segments.length}
                    </span>
                  </div>
                }
              />
              <ScrollArea className="lg:flex-1 lg:min-h-0 max-h-[min(50dvh,22rem)] lg:max-h-none">
                <div className="p-2">
                  {segmentRows.map((row) => {
                    const canSelect = !isProcessing;
                    const isRendering =
                      isProcessing &&
                      segmentDownloads.some(
                        (d) =>
                          d.segmentId === row.id && d.status === "rendering",
                      );

                    return (
                      <div
                        key={row.id}
                        className={cn(
                          "group relative flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors",
                          canSelect && "cursor-pointer",
                          row.isSelected
                            ? "bg-primary/10"
                            : "hover:bg-muted/50",
                        )}
                        role={canSelect ? "button" : undefined}
                        tabIndex={canSelect ? 0 : undefined}
                        onClick={
                          canSelect ? () => toggleSegment(row.id) : undefined
                        }
                        onKeyDown={
                          canSelect
                            ? (e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  toggleSegment(row.id);
                                }
                              }
                            : undefined
                        }
                      >
                        <div className="shrink-0">
                          {isProcessing ? (
                            <SceneStatusIcon status={row.renderStatus} />
                          ) : (
                            <Checkbox
                              checked={row.isSelected}
                              onCheckedChange={() => toggleSegment(row.id)}
                              onClick={(e) => e.stopPropagation()}
                            />
                          )}
                        </div>

                        <div className="min-w-0 flex-1">
                          <span className="text-sm font-medium leading-snug line-clamp-2">
                            {formatSegmentLabel(row.index, row.label)}
                          </span>
                        </div>

                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground self-center">
                          {row.duration}
                        </span>

                        {row.showDownload && (
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="shrink-0 h-8 w-8 text-muted-foreground hover:text-foreground"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDownload(
                                row.downloadUrl!,
                                formatSegmentLabel(row.index, row.label),
                              );
                            }}
                            aria-label={`Download ${row.label}`}
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                        )}

                        {row.showRerender && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="shrink-0 h-8 gap-1.5 px-2 text-xs text-primary hover:text-primary"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRerenderSegment(row.id);
                            }}
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                            Re-render
                          </Button>
                        )}

                        {isRendering && (
                          <div className="shrink-0 h-8 w-8 flex items-center justify-center">
                            <Loader2 className="h-4 w-4 animate-spin text-primary" />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            </ExportColumn>

            {/* Metadata */}
            <ExportColumn className="lg:min-h-0 lg:flex-1">
              <ColumnHeader
                title="Metadata"
                trailing={
                  <div className="flex items-center gap-2">
                    {metadataEnabled && metadataLoading && (
                      <span className="text-[10px] text-muted-foreground hidden sm:inline">
                        Generating…
                      </span>
                    )}
                    {metadataEnabled &&
                      !metadataLoading &&
                      staleMetadataSegmentIds.length > 0 && (
                        <span className="text-[10px] text-amber-600 dark:text-amber-500 hidden sm:inline">
                          Updating {staleMetadataSegmentIds.length}…
                        </span>
                      )}
                    {metadataLoading && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    )}
                    <Switch
                      checked={metadataEnabled}
                      onCheckedChange={setMetadataEnabled}
                      disabled={isProcessing}
                      aria-label="Include metadata"
                    />
                  </div>
                }
              />

              {!metadataEnabled ? (
                <div className="flex flex-1 items-center justify-center px-6 py-12 text-center">
                  <p className="text-sm text-muted-foreground">
                    Metadata export is off. Toggle on to generate titles,
                    descriptions, and thumbnails.
                  </p>
                </div>
              ) : selectedMetadataRows.length === 0 ? (
                <div className="flex flex-1 items-center justify-center px-6 py-12 text-center">
                  <p className="text-sm text-muted-foreground">
                    Select scenes to preview their metadata.
                  </p>
                </div>
              ) : (
                <div
                  className={cn(
                    "flex flex-col min-h-0 flex-1",
                    metadataDisabled && "opacity-50 pointer-events-none",
                  )}
                >
                  {metadataError && (
                    <div className="shrink-0 px-4 py-2 border-b border-border bg-destructive/5 flex items-center justify-between gap-2">
                      <p className="text-xs text-destructive">
                        {metadataError}
                      </p>
                      {staleMetadataSegmentIds.length > 0 && !metadataLoading && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-xs text-destructive hover:text-destructive"
                          onClick={() => {
                            setMetadataError(null);
                            runMetadataGeneration(staleMetadataSegmentIds);
                          }}
                        >
                          <RefreshCw className="h-3 w-3 mr-1" />
                          Retry
                        </Button>
                      )}
                    </div>
                  )}
                  <ScrollArea className="flex-1 min-h-0 max-h-[min(55dvh,28rem)] lg:max-h-none">
                    <div className="p-3 space-y-3">
                      {selectedMetadataRows.map(
                        ({ segment, meta, index, stale }) => (
                          <MetadataSceneCard
                            key={segment.id}
                            index={index}
                            segmentTitle={segment.title}
                            meta={meta}
                            stale={stale}
                            loading={metadataLoading}
                            includeTitles={includeTitles}
                            includeDescriptions={includeDescriptions}
                            includeThumbnails={includeThumbnails}
                            descriptionLengths={descriptionLengths}
                            descriptiveTab={descriptiveTab}
                            contentAdvisory={contentAdvisory}
                            mood={mood}
                            theme={theme}
                            tone={tone}
                            includeIab={includeIab}
                            iabFormFactor={iabFormFactor}
                            iabGenres={iabGenres}
                            error={metadataSegmentErrors.get(segment.id)}
                            warning={metadataSegmentWarnings.get(segment.id)}
                          />
                        ),
                      )}
                    </div>
                  </ScrollArea>
                </div>
              )}
            </ExportColumn>

            {/* Configuration */}
            <ExportColumn>
              <ColumnHeader title="Configuration" />
              <div className="px-4 py-4 space-y-6 lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
                <ConfigSection title="Metadata">
                  <div
                    className={cn(
                      "space-y-4",
                      metadataDisabled && "opacity-50 pointer-events-none",
                    )}
                  >
                    <OptionRow
                      id="meta-titles"
                      label="Titles"
                      checked={includeTitles}
                      onCheckedChange={setIncludeTitles}
                      disabled={metadataDisabled}
                    />
                    <div className="space-y-2">
                      <OptionRow
                        id="meta-descriptions"
                        label="Descriptions"
                        checked={includeDescriptions}
                        onCheckedChange={setIncludeDescriptions}
                        disabled={metadataDisabled}
                      />
                      <NestedGroup
                        disabled={!includeDescriptions || metadataDisabled}
                      >
                        <div className="space-y-2.5">
                          {DESCRIPTION_LENGTH_OPTIONS.map((opt) => (
                            <OptionRow
                              key={opt.value}
                              id={`desc-${opt.value}`}
                              label={opt.label}
                              checked={descriptionLengths.has(opt.value)}
                              onCheckedChange={() =>
                                toggleDescriptionLength(opt.value)
                              }
                              disabled={
                                !includeDescriptions || metadataDisabled
                              }
                            />
                          ))}
                        </div>
                      </NestedGroup>
                    </div>
                    <OptionRow
                      id="meta-thumbnails"
                      label="Thumbnails"
                      checked={includeThumbnails}
                      onCheckedChange={setIncludeThumbnails}
                      disabled={metadataDisabled}
                    />
                    <div className="space-y-2">
                      <OptionRow
                        id="meta-iab"
                        label="IAB"
                        checked={includeIab}
                        onCheckedChange={setIncludeIab}
                        disabled={metadataDisabled}
                      />
                      <NestedGroup disabled={iabChildrenDisabled}>
                        <OptionRow
                          id="meta-iab-form-factor"
                          label="Form Factor"
                          checked={iabFormFactor}
                          onCheckedChange={setIabFormFactor}
                          disabled={iabChildrenDisabled}
                        />
                        <OptionRow
                          id="meta-iab-genres"
                          label="Genres"
                          checked={iabGenres}
                          onCheckedChange={setIabGenres}
                          disabled={iabChildrenDisabled}
                        />
                      </NestedGroup>
                    </div>
                    <div className="space-y-2">
                      <OptionRow
                        id="meta-descriptive"
                        label="Descriptive Tags"
                        checked={descriptiveTab}
                        onCheckedChange={setDescriptiveTab}
                        disabled={metadataDisabled}
                      />
                      <NestedGroup disabled={descriptiveChildrenDisabled}>
                        <OptionRow
                          id="meta-advisory"
                          label="Content Advisory"
                          checked={contentAdvisory}
                          onCheckedChange={setContentAdvisory}
                          disabled={descriptiveChildrenDisabled}
                        />
                        <OptionRow
                          id="meta-mood"
                          label="Mood"
                          checked={mood}
                          onCheckedChange={setMood}
                          disabled={descriptiveChildrenDisabled}
                        />
                        <OptionRow
                          id="meta-theme"
                          label="Theme"
                          checked={theme}
                          onCheckedChange={setTheme}
                          disabled={descriptiveChildrenDisabled}
                        />
                        <OptionRow
                          id="meta-tone"
                          label="Tone"
                          checked={tone}
                          onCheckedChange={setTone}
                          disabled={descriptiveChildrenDisabled}
                        />
                      </NestedGroup>
                    </div>
                  </div>
                </ConfigSection>

                <Separator />

                <ConfigSection
                  title="Ads"
                  trailing={
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                        Coming soon
                      </span>
                      <Switch
                        checked={adsEnabled}
                        onCheckedChange={setAdsEnabled}
                        disabled={isProcessing}
                        aria-label="Enable ads"
                      />
                    </div>
                  }
                >
                  <div
                    className={cn(
                      "space-y-4",
                      (!adsEnabled || isProcessing) &&
                        "opacity-50 pointer-events-none",
                    )}
                  >
                    <div>
                      <Label className="text-xs text-muted-foreground">
                        Ad Load
                      </Label>
                      <input
                        type="range"
                        min={1}
                        max={15}
                        value={adLoad}
                        onChange={(e) => setAdLoad(Number(e.target.value))}
                        className="mt-2 w-full h-1.5 accent-primary cursor-pointer"
                        disabled={!adsEnabled || isProcessing}
                      />
                      <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
                        <span>1</span>
                        <span className="font-medium text-foreground tabular-nums">
                          {adLoad}
                        </span>
                        <span>15</span>
                      </div>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground mb-2 block">
                        Placement
                      </Label>
                      <div className="flex flex-wrap gap-x-4 gap-y-2">
                        <OptionRow
                          id="ad-pre"
                          label="Pre"
                          checked={adPre}
                          onCheckedChange={setAdPre}
                        />
                        <OptionRow
                          id="ad-mid"
                          label="Mid"
                          checked={adMid}
                          onCheckedChange={setAdMid}
                        />
                        <OptionRow
                          id="ad-post"
                          label="Post"
                          checked={adPost}
                          onCheckedChange={setAdPost}
                        />
                      </div>
                    </div>
                  </div>
                </ConfigSection>

                <Separator />

                <ConfigSection
                  title="Video Format"
                  trailing={
                    <span className="text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      Coming soon
                    </span>
                  }
                >
                  <RadioGroup
                    name="video-format"
                    value={videoFormat}
                    onChange={setVideoFormat}
                    options={[
                      { value: "mp4-h264", label: "MP4 (H.264)" },
                      { value: "mp4-h265", label: "MP4 (H.265)" },
                      { value: "mov", label: ".MOV" },
                      { value: "webm", label: "WebM" },
                    ]}
                    disabled={isProcessing}
                  />
                </ConfigSection>
              </div>
            </ExportColumn>
          </div>
        </div>

        <footer className="shrink-0 flex flex-col gap-3 border-t border-border bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-5 sm:py-4">
          <p className="text-xs text-muted-foreground sm:min-w-0 sm:flex-1">
            {isProcessing
              ? "Export in progress — you can leave and return later."
              : status === "completed"
                ? metadataEnabled
                  ? "Export complete. Scene videos and metadata JSON are ready to download."
                  : "Export complete. Download individual scenes or return to the editor."
                : hasAnySelection
                  ? `${selectedSegmentIds.size} scene${selectedSegmentIds.size === 1 ? "" : "s"} selected`
                  : "Select at least one scene to export"}
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDone}
              className="w-full sm:w-auto"
            >
              {status === "completed" || someRendered ? "Done" : "Cancel"}
            </Button>
            {metadataEnabled &&
              hasAnySelection &&
              (status === "completed" || someRendered) && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDownloadMetadataJson}
                  className="w-full sm:w-auto"
                >
                  <Download className="h-4 w-4 mr-2" />
                  Metadata JSON
                </Button>
              )}
            {(status === "idle" || status === "failed") && (
              <Button
                size="sm"
                onClick={handleStartRender}
                disabled={!hasAnySelection}
                className="w-full sm:w-auto sm:min-w-[120px]"
              >
                <Save className="h-4 w-4 mr-2" />
                {status === "failed"
                  ? "Retry"
                  : someRendered && hasAnySelection
                    ? "Re-export"
                    : "Export"}
              </Button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

function MetadataSceneCard({
  index,
  segmentTitle,
  meta,
  stale,
  loading,
  includeTitles,
  includeDescriptions,
  includeThumbnails,
  descriptionLengths,
  descriptiveTab,
  contentAdvisory,
  mood,
  theme,
  tone,
  includeIab,
  iabFormFactor,
  iabGenres,
  error,
  warning,
}: {
  index: number;
  segmentTitle: string;
  meta: SegmentMetadataCache | undefined;
  stale: boolean;
  loading: boolean;
  includeTitles: boolean;
  includeDescriptions: boolean;
  includeThumbnails: boolean;
  descriptionLengths: Set<DescriptionLength>;
  descriptiveTab: boolean;
  contentAdvisory: boolean;
  mood: boolean;
  theme: boolean;
  tone: boolean;
  includeIab: boolean;
  iabFormFactor: boolean;
  iabGenres: boolean;
  error?: string;
  warning?: string;
}) {
  const isGenerating = stale && loading;
  const contentAdvisoryTag = normalizeContentAdvisory(
    meta?.tags?.content_advisory,
  );
  const filteredIab = includeIab
    ? filterIabTagsForFields(meta?.tags?.iab, {
        formFactor: iabFormFactor,
        genres: iabGenres,
      })
    : undefined;

  const iabFormFactors =
    filteredIab?.cat
      ?.map((id, i) => ({
        id,
        label: filteredIab.labels?.[i] ?? id,
      }))
      .filter(({ id }) => IAB_FORM_FACTOR_IDS.has(id)) ?? [];
  const iabGenreTags =
    filteredIab?.cat
      ?.map((id, i) => ({
        id,
        label: filteredIab.labels?.[i] ?? id,
      }))
      .filter(({ id }) => IAB_GENRE_IDS.has(id)) ?? [];

  const hasDescriptiveFields =
    descriptiveTab &&
    !!meta?.tags &&
    ((contentAdvisory && !!contentAdvisoryTag) ||
      (mood && !!meta.tags.mood) ||
      (theme && !!meta.tags.theme) ||
      (tone && !!meta.tags.tone));

  const hasIabFields =
    includeIab &&
    (iabFormFactors.length > 0 || iabGenreTags.length > 0 || isGenerating);

  return (
    <div
      className={cn(
        "rounded-lg border p-3 space-y-2.5",
        stale
          ? "border-amber-500/30 bg-amber-500/[0.03]"
          : "border-border bg-card",
      )}
    >
      <div className="flex gap-3">
        {includeThumbnails && (
          <div className="size-[72px] self-start rounded-md overflow-hidden shrink-0 bg-muted">
            {meta?.thumbnailUrl ? (
              <img
                src={meta.thumbnailUrl}
                alt=""
                className="size-full object-cover"
              />
            ) : (
              <div className="size-full flex items-center justify-center">
                {isGenerating ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : (
                  <span className="text-[10px] text-muted-foreground">
                    No thumbnail
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        <div className="min-w-0 flex-1 space-y-1.5">
          {includeTitles && (
            <p className="text-sm font-semibold leading-snug">
              {formatSegmentLabel(index, segmentTitle)}
            </p>
          )}

          {includeDescriptions && (
            <div className="space-y-1">
              {DESCRIPTION_LENGTH_OPTIONS.filter((opt) =>
                descriptionLengths.has(opt.value),
              ).map((opt) => {
                const text = meta?.descriptions?.[opt.value];
                return (
                  <div key={opt.value}>
                    {descriptionLengths.size > 1 && (
                      <span className="text-[10px] font-medium text-muted-foreground/80 uppercase tracking-wide">
                        {opt.label}
                      </span>
                    )}
                    <p
                      className={cn(
                        "text-xs text-muted-foreground leading-relaxed",
                        descriptionLengths.size > 1 && "mt-0.5",
                        !text && isGenerating && "italic",
                      )}
                    >
                      {text || (isGenerating ? "Generating…" : "—")}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {isGenerating && (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground mt-0.5" />
        )}
      </div>

      {(hasDescriptiveFields || hasIabFields) && (
        <div className="space-y-3 pt-2 border-t border-border/60">
          {hasDescriptiveFields && meta?.tags && (
            <MetadataFieldGroup title="Descriptive">
              {contentAdvisory && contentAdvisoryTag && (
                <MetadataField
                  label="Content Advisory"
                  value={contentAdvisoryTag}
                />
              )}
              {mood && meta.tags.mood && (
                <MetadataField label="Mood" value={meta.tags.mood} />
              )}
              {theme && meta.tags.theme && (
                <MetadataField label="Theme" value={meta.tags.theme} />
              )}
              {tone && meta.tags.tone && (
                <MetadataField label="Tone" value={meta.tags.tone} />
              )}
            </MetadataFieldGroup>
          )}

          {hasIabFields && (
            <MetadataFieldGroup title="IAB">
              {iabFormFactors.length > 0 || iabGenreTags.length > 0 ? (
                <>
                  {iabFormFactor && iabFormFactors.length > 0 && (
                    <MetadataField
                      label="Form Factor"
                      value={iabFormFactors.map((f) => f.label).join(", ")}
                    />
                  )}
                  {iabGenres && iabGenreTags.length > 0 && (
                    <MetadataField
                      label="Genres"
                      value={
                        <span className="flex flex-wrap gap-1">
                          {iabGenreTags.map((g) => (
                            <span
                              key={g.id}
                              className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-foreground/90"
                            >
                              {g.label}
                            </span>
                          ))}
                        </span>
                      }
                    />
                  )}
                </>
              ) : (
                <p className="text-[11px] text-muted-foreground italic">
                  Generating…
                </p>
              )}
            </MetadataFieldGroup>
          )}
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
      {warning && (
        <p className="text-xs text-amber-600 dark:text-amber-500">{warning}</p>
      )}
    </div>
  );
}

function MetadataFieldGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        {title}
      </h4>
      <dl className="space-y-1">{children}</dl>
    </div>
  );
}

function MetadataField({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-0.5 items-start">
      <dt className="text-[11px] text-muted-foreground leading-snug pt-px">
        {label}
      </dt>
      <dd className="text-[11px] text-foreground leading-snug min-w-0">
        {value}
      </dd>
    </div>
  );
}

function SceneStatusIcon({
  status,
}: {
  status: "pending" | "rendering" | "completed" | "failed";
}) {
  switch (status) {
    case "rendering":
      return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
    case "completed":
      return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-destructive" />;
    default:
      return (
        <div className="h-4 w-4 rounded border border-border bg-muted/50" />
      );
  }
}

function ExportColumn({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col min-h-0", className)}>{children}</div>
  );
}

function ColumnHeader({
  title,
  trailing,
}: {
  title: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 h-12 border-b border-border bg-muted/30">
      <h2 className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
        {title}
      </h2>
      {trailing}
    </div>
  );
}

function ConfigSection({
  title,
  hint,
  disabled,
  trailing,
  children,
}: {
  title: string;
  hint?: string;
  disabled?: boolean;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={cn(disabled && "opacity-60")}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{title}</h3>
          {hint && (
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {hint}
            </span>
          )}
        </div>
        {trailing}
      </div>
      {children}
    </section>
  );
}

function OptionRow({
  id,
  label,
  checked,
  onCheckedChange,
  disabled,
  hint,
}: {
  id: string;
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        disabled={disabled}
      />
      <Label
        htmlFor={id}
        className={cn(
          "text-sm font-normal cursor-pointer leading-none",
          disabled && "text-muted-foreground cursor-not-allowed",
        )}
      >
        {label}
        {hint && (
          <span className="ml-1.5 text-[10px] text-muted-foreground">
            ({hint})
          </span>
        )}
      </Label>
    </div>
  );
}

function NestedGroup({
  children,
  disabled,
}: {
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div
      className={cn(
        "ml-1 pl-3 border-l-2 border-border space-y-2.5",
        disabled && "opacity-50",
      )}
    >
      {children}
    </div>
  );
}

function RadioGroup<T extends string>({
  name,
  value,
  onChange,
  options,
  disabled,
}: {
  name: string;
  value: T;
  onChange: (value: T) => void;
  options: {
    value: T;
    label: string;
    disabled?: boolean;
    hint?: string;
  }[];
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2.5" role="radiogroup" aria-label={name}>
      {options.map((opt) => {
        const isSelected = value === opt.value;
        const isDisabled = disabled || opt.disabled;
        return (
          <label
            key={opt.value}
            className={cn(
              "flex items-center gap-2.5 cursor-pointer",
              isDisabled && "cursor-not-allowed opacity-50",
            )}
          >
            <input
              type="radio"
              name={name}
              value={opt.value}
              checked={isSelected}
              disabled={isDisabled}
              onChange={() => onChange(opt.value)}
              className="h-4 w-4 accent-primary"
            />
            <span className="text-sm">
              {opt.label}
              {opt.hint && (
                <span className="ml-1.5 text-[10px] text-muted-foreground">
                  ({opt.hint})
                </span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}
