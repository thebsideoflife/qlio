import { useState, useEffect, useCallback, useMemo, type ReactNode } from "react";
import { useSelector, useDispatch } from "react-redux";
import type { RootState } from "@/store/store";
import { setLastSegmentRenders } from "@/store/editorSlice";
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

  // Metadata options (UI state — backend wiring TBD)
  const [metadataEnabled, setMetadataEnabled] = useState(true);
  const [includeTitles, setIncludeTitles] = useState(true);
  const [includeDescriptions, setIncludeDescriptions] = useState(true);
  const [descriptionLengths, setDescriptionLengths] = useState<
    Set<DescriptionLength>
  >(() => new Set(["short", "two_sentences", "paragraph"]));
  const [includeThumbnails, setIncludeThumbnails] = useState(true);
  const [includePosterArt, setIncludePosterArt] = useState(false);
  const [descriptiveTab, setDescriptiveTab] = useState(false);
  const [contentAdvisory, setContentAdvisory] = useState(true);
  const [mood, setMood] = useState(true);
  const [theme, setTheme] = useState(true);
  const [tone, setTone] = useState(true);

  const [videoFormat, setVideoFormat] = useState<VideoFormat>("mp4-h264");

  const [adsEnabled, setAdsEnabled] = useState(true);
  const [adLoad, setAdLoad] = useState(8);
  const [adPre, setAdPre] = useState(true);
  const [adMid, setAdMid] = useState(true);
  const [adPost, setAdPost] = useState(true);
  const [adVast, setAdVast] = useState(true);
  const [adIab, setAdIab] = useState(false);

  const cachedRenderMap = useMemo(() => {
    const map = new Map<string, SegmentRenderCache>();
    if (lastSegmentRenders) {
      for (const render of lastSegmentRenders) {
        map.set(render.segmentId, render);
      }
    }
    return map;
  }, [lastSegmentRenders]);

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

  // Resume active render job on mount
  useEffect(() => {
    (async () => {
      try {
        const jobStatus = await getProjectJobStatus(projectId);
        if (jobStatus.activeRenderJobId) {
          setJobId(jobStatus.activeRenderJobId);
          setStatus("rendering");
        }
      } catch {
        // Non-fatal
      }
    })();
  }, [projectId]);

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

  const toggleSegment = useCallback((segmentId: string) => {
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
  }, [isProcessing]);

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
        showDownload:
          !!downloadUrl && !isStale && renderStatus === "completed",
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
          <div className="grid grid-cols-1 lg:grid-cols-3 lg:h-full lg:min-h-0 divide-y lg:divide-y-0 lg:divide-x divide-border">
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
                      onClick={canSelect ? () => toggleSegment(row.id) : undefined}
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
          <ExportColumn>
            <ColumnHeader
              title="Metadata"
              trailing={
                <Switch
                  checked={metadataEnabled}
                  onCheckedChange={setMetadataEnabled}
                  disabled={isProcessing}
                  aria-label="Include metadata"
                />
              }
            />
            <div
              className={cn(
                "px-4 py-4 space-y-4 lg:flex-1 lg:min-h-0 lg:overflow-y-auto",
                metadataDisabled && "opacity-50 pointer-events-none",
              )}
            >
              <OptionRow
                id="meta-titles"
                label="Titles"
                checked={includeTitles}
                onCheckedChange={setIncludeTitles}
              />
              <div className="space-y-2">
                <OptionRow
                  id="meta-descriptions"
                  label="Descriptions"
                  checked={includeDescriptions}
                  onCheckedChange={setIncludeDescriptions}
                />
                <NestedGroup disabled={!includeDescriptions}>
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
                        disabled={!includeDescriptions}
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
              />
              <OptionRow
                id="meta-poster"
                label="Poster Art"
                checked={includePosterArt}
                onCheckedChange={setIncludePosterArt}
              />
              <Separator className="my-1" />
              <div className="space-y-2">
                <OptionRow
                  id="meta-descriptive"
                  label="Descriptive Tab"
                  checked={descriptiveTab}
                  onCheckedChange={setDescriptiveTab}
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
          </ExportColumn>

          {/* Configuration */}
          <ExportColumn>
            <ColumnHeader title="Configuration" />
            <div className="px-4 py-4 space-y-6 lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
              <ConfigSection
                title="Ads"
                trailing={
                  <Switch
                    checked={adsEnabled}
                    onCheckedChange={setAdsEnabled}
                    disabled={isProcessing}
                    aria-label="Enable ads"
                  />
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
                  <div>
                    <Label className="text-xs text-muted-foreground mb-2 block">
                      Ad Tag Type
                    </Label>
                    <div className="flex gap-4">
                      <OptionRow
                        id="ad-vast"
                        label="VAST"
                        checked={adVast}
                        onCheckedChange={setAdVast}
                      />
                      <OptionRow
                        id="ad-iab"
                        label="IAB"
                        checked={adIab}
                        onCheckedChange={setAdIab}
                      />
                    </div>
                  </div>
                </div>
              </ConfigSection>

              <Separator />

              <ConfigSection title="Video Format">
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
                ? "Export complete. Download individual scenes or return to the editor."
                : hasAnySelection
                  ? `${selectedSegmentIds.size} scene${selectedSegmentIds.size === 1 ? "" : "s"} selected`
                  : "Select at least one scene to export"}
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:shrink-0">
            <Button variant="ghost" size="sm" onClick={handleDone} className="w-full sm:w-auto">
              {status === "completed" || someRendered ? "Done" : "Cancel"}
            </Button>
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

function SceneStatusIcon({
  status,
}: {
  status: "pending" | "rendering" | "completed" | "failed";
}) {
  switch (status) {
    case "rendering":
      return (
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
      );
    case "completed":
      return (
        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
      );
    case "failed":
      return <XCircle className="h-4 w-4 text-destructive" />;
    default:
      return <div className="h-4 w-4 rounded border border-border bg-muted/50" />;
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
    <div
      className={cn("flex flex-col min-h-0", className)}
    >
      {children}
    </div>
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
