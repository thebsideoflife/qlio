import { Timeline } from "@/components/editor/Timeline";
import { SegmentDetailSidebar } from "@/components/editor/SegmentDetailSidebar";
import { useSelector, useDispatch } from "react-redux";
import type { RootState } from "@/store/store";
import {
  selectSegment,
  setSegments,
  setCurrentTime,
  setDuration,
} from "@/store/editorSlice";
import { useParams } from "react-router-dom";
import { useEffect, useState, useRef } from "react";
import { getAsset } from "@/services/api";

export default function Editor() {
  const { assetId } = useParams();
  const dispatch = useDispatch();
  const selectedSegmentId = useSelector(
    (state: RootState) => state.editor.selectedSegmentId
  );
  const segments = useSelector((state: RootState) => state.editor.segments);

  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (assetId) {
      getAsset(assetId)
        .then((asset) => {
          if (asset.videoUrl) setVideoUrl(asset.videoUrl);
          if (asset.segments) dispatch(setSegments(asset.segments));
        })
        .catch((err) => console.error("Failed to load asset", err));
    }
  }, [assetId, dispatch]);

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

  return (
    <div className="flex h-[calc(100vh-4rem)] -m-8">
      {" "}
      {/* Match MainLayout's padding and header height */}
      {/* Main Content (Video + Timeline) */}
      <div className="flex-1 flex flex-col min-w-0 bg-background">
        {/* Video Player Area */}
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

        {/* Timeline Area */}
        <div className="h-48 border-t bg-card p-4">
          <div className="flex justify-between items-center mb-3">
            <div className="text-sm font-medium">Timeline</div>
            <div className="flex gap-2 text-xs text-muted-foreground">
              <span>Total Segments: {segments.length}</span>
            </div>
          </div>
          <Timeline />
        </div>
      </div>
      {/* Right Sidebar - Only show when segment is selected */}
      {selectedSegmentId && <SegmentDetailSidebar />}
    </div>
  );
}
