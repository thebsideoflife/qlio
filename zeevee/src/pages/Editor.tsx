import React from "react";
import { Timeline } from "@/components/editor/Timeline";
import { MicrodramaGenerator } from "@/components/editor/MicrodramaGenerator";
import { CaptionOverlay } from "@/components/editor/CaptionOverlay";
import { CaptionEditor } from "@/components/editor/CaptionEditor";
import { FramingSlider } from "@/components/editor/FramingSlider";
import { Skeleton } from "@/components/ui/skeleton";
import { useSelector, useDispatch } from "react-redux";
import type { RootState } from "@/store/store";
import {
  selectSegment,
  setCurrentTime,
  setDuration,
  setSegments,
  setProjectId,
  resetEditor,
  updateSegmentFraming,
  setSegmentFraming,
  setGlobalAspectRatio,
} from "@/store/editorSlice";
import { useParams } from "react-router-dom";
import { useRef, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useProjectData } from "@/hooks/useProjectData";
import { useSeamlessPlayback } from "@/hooks/useSeamlessPlayback";
import { generateSegments, analyzeSegmentFraming } from "@/services/api";
import {
  FileText,
  Wand2,
  Captions,
  Crop,
  Maximize2,
  Sparkles,
  Loader2,
  Clock,
  Smartphone,
  Square,
  Monitor,
} from "lucide-react";
import { DEFAULT_SEGMENT_FRAMING } from "@/remotion/types";
import type { SegmentFraming, AspectRatio } from "@/remotion/types";

