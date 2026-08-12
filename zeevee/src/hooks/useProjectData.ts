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
  setGenerationMetadata,
  type GenerationMetadata,
} from "@/store/editorSlice";
import { getProject, type FramingJob } from "@/services/api";
import { DEFAULT_CAPTION_SETTINGS, DEFAULT_GLOBAL_FRAMING } from "@/remotion/types";
import type { CaptionWord, GlobalFramingSettings } from "@/remotion/types";

export type { GenerationMetadata };

export function useProjectData(projectId: string | undefined) {
  const dispatch = useDispatch();
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [transcription, setTranscription] = useState<CaptionWord[]>([]);
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

      if (project.globalFraming) {
        const loadedFraming: GlobalFramingSettings = {
          ...DEFAULT_GLOBAL_FRAMING,
          ...project.globalFraming,
          squareTop: project.globalFraming.squareTop ?? false,
        };
        dispatch(setGlobalFraming(loadedFraming));
      }

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

      dispatch(setGenerationMetadata(project.metadata ?? {}));

      if (project.framingJob) {
        setFramingJob(project.framingJob);
      }

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
    framingJob,
    activeRenderJobId,
    loading,
    error,
  };
}
