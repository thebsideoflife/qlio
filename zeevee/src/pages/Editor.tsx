import { Timeline } from "@/components/editor/Timeline";
import { MicrodramaGenerator } from "@/components/editor/MicrodramaGenerator";
import { useSelector, useDispatch } from "react-redux";
import type { RootState } from "@/store/store";
import {
  selectSegment,
  setCurrentTime,
  setDuration,
  setSegments,
} from "@/store/editorSlice";
import { useParams } from "react-router-dom";
import { useRef, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useProjectData } from "@/hooks/useProjectData";
import { useSeamlessPlayback } from "@/hooks/useSeamlessPlayback";
import { generateSegments } from "@/services/api";
import { FileText, Wand2 } from "lucide-react";

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
  const [activeTab, setActiveTab] = useState<"transcript" | "ai">("ai");
  const [isGenerating, setIsGenerating] = useState(false);

  // Custom Hooks
  const { videoUrl, transcription, loading } = useProjectData(projectId);
  // Always active (seamless playback)
  useSeamlessPlayback(videoRef, segments);

  // Sync selection to video player
  useEffect(() => {
    if (selectedSegmentId && videoRef.current) {
      const seg = segments.find((s) => s.id === selectedSegmentId);
      if (seg) {
        videoRef.current.currentTime = seg.startTime;
        videoRef.current.play();
      }
    }
  }, [selectedSegmentId, segments]);

  const handleBackgroundClick = () => {
    if (selectedSegmentId) {
      dispatch(selectSegment(null));
    }
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      dispatch(setCurrentTime(videoRef.current.currentTime));
    }
  };

  const handleWordClick = (startTime: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = startTime;
      videoRef.current.play();
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
      <div className="flex items-center justify-center h-screen text-muted-foreground">
        Loading project...
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-4rem)]">
      {/* Left: Video & Timeline */}
      <div className="flex-1 flex flex-col min-w-0 bg-background border-r">
        {/* Video Player */}
        <div
          className="flex-1 bg-black relative flex items-center justify-center group min-h-0"
          onClick={handleBackgroundClick}
        >
          {videoUrl ? (
            <video
              ref={videoRef}
              src={videoUrl}
              className="max-h-full max-w-full"
              controls
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={(e) =>
                dispatch(setDuration(e.currentTarget.duration))
              }
            />
          ) : (
            <div className="text-white">Loading Video...</div>
          )}
        </div>

        {/* Timeline */}
        <div className="h-32 border-t bg-card p-2">
          <Timeline />
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
            AI Director
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
            Transcription
          </button>
        </div>

        <div className="flex-1 overflow-y-auto relative">
          {activeTab === "ai" ? (
            <MicrodramaGenerator
              onGenerate={handleGenerateSegments}
              isGenerating={isGenerating}
            />
          ) : (
            <div className="p-4 space-y-1 text-sm leading-relaxed h-full">
              <div className="flex justify-between items-center mb-4 text-xs text-muted-foreground">
                <span>Full Transcript</span>
                <span>
                  {Math.floor(duration / 60)}:
                  {(duration % 60).toFixed(0).padStart(2, "0")}
                </span>
              </div>

              {transcription.length > 0 ? (
                <p>
                  {transcription.map((word, idx) => {
                    const isActive =
                      currentTime >= word.start && currentTime <= word.end;
                    return (
                      <span
                        key={idx}
                        onClick={() => handleWordClick(word.start)}
                        className={cn(
                          "cursor-pointer hover:bg-blue-100 rounded px-0.5 transition-colors",
                          isActive && "bg-blue-200 text-blue-800 font-medium"
                        )}
                      >
                        {word.value}{" "}
                      </span>
                    );
                  })}
                </p>
              ) : (
                <div className="text-muted-foreground text-center mt-10">
                  {loading
                    ? "Loading transcript..."
                    : "No transcript available."}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
