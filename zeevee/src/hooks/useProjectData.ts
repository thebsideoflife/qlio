import { useState, useEffect, useCallback } from "react";
import { useDispatch, useSelector } from "react-redux";
import type { RootState } from "@/store/store";
import {
  setSegments,
  setProjectMetadata,
  setTranscriptWords,
  setCaptionSettings,
  setCaptionLanguageMeta,
  setCaptionLines,
  setGlobalFraming,
  setLastSegmentRenders,
  setSegmentMetadata,
  setProjectThumbnailUrl,
  setGenerationMetadata,
  type GenerationMetadata,
} from "@/store/editorSlice";
import { getAsset, getProject, type FramingJob } from "@/services/api";
import { DEFAULT_CAPTION_SETTINGS, DEFAULT_GLOBAL_FRAMING } from "@/remotion/types";
import type { CaptionWord, GlobalFramingSettings } from "@/remotion/types";
import { parseTranscriptPayload } from "@/lib/transcript";

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
  const [assetId, setAssetId] = useState<string | null>(null);
  const transcriptionStatus = useSelector(
    (state: RootState) => state.editor.transcriptionStatus,
  );
  const activeLanguage = useSelector(
    (state: RootState) => state.editor.captionSettings.activeLanguage,
  );

  const applyAssetTranscript = useCallback(
    async (asset: {
      transcriptionUrl?: string;
      originalLanguage?: string;
      transcriptionStatus?: "pending" | "ready" | "failed";
      translations?: Record<string, string>;
    }, displayLanguage?: string) => {
      const status = asset.transcriptionStatus || (asset.transcriptionUrl ? "ready" : null);
      const translations = asset.translations || {};

      if (!asset.transcriptionUrl) {
        dispatch(
          setCaptionLanguageMeta({
            originalLanguage: asset.originalLanguage || null,
            transcriptionStatus: status,
            translations,
          }),
        );
        setTranscription([]);
        dispatch(setTranscriptWords([]));
        return;
      }

      const res = await fetch(asset.transcriptionUrl);
      const data = await res.json();
      const parsed = parseTranscriptPayload(data);
      const originalLanguage =
        asset.originalLanguage ||
        (parsed.language && parsed.language !== "und" ? parsed.language : null);
      dispatch(
        setCaptionLanguageMeta({
          originalLanguage,
          transcriptionStatus: status,
          translations,
        }),
      );
      const words = parsed.words;
      setTranscription(words);
      dispatch(setTranscriptWords(words));

      const displayLang = displayLanguage || originalLanguage;
      if (
        displayLang &&
        displayLang !== "original" &&
        translations[displayLang] &&
        displayLang !== originalLanguage
      ) {
        const translated = await fetch(translations[displayLang]);
        const translatedJson = await translated.json();
        const lines = parseTranscriptPayload(translatedJson).lines;
        if (lines.length > 0) dispatch(setCaptionLines(lines));
      }
    },
    [dispatch],
  );

  const loadProject = useCallback(async () => {
    if (!projectId) return;

    try {
      const project = await getProject(projectId);

      if (project.asset?.assetId) setAssetId(project.asset.assetId);
      else if (project.assetId) setAssetId(project.assetId);

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
          assetId: project.asset?.assetId || project.assetId || null,
        }),
      );

      if (project.asset) {
        await applyAssetTranscript(
          project.asset,
          project.captionSettings?.activeLanguage,
        );
      }
    } catch (err) {
      console.error("Failed to load project data", err);
      setError("Failed to load project data");
    } finally {
      setLoading(false);
    }
  }, [projectId, dispatch, applyAssetTranscript]);

  useEffect(() => {
    loadProject();
  }, [loadProject]);

  useEffect(() => {
    if (!assetId || transcriptionStatus !== "pending") return;
    const id = window.setInterval(async () => {
      try {
        const asset = await getAsset(assetId);
        if (asset.transcriptionStatus === "pending") return;
        await applyAssetTranscript(asset, activeLanguage);
      } catch (err) {
        console.error("Failed to poll transcription status", err);
      }
    }, 8000);
    return () => window.clearInterval(id);
  }, [assetId, transcriptionStatus, applyAssetTranscript, activeLanguage]);

  return {
    videoUrl,
    transcription,
    framingJob,
    activeRenderJobId,
    loading,
    error,
  };
}
