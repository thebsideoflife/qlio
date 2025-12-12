import { useState, useEffect, useCallback } from "react";
import { useDispatch } from "react-redux";
import {
  setSegments,
  setProjectMetadata,
  setTranscriptWords,
  setCaptionSettings,
} from "@/store/editorSlice";
import { getProject } from "@/services/api";
import type { CaptionWord } from "@/remotion/types";

export function useProjectData(projectId: string | undefined) {
  const dispatch = useDispatch();
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [transcription, setTranscription] = useState<CaptionWord[]>([]);
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

      // Load caption settings if they exist
      if (project.captionSettings) {
        dispatch(setCaptionSettings(project.captionSettings));
      }

      dispatch(
        setProjectMetadata({
          title: project.title || "Untitled Project",
          assetName:
            project.asset?.originalName ||
            project.asset?.title ||
            "Unknown Asset",
        })
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

  return { videoUrl, transcription, loading, error };
}
