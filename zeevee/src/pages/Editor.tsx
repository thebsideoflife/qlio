import { Timeline } from "@/components/editor/Timeline";
import { MicrodramaGenerator } from "@/components/editor/MicrodramaGenerator";
import { CaptionOverlay } from "@/components/editor/CaptionOverlay";
import { CaptionEditor } from "@/components/editor/CaptionEditor";
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
} from "@/store/editorSlice";
import { useParams } from "react-router-dom";
import { useRef, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useProjectData } from "@/hooks/useProjectData";
import { useSeamlessPlayback } from "@/hooks/useSeamlessPlayback";
import { generateSegments } from "@/services/api";
import { FileText, Wand2, Captions, Clock } from "lucide-react";

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

  // Local State
  const videoRef = useRef<HTMLVideoElement>(null);
  const [activeTab, setActiveTab] = useState<"transcript" | "ai" | "captions">(
    "ai"
  );
  const [isGenerating, setIsGenerating] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);

  // Custom Hooks
  const { videoUrl, transcription, loading } = useProjectData(projectId);
  // Seamless playback only in preview mode
  useSeamlessPlayback(videoRef, previewMode ? segments : []);

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

    // Pass current video duration if available
    const currentDuration = videoRef.current
      ? videoRef.current.duration
      : duration;
    const metadata = { ...selections, duration: currentDuration };

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
          className="flex-1 bg-black relative flex items-center justify-center min-h-0"
          onClick={handleBackgroundClick}
        >
          {videoUrl ? (
            <>
              <video
                ref={videoRef}
                src={videoUrl}
                className="max-h-full max-w-full"
                controls
                onLoadedMetadata={(e) =>
                  dispatch(setDuration(e.currentTarget.duration))
                }
              />
              <CaptionOverlay currentTime={currentTime} />
            </>
          ) : (
            <div className="text-white">Loading Video...</div>
          )}
        </div>

        {/* Timeline */}
        <div className="h-36 border-t bg-card p-2">
          <Timeline
            videoRef={videoRef}
            previewMode={previewMode}
            onPreviewModeChange={setPreviewMode}
          />
        </div>
      </div>

      {/* Right: Transcription & Details */}
      <div className="w-80 flex flex-col bg-card border-l overflow-hidden">
        {/* Tabs Header */}
        <div className="flex border-b">
          <button
            className={cn(
              "flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors border-b-2",
              activeTab === "ai"
                ? "border-primary text-primary bg-primary/5"
                : "border-transparent text-muted-foreground hover:bg-muted/50"
            )}
            onClick={() => setActiveTab("ai")}
          >
            <Wand2 className="h-4 w-4" />
            AI
          </button>
          <button
            className={cn(
              "flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors border-b-2",
              activeTab === "captions"
                ? "border-primary text-primary bg-primary/5"
                : "border-transparent text-muted-foreground hover:bg-muted/50"
            )}
            onClick={() => setActiveTab("captions")}
          >
            <Captions className="h-4 w-4" />
            Captions
          </button>
          <button
            className={cn(
              "flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors border-b-2",
              activeTab === "transcript"
                ? "border-primary text-primary bg-primary/5"
                : "border-transparent text-muted-foreground hover:bg-muted/50"
            )}
            onClick={() => setActiveTab("transcript")}
          >
            <FileText className="h-4 w-4" />
            Text
          </button>
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
  // Filter transcription to only show words within segments when in preview mode
  const filteredTranscription = previewMode
    ? transcription.filter((word) =>
        segments.some(
          (seg) => word.start >= seg.startTime && word.end <= seg.endTime
        )
      )
    : transcription;

  // Group words into chunks
  const chunks = groupWordsIntoChunks(filteredTranscription);

  // Calculate total duration shown
  const shownDuration = previewMode
    ? segments.reduce((sum, seg) => sum + (seg.endTime - seg.startTime), 0)
    : duration;

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
