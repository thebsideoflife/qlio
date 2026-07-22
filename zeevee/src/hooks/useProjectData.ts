import { useState, useEffect, useCallback } from "react";
import { useDispatch } from "react-redux";
import {
  setSegments,
  setProjectMetadata,
  setTranscriptWords,
  setCaptionSettings,
  setGlobalFraming,
  setLastSegmentRenders,
  setSegmentMetadata,
  setProjectThumbnailUrl,
} from "@/store/editorSlice";
import {
  getProject,
  type GenerationJob,
  type FramingJob,
} from "@/services/api";
import { DEFAULT_CAPTION_SETTINGS, DEFAULT_GLOBAL_FRAMING } from "@/remotion/types";
import type { CaptionWord, GlobalFramingSettings } from "@/remotion/types";

// Last generation inputs persisted on the project (written by generateSegments)
export interface GenerationMetadata {
  userPrompt?: string | null;
  purpose?: string | null;
  format?: string | null;
  assetType?: string | null;
  platform?: string | null;
  minSegmentDuration?: number | null;
  maxSegmentDuration?: number | null;
  targetPercent?: number | null;
}

export function useProjectData(projectId: string | undefined) {
  const dispatch = useDispatch();
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [transcription, setTranscription] = useState<CaptionWord[]>([]);
  const [generationMetadata, setGenerationMetadata] =
    useState<GenerationMetadata | null>(null);
  const [generationJob, setGenerationJob] = useState<GenerationJob | null>(
    null,
  );
  const [framingJob, setFramingJob] = useState<FramingJob | null>(null);
  const [activeRenderJobId, setActiveRenderJobId] = useState<string | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProject = useCallback(async () => {
    if (!projectId) return;

    try {
      const project = await getProject(projectId);

      if (project.asset?.videoUrl) {
        setVideoUrl(project.asset.videoUrl);
      }

      if (project.segments) {
        dispatch(setSegments(project.segments));
      }

      // Load caption settings, merging with defaults so new fields are picked up
      if (project.captionSettings) {
        dispatch(
          setCaptionSettings({
            ...DEFAULT_CAPTION_SETTINGS,
            ...project.captionSettings,
            style: {
              ...DEFAULT_CAPTION_SETTINGS.style,
              ...project.captionSettings.style,
            },
          }),
        );
      }

      // Load global framing settings if they exist. Default squareTop to false
      // for projects created before the square-top feature (missing field).
      if (project.globalFraming) {
        const loadedFraming: GlobalFramingSettings = {
          ...DEFAULT_GLOBAL_FRAMING,
          ...project.globalFraming,
          squareTop: project.globalFraming.squareTop ?? false,
        };
        dispatch(setGlobalFraming(loadedFraming));
      }

      // Load cached segment renders (preserve original hashes - don't backfill)
      if (
        project.lastRenderDownloads &&
        project.lastRenderDownloads.length > 0
      ) {
        dispatch(setLastSegmentRenders(project.lastRenderDownloads));
      }

      if (project.segmentMetadata && project.segmentMetadata.length > 0) {
        dispatch(setSegmentMetadata(project.segmentMetadata));
      }

      if (project.thumbnailUrl) {
        dispatch(setProjectThumbnailUrl(project.thumbnailUrl));
      }

      // Load generation metadata (last used generation inputs)
      if (project.metadata) {
        setGenerationMetadata(project.metadata);
      }

      // Load generation job status (for resuming polling after page refresh)
      if (project.generationJob) {
        setGenerationJob(project.generationJob);
      }

      // Load framing job status (for resuming polling after page refresh)
      if (project.framingJob) {
        setFramingJob(project.framingJob);
      }

      // Load active render job ID (for resuming render polling after page refresh)
      if (project.activeRenderJobId) {
        setActiveRenderJobId(project.activeRenderJobId);
      }

      dispatch(
        setProjectMetadata({
          title: project.title || "Untitled",
          assetName:
            project.asset?.originalName ||
            project.asset?.title ||
            "Unknown Asset",
        }),
      );

      // Fetch transcription if available
      if (project.asset?.transcriptionUrl) {
        const res = await fetch(project.asset.transcriptionUrl);
        const data = await res.json();

        let words: CaptionWord[] = [];
        if (Array.isArray(data)) {
          words = data;
        } else if (data.data && Array.isArray(data.data)) {
          words = data.data;
        } else if (data.transcription && Array.isArray(data.transcription)) {
          words = data.transcription;
        }

        setTranscription(words);
        dispatch(setTranscriptWords(words));
      }
    } catch (err) {
      console.error("Failed to load project data", err);
      setError("Failed to load project data");
    } finally {
      setLoading(false);
    }
  }, [projectId, dispatch]);

  useEffect(() => {
    loadProject();
  }, [loadProject]);

  return {
    videoUrl,
    transcription,
    generationMetadata,
    generationJob,
    framingJob,
    activeRenderJobId,
    loading,
    error,
  };
}