export default function Editor() {
  const { projectId } = useParams();
  const dispatch = useDispatch();

  // Redux State
  const selectedSegmentId = useSelector(
    (state: RootState) => state.editor.selectedSegmentId
  );
  const segments = useSelector((state: RootState) => state.editor.segments);
  const currentTime = useSelector(
    (state: RootState) => state.editor.currentTime
  );
  const duration = useSelector((state: RootState) => state.editor.duration);
  const globalFraming = useSelector(
    (state: RootState) => state.editor.globalFraming
  );

  // Local State
  const videoRef = useRef<HTMLVideoElement>(null);
  const [activeTab, setActiveTab] = useState<"transcript" | "ai" | "captions">(
    "ai"
  );
  const [isGenerating, setIsGenerating] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const [isAnalyzingFraming, setIsAnalyzingFraming] = useState(false);
  const [framingTooltip, setFramingTooltip] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Custom Hooks
  const { videoUrl, transcription, loading } = useProjectData(projectId);
  // Seamless playback only in preview mode
  useSeamlessPlayback(videoRef, previewMode ? segments : []);

  // Get current segment's framing for preview - memoized to avoid find() on every render
  const selectedSegment = React.useMemo(
    () => segments.find((s) => s.id === selectedSegmentId),
    [segments, selectedSegmentId]
  );
  const currentFraming: SegmentFraming = React.useMemo(
    () =>
      selectedSegment?.framing || {
        ...DEFAULT_SEGMENT_FRAMING,
        aspectRatio: globalFraming.aspectRatio,
      },
    [selectedSegment?.framing, globalFraming.aspectRatio]
  );

  // Framing preview state
  const isCropMode = currentFraming.mode === "crop";
  const framingContainerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{
    x: number;
    y: number;
    focusX: number;
    focusY: number;
  } | null>(null);

  // Track if we actually dragged (moved more than a few pixels)
  const hasDraggedRef = useRef(false);

  // Handle drag to reposition video within frame
  const handleFramingMouseDown = (e: React.MouseEvent) => {
    if (!isCropMode || !selectedSegmentId) return;
    e.preventDefault();
    setIsDragging(true);
    hasDraggedRef.current = false;
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      focusX: currentFraming.focusX,
      focusY: currentFraming.focusY,
    };
  };

  const handleFramingMouseMove = (e: React.MouseEvent) => {
    if (
      !isDragging ||
      !dragStartRef.current ||
      !framingContainerRef.current ||
      !selectedSegmentId
    )
      return;

    const container = framingContainerRef.current;
    const rect = container.getBoundingClientRect();

    // Calculate delta as percentage of container size
    const deltaX = (e.clientX - dragStartRef.current.x) / rect.width;
    const deltaY = (e.clientY - dragStartRef.current.y) / rect.height;

    // Mark as dragged if moved more than a threshold
    if (Math.abs(deltaX) > 0.01 || Math.abs(deltaY) > 0.01) {
      hasDraggedRef.current = true;
    }

    // Invert: dragging right moves focus left (shows more of left side)
    const newFocusX = Math.max(
      0,
      Math.min(1, dragStartRef.current.focusX - deltaX)
    );
    const newFocusY = Math.max(
      0,
      Math.min(1, dragStartRef.current.focusY - deltaY)
    );

    dispatch(
      updateSegmentFraming({
        segmentId: selectedSegmentId,
        framing: {
          focusX: newFocusX,
          focusY: newFocusY,
        },
      })
    );
  };

  const handleFramingMouseUp = (e?: React.MouseEvent) => {
    const wasDragging = isDragging && hasDraggedRef.current;
    setIsDragging(false);
    dragStartRef.current = null;

    // If we didn't actually drag, treat it as a click to play/pause
    if (!wasDragging && e) {
      handleVideoClick(e);
    }
  };

  // Toggle crop/fit mode for current segment
  const toggleFramingMode = () => {
    if (!selectedSegmentId) return;
    dispatch(
      updateSegmentFraming({
        segmentId: selectedSegmentId,
        framing: { mode: isCropMode ? "fit" : "crop" },
      })
    );
  };

  // Generate a clean tooltip message from framing result
  const getFramingTooltipMessage = (mode: string, focusX: number): string => {
    if (mode === "fit") return "Fit to show all";

    // Map focusX to position label
    if (focusX <= 0.1) return "Crop far left";
    if (focusX <= 0.35) return "Crop slight left";
    if (focusX <= 0.65) return "Crop center";
    if (focusX <= 0.9) return "Crop slight right";
    return "Crop far right";
  };

  // AI analyze framing for current segment
  const handleAnalyzeFraming = async () => {
    if (!projectId || !selectedSegment) return;
    setIsAnalyzingFraming(true);
    setFramingTooltip(null);
    try {
      const result = await analyzeSegmentFraming(
        projectId,
        selectedSegment.id,
        selectedSegment.startTime,
        selectedSegment.endTime,
        globalFraming.aspectRatio // Pass the target aspect ratio to the AI
      );
      dispatch(
        setSegmentFraming({
          segmentId: selectedSegment.id,
          framing: {
            aspectRatio: globalFraming.aspectRatio,
            mode: result.framing.mode,
            focusX: result.framing.focusX,
            focusY: result.framing.focusY,
            aiReasoning: result.framing.aiReasoning,
            isAiGenerated: result.framing.isAiGenerated,
          },
        })
      );

      // Show tooltip with the AI's decision
      const message = getFramingTooltipMessage(
        result.framing.mode,
        result.framing.focusX
      );
      setFramingTooltip(message);

      // Auto-hide after 3 seconds
      setTimeout(() => setFramingTooltip(null), 5000);
    } catch (error) {
      console.error("Failed to analyze framing:", error);
      setFramingTooltip("Analysis failed");
      setTimeout(() => setFramingTooltip(null), 2000);
    } finally {
      setIsAnalyzingFraming(false);
    }
  };

  // Calculate aspect ratio for preview container
  const getAspectRatioValue = (ratio: AspectRatio): number => {
    switch (ratio) {
      case "9:16":
        return 9 / 16;
      case "1:1":
        return 1;
      case "16:9":
      default:
        return 16 / 9;
    }
  };

  const aspectRatioValue = getAspectRatioValue(globalFraming.aspectRatio);

  // Set projectId in Redux for sync middleware
  useEffect(() => {
    if (projectId) {
      dispatch(setProjectId(projectId));
    }
    return () => {
      dispatch(resetEditor());
    };
  }, [projectId, dispatch]);

  // Don't auto-seek when selecting segments - timeline handles seeking now
  // useEffect(() => {
  //   if (selectedSegmentId && videoRef.current) {
  //     const seg = segments.find((s) => s.id === selectedSegmentId);
  //     if (seg) {
  //       videoRef.current.currentTime = seg.startTime;
  //       videoRef.current.play();
  //     }
  //   }
  // }, [selectedSegmentId, segments]);

  const handleBackgroundClick = () => {
    if (selectedSegmentId) {
      dispatch(selectSegment(null));
    }
  };

  // Toggle video play/pause
  const handleVideoClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      const playPromise = video.play();
      if (playPromise !== undefined) {
        playPromise.catch((error) => {
          if (error.name !== "AbortError") {
            console.error("Playback error:", error);
          }
        });
      }
    } else {
      video.pause();
    }
  };

  // RAF for accurate time sync (captions, timeline, transcript)
  useEffect(() => {
    if (!videoUrl) return; // Don't start RAF until video is available

    let rafId: number;

    const tick = () => {
      const video = videoRef.current;
      if (video && !isNaN(video.currentTime)) {
        dispatch(setCurrentTime(video.currentTime));
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [dispatch, videoUrl]);

  const handleWordClick = (startTime: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = startTime;
      const playPromise = videoRef.current.play();
      if (playPromise !== undefined) {
        playPromise.catch((error) => {
          // Ignore AbortError - it's expected when user rapidly interacts
          if (error.name !== "AbortError") {
            console.error("Playback error:", error);
          }
        });
      }
    }
  };

  const handleGenerateSegments = async (selections: any) => {
    if (!projectId) return;
    setIsGenerating(true);

    // Pass current video duration as separate field (don't overwrite duration selection)
    const videoDuration = videoRef.current
      ? videoRef.current.duration
      : duration;
    const metadata = { ...selections, videoDuration };

    try {
      const result = await generateSegments(projectId, metadata);
      if (result.segments) {
        dispatch(setSegments(result.segments));
      }
      setIsGenerating(false);
    } catch (error: any) {
      console.error("Failed to generate segments:", error);

      // If status is 503/504, it might be a gateway timeout while Lambda continues.
      if (error.response?.status === 503 || error.response?.status === 504) {
        console.log("Gateway timeout detected. Polling for results...");

        let attempts = 0;
        const maxAttempts = 60; // 5 minutes (5s interval)

        const pollInterval = setInterval(async () => {
          attempts++;
          try {
            // Import getProject dynamically or use the hook's data if we can force refresh
            // Better to use direct API call here
            const { getProject } = await import("@/services/api");
            const projectData = await getProject(projectId);

            if (projectData.segments && projectData.segments.length > 0) {
              dispatch(setSegments(projectData.segments));
              clearInterval(pollInterval);
              setIsGenerating(false);
              // Maybe switch tab?
              // setActiveTab("transcript");
            } else if (attempts >= maxAttempts) {
              clearInterval(pollInterval);
              setIsGenerating(false);
              alert("Generation timed out. Please try again.");
            }
          } catch (e) {
            console.warn("Polling error:", e);
          }
        }, 5000);

        // Return early to keep isGenerating true until polling finishes
        return;
      }

      alert("Failed to generate segments. Please try again.");
      setIsGenerating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-[calc(100vh-4rem)]">
        {/* Left: Video & Timeline skeleton */}
        <div className="flex-1 flex flex-col min-w-0 bg-background border-r">
          <div className="flex-1 bg-black flex items-center justify-center">
            <Skeleton className="w-[80%] aspect-video bg-muted/20" />
          </div>
          <div className="h-32 border-t bg-card p-2">
            <Skeleton className="w-full h-full" />
          </div>
        </div>
        {/* Right: Sidebar skeleton */}
        <div className="w-80 flex flex-col bg-card border-l p-4 space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-4rem)]">
      {/* Left: Video & Timeline */}
      <div className="flex-1 flex flex-col min-w-0 bg-background border-r">
        {/* Video Player with Caption Overlay */}
        <div
          className="flex-1 bg-black relative flex items-center justify-center min-h-0 p-4 gap-3"
          onClick={handleBackgroundClick}
        >
          {/* Aspect Ratio Selector - Outside video on left */}
          <div className="flex flex-col gap-1.5 shrink-0">
            {[
              {
                value: "9:16" as AspectRatio,
                icon: Smartphone,
                label: "Portrait",
                sublabel: "TikTok, Reels, Shorts",
              },
              {
                value: "1:1" as AspectRatio,
                icon: Square,
                label: "Square",
                sublabel: "Instagram Feed",
              },
              {
                value: "16:9" as AspectRatio,
                icon: Monitor,
                label: "Landscape",
                sublabel: "YouTube, TV",
              },
            ].map((ratio) => (
              <button
                key={ratio.value}
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch(setGlobalAspectRatio(ratio.value));
                }}
                className={cn(
                  "w-10 h-10 rounded-lg flex items-center justify-center transition-all",
                  globalFraming.aspectRatio === ratio.value
                    ? "bg-primary text-primary-foreground ring-2 ring-primary ring-offset-2 ring-offset-black"
                    : "bg-white/10 hover:bg-white/20 text-white/70 hover:text-white"
                )}
                title={`${ratio.label} (${ratio.value})\n${ratio.sublabel}`}
              >
                <ratio.icon className="h-5 w-5" />
              </button>
            ))}
            <div className="text-[10px] text-white/50 text-center mt-1 leading-tight">
              {globalFraming.aspectRatio}
            </div>
          </div>

          {videoUrl ? (
            /* Framing Preview - aspect ratio container with draggable video */
            <div
              ref={framingContainerRef}
              className={cn(
                "relative overflow-hidden bg-black rounded-xl select-none shadow-2xl",
                isDragging
                  ? "cursor-grabbing ring-2 ring-primary ring-offset-4 ring-offset-black"
                  : isCropMode
                  ? "cursor-grab ring-2 ring-white/20 hover:ring-white/40"
                  : "cursor-pointer ring-1 ring-white/10"
              )}
              style={{
                aspectRatio: aspectRatioValue,
                maxHeight: aspectRatioValue < 1 ? "100%" : "85%",
                maxWidth: aspectRatioValue >= 1 ? "100%" : "85%",
              }}
              onMouseDown={isCropMode ? handleFramingMouseDown : undefined}
              onMouseMove={isCropMode ? handleFramingMouseMove : undefined}
              onMouseUp={isCropMode ? handleFramingMouseUp : undefined}
              onMouseLeave={
                isCropMode ? () => handleFramingMouseUp() : undefined
              }
              onClick={!isCropMode ? handleVideoClick : undefined}
            >
              <video
                ref={videoRef}
                src={videoUrl}
                className="w-full h-full pointer-events-none"
                style={{
                  objectFit: isCropMode ? "cover" : "contain",
                  objectPosition: isCropMode
                    ? `${currentFraming.focusX * 100}% ${
                        currentFraming.focusY * 100
                      }%`
                    : "center center",
                }}
                onLoadedMetadata={(e) =>
                  dispatch(setDuration(e.currentTarget.duration))
                }
              />

              {/* Overlay Controls - Top Right */}
              <div className="absolute top-2 right-2 flex items-center gap-1.5">
                {/* Crop/Fit Toggle - shows what clicking will do */}
                {selectedSegment && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFramingMode();
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    className={cn(
                      "flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors",
                      "bg-black/60 hover:bg-black/80 text-white backdrop-blur-sm"
                    )}
                    title={
                      isCropMode
                        ? "Switch to Fit mode\nShows full video with letterboxing"
                        : "Switch to Crop mode\nFills frame, drag video to reposition"
                    }
                  >
                    {isCropMode ? (
                      <>
                        <Maximize2 className="h-3 w-3" />
                        <span>Fit</span>
                      </>
                    ) : (
                      <>
                        <Crop className="h-3 w-3" />
                        <span>Crop</span>
                      </>
                    )}
                  </button>
                )}

                {/* AI Auto-frame Button - only for segments */}
                {selectedSegment && (
                  <div className="relative">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleAnalyzeFraming();
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      disabled={isAnalyzingFraming}
                      className={cn(
                        "flex items-center justify-center w-7 h-7 rounded transition-colors",
                        "bg-black/60 hover:bg-black/80 text-white backdrop-blur-sm",
                        isAnalyzingFraming && "opacity-70"
                      )}
                      title="Auto-frame with AI"
                    >
                      {isAnalyzingFraming ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                      )}
                    </button>

                    {/* AI Response Tooltip - positioned to the left to avoid overflow clipping */}
                    {framingTooltip && (
                      <div className="absolute top-1/2 right-full -translate-y-1/2 mr-2 z-50 animate-in fade-in slide-in-from-right-1 duration-200">
                        <div className="relative bg-black/90 text-white text-xs font-medium px-2.5 py-1.5 rounded-md whitespace-nowrap backdrop-blur-sm shadow-lg">
                          {/* Arrow pointing right */}
                          <div className="absolute top-1/2 -right-1 -translate-y-1/2 w-2 h-2 bg-black/90 rotate-45" />
                          <span className="relative">{framingTooltip}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Drag hint overlay */}
              {isCropMode && !isDragging && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 hover:opacity-100 transition-opacity pointer-events-none">
                  <span className="text-white text-sm font-medium px-3 py-1.5 bg-black/70 rounded-full backdrop-blur-sm">
                    Drag to reposition • Double-click sliders to center
                  </span>
                </div>
              )}

              {/* Position sliders - only in crop mode */}
              {isCropMode && selectedSegment && (
                <>
                  {/* Vertical slider for landscape */}
                  {globalFraming.aspectRatio === "16:9" && (
                    <FramingSlider
                      orientation="vertical"
                      value={currentFraming.focusY}
                      aspectRatio={1 / aspectRatioValue}
                      onChange={(y) =>
                        dispatch(
                          updateSegmentFraming({
                            segmentId: selectedSegmentId!,
                            framing: { focusY: y },
                          })
                        )
                      }
                    />
                  )}

                  {/* Horizontal slider for portrait and square */}
                  {(globalFraming.aspectRatio === "9:16" ||
                    globalFraming.aspectRatio === "1:1") && (
                    <FramingSlider
                      orientation="horizontal"
                      value={currentFraming.focusX}
                      aspectRatio={
                        globalFraming.aspectRatio === "1:1"
                          ? 1.0 / (16 / 9) // Square frame / landscape video = 9/16
                          : aspectRatioValue // Portrait: 9/16
                      }
                      onChange={(x) =>
                        dispatch(
                          updateSegmentFraming({
                            segmentId: selectedSegmentId!,
                            framing: { focusX: x },
                          })
                        )
                      }
                    />
                  )}
                </>
              )}

              <CaptionOverlay currentTime={currentTime} />
            </div>
          ) : (
            <div className="text-white">Loading Video...</div>
          )}
        </div>

        {/* Timeline */}
        <div className="border-t bg-card">
          <div className="h-32 p-1.5">
            <Timeline
              videoRef={videoRef}
              previewMode={previewMode}
              onPreviewModeChange={setPreviewMode}
            />
          </div>
        </div>
      </div>

      {/* Right: Collapsible Sidebar */}
      <div className="relative flex">
        {/* Edge toggle handle */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className={cn(
            "absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/2 z-20",
            "w-5 h-12 flex items-center justify-center",
            "bg-card border rounded-full shadow-md",
            "opacity-0 hover:opacity-100 transition-opacity",
            "group-hover:opacity-60",
            !sidebarOpen && "opacity-100"
          )}
          title={sidebarOpen ? "Collapse panel" : "Expand panel"}
        >
          <div
            className={cn(
              "w-1 h-6 rounded-full bg-muted-foreground/40 transition-transform",
              !sidebarOpen && "rotate-180"
            )}
          />
        </button>

        <div
          className={cn(
            "flex flex-col bg-card border-l overflow-hidden transition-all duration-200",
            sidebarOpen ? "w-80" : "w-0"
          )}
        >
          {sidebarOpen && (
            <>
              {/* Tabs Header - Compact */}
              <div className="flex border-b">
                {[
                  {
                    id: "ai" as const,
                    icon: Wand2,
                    label: "IQ",
                    tooltip: "IQ Studio - Generate clips with AI",
                  },
                  {
                    id: "captions" as const,
                    icon: Captions,
                    label: "Caps",
                    tooltip: "Caption settings",
                  },
                  {
                    id: "transcript" as const,
                    icon: FileText,
                    label: "Script",
                    tooltip: "Full transcript",
                  },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    className={cn(
                      "flex-1 py-2 text-xs font-medium flex flex-col items-center gap-0.5 transition-colors border-b-2",
                      activeTab === tab.id
                        ? "border-primary text-primary bg-primary/5"
                        : "border-transparent text-muted-foreground hover:bg-muted/50"
                    )}
                    onClick={() => setActiveTab(tab.id)}
                    title={tab.tooltip}
                  >
                    <tab.icon className="h-4 w-4" />
                    <span>{tab.label}</span>
                  </button>
                ))}
              </div>

              <div className="flex-1 overflow-y-auto relative">
                {activeTab === "ai" && (
                  <MicrodramaGenerator
                    onGenerate={handleGenerateSegments}
                    isGenerating={isGenerating}
                  />
                )}
                {activeTab === "captions" && <CaptionEditor />}
                {activeTab === "transcript" && (
                  <TranscriptPanel
                    transcription={transcription}
                    segments={segments}
                    currentTime={currentTime}
                    duration={duration}
                    previewMode={previewMode}
                    onWordClick={handleWordClick}
                    loading={loading}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Helper to format time as MM:SS
function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

// Group words into chunks of ~10 seconds each
function groupWordsIntoChunks(
  words: Array<{ start: number; end: number; value: string }>,
  chunkDuration = 10
): Array<{
  startTime: number;
  endTime: number;
  words: Array<{ start: number; end: number; value: string }>;
}> {
  if (words.length === 0) return [];

  const chunks: Array<{
    startTime: number;
    endTime: number;
    words: Array<{ start: number; end: number; value: string }>;
  }> = [];

  let currentChunk: {
    startTime: number;
    endTime: number;
    words: Array<{ start: number; end: number; value: string }>;
  } | null = null;

  for (const word of words) {
    if (!currentChunk) {
      currentChunk = {
        startTime: word.start,
        endTime: word.end,
        words: [word],
      };
    } else if (word.start - currentChunk.startTime < chunkDuration) {
      currentChunk.words.push(word);
      currentChunk.endTime = word.end;
    } else {
      chunks.push(currentChunk);
      currentChunk = {
        startTime: word.start,
        endTime: word.end,
        words: [word],
      };
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

interface TranscriptPanelProps {
  transcription: Array<{ start: number; end: number; value: string }>;
  segments: Array<{ id: string; startTime: number; endTime: number }>;
  currentTime: number;
  duration: number;
  previewMode: boolean;
  onWordClick: (startTime: number) => void;
  loading: boolean;
}

function TranscriptPanel({
  transcription,
  segments,
  currentTime,
  duration,
  previewMode,
  onWordClick,
  loading,
}: TranscriptPanelProps) {
  // Memoize filtered transcription - only recompute when transcription, segments, or previewMode changes
  // NOT on every currentTime change (which happens 60fps)
  const filteredTranscription = React.useMemo(() => {
    if (!previewMode) return transcription;
    return transcription.filter((word) =>
      segments.some(
        (seg) => word.start >= seg.startTime && word.end <= seg.endTime
      )
    );
  }, [transcription, segments, previewMode]);

  // Memoize chunks - expensive operation that shouldn't run on every frame
  const chunks = React.useMemo(
    () => groupWordsIntoChunks(filteredTranscription),
    [filteredTranscription]
  );

  // Memoize total duration calculation
  const shownDuration = React.useMemo(
    () =>
      previewMode
        ? segments.reduce((sum, seg) => sum + (seg.endTime - seg.startTime), 0)
        : duration,
    [previewMode, segments, duration]
  );

  return (
    <div className="p-4 space-y-3 text-sm h-full overflow-y-auto">
      {/* Header */}
      <div className="flex justify-between items-center text-xs text-muted-foreground pb-2 border-b">
        <span className="font-medium">
          {previewMode ? "Preview Transcript" : "Full Transcript"}
        </span>
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {formatTime(shownDuration)}
        </span>
      </div>

      {previewMode && segments.length === 0 && (
        <div className="text-muted-foreground text-center py-8 text-xs">
          No segments selected. Add segments to see preview transcript.
        </div>
      )}

      {chunks.length > 0 ? (
        <div className="space-y-4">
          {chunks.map((chunk, chunkIdx) => {
            const isChunkActive =
              currentTime >= chunk.startTime && currentTime <= chunk.endTime;

            return (
              <div
                key={chunkIdx}
                className={cn(
                  "rounded-lg p-3 transition-colors",
                  isChunkActive
                    ? "bg-primary/10 border border-primary/20"
                    : "bg-muted/30 hover:bg-muted/50"
                )}
              >
                {/* Timestamp badge */}
                <div className="flex items-center gap-2 mb-2">
                  <span
                    className={cn(
                      "text-[10px] font-mono px-1.5 py-0.5 rounded",
                      isChunkActive
                        ? "bg-primary/20 text-primary"
                        : "bg-muted text-muted-foreground"
                    )}
                  >
                    {formatTime(chunk.startTime)}
                  </span>
                  <div className="flex-1 h-px bg-border" />
                  <span
                    className={cn(
                      "text-[10px] font-mono px-1.5 py-0.5 rounded",
                      isChunkActive
                        ? "bg-primary/20 text-primary"
                        : "bg-muted text-muted-foreground"
                    )}
                  >
                    {formatTime(chunk.endTime)}
                  </span>
                </div>

                {/* Words */}
                <p className="leading-relaxed">
                  {chunk.words.map((word, idx) => {
                    const isActive =
                      currentTime >= word.start && currentTime <= word.end;
                    return (
                      <span
                        key={idx}
                        onClick={() => onWordClick(word.start)}
                        className={cn(
                          "cursor-pointer hover:bg-primary/20 rounded px-0.5 transition-colors",
                          isActive && "bg-primary text-primary-foreground"
                        )}
                      >
                        {word.value}{" "}
                      </span>
                    );
                  })}
                </p>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-muted-foreground text-center py-10">
          {loading ? "Loading transcript..." : "No transcript available."}
        </div>
      )}
    </div>
  );
}
