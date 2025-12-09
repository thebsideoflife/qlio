import { useState, useEffect } from "react";
import { useDispatch } from "react-redux";
import { setSegments, setProjectMetadata } from "@/store/editorSlice";
import { getProject } from "@/services/api";

export function useProjectData(projectId: string | undefined) {
  const dispatch = useDispatch();
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [transcription, setTranscription] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;

    setLoading(true);
    getProject(projectId)
      .then((project) => {
        if (project.asset?.videoUrl) {
          setVideoUrl(project.asset.videoUrl);
        }

        if (project.segments) {
          dispatch(setSegments(project.segments));
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

        // Fetch Transcription if available
        if (project.asset?.transcriptionUrl) {
          return fetch(project.asset.transcriptionUrl)
            .then((res) => res.json())
            .then((data) => {
              if (Array.isArray(data)) {
                setTranscription(data);
              } else if (data.data && Array.isArray(data.data)) {
                setTranscription(data.data);
              } else if (
                data.transcription &&
                Array.isArray(data.transcription)
              ) {
                setTranscription(data.transcription);
              }
            });
        }
      })
      .catch((err) => {
        console.error("Failed to load project data", err);
        setError("Failed to load project data");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [projectId, dispatch]);

  return { videoUrl, transcription, loading, error };
}
