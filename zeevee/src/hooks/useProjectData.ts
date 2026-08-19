import { useState, useEffect, useCallback } from "react";
import { useDispatch, useSelector } from "react-redux";
import type { RootState } from "@/store/store";
import {
  setSegments,
  setProjectMetadata,
  setTranscriptWords,
  setCaptionSettings,
  setCaptionLanguageMeta,
  setActiveCaptionLanguage,
  restoreActiveCaptionLanguage,
  setGlobalFraming,
  setLastSegmentRenders,
  setSegmentMetadata,
  setProjectThumbnailUrl,
  setGenerationMetadata,
  type GenerationMetadata,
} from "@/store/editorSlice";
import { getAsset, getProject, type FramingJob } from "@/services/api";
import { DEFAULT_CAPTION_SETTINGS, DEFAULT_GLOBAL_FRAMING } from "@/remotion/types";
import type {
  CaptionLine,
  CaptionWord,
  GlobalFramingSettings,
} from "@/remotion/types";
import {
  detectedOriginalLanguage,
  normalizeLanguageCode,
  orderedOriginalTranscriptUrls,
  parseTranscriptPayload,
} from "@/lib/transcript";

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
      assetId?: string;
      transcriptionUrl?: string;
      transcriptionCandidates?: string[];
      transcriptionVersion?: string;
      originalLanguage?: string;
      transcriptionStatus?: "pending" | "ready" | "failed";
      translations?: Record<string, string>;
    }, displayLanguage?: string) => {
      const status = asset.transcriptionStatus || (asset.transcriptionUrl ? "ready" : null);
      const translations = asset.translations || {};
      const originalTranscriptUrls = orderedOriginalTranscriptUrls(asset);

      if (originalTranscriptUrls.length === 0) {
        dispatch(
          setCaptionLanguageMeta({
            originalLanguage: asset.originalLanguage || null,
            transcriptionVersion: asset.transcriptionVersion || null,
            transcriptionStatus: status,
            translations,
          }),
        );
        setTranscription([]);
        dispatch(setTranscriptWords([]));
        return;
      }

      let transcriptResponse: Response | null = null;
      for (const url of originalTranscriptUrls) {
        try {
          const response = await fetch(url, { cache: "no-store" });
          if (response.ok) {
            transcriptResponse = response;
            break;
          }
          console.warn(
            `[captions] Original transcript candidate failed (${response.status})`,
          );
        } catch (error) {
          console.warn("[captions] Original transcript candidate failed", error);
        }
      }
      if (!transcriptResponse) {
        throw new Error("Could not load any original transcript candidate");
      }
      const data = await transcriptResponse.json();
      const parsed = parseTranscriptPayload(data);
      const assetLanguage = normalizeLanguageCode(asset.originalLanguage);
      const parsedLanguage = normalizeLanguageCode(parsed.language);
      const originalLanguage =
        detectedOriginalLanguage(assetLanguage) ||
        detectedOriginalLanguage(parsedLanguage);
      dispatch(
        setCaptionLanguageMeta({
          originalLanguage,
          transcriptionVersion: asset.transcriptionVersion || null,
          transcriptionStatus: status,
          translations,
        }),
      );
      const words = parsed.words;
      setTranscription(words);
      dispatch(setTranscriptWords(words));

      const requestedLanguage =
        displayLanguage === "original"
          ? originalLanguage
          : displayLanguage || originalLanguage;
      const displayLang = requestedLanguage
        ? normalizeLanguageCode(requestedLanguage)
        : null;
      if (
        displayLang &&
        displayLang !== originalLanguage
      ) {
        let translationUrl = translations[displayLang];
        let lines: CaptionLine[] = [];
        try {
          if (!translationUrl) {
            throw new Error("Saved translation is no longer available");
          }
          let translated = await fetch(translationUrl);
          if (!translated.ok && asset.assetId) {
            const refreshed = await getAsset(asset.assetId);
            translationUrl = refreshed.translations?.[displayLang];
            if (typeof translationUrl !== "string") {
              throw new Error("Saved translation is no longer available");
            }
            translated = await fetch(translationUrl);
            dispatch(
              setCaptionLanguageMeta({
                originalLanguage,
                transcriptionVersion:
                  refreshed.transcriptionVersion ||
                  asset.transcriptionVersion ||
                  null,
                transcriptionStatus: status,
                translations: {
                  ...translations,
                  [displayLang]: translationUrl,
                },
              }),
            );
          }
          if (!translated.ok) {
            throw new Error(
              `Could not load translated captions (${translated.status})`,
            );
          }
          lines = parseTranscriptPayload(await translated.json()).lines;
          if (lines.length === 0) {
            throw new Error("Saved translation is empty");
          }
        } catch (err) {
          console.warn("Falling back to the source transcript", err);
        }

        if (lines.length > 0) {
          dispatch(
            restoreActiveCaptionLanguage({
              language: displayLang,
              lines,
            }),
          );
          return;
        }
        dispatch(
          setActiveCaptionLanguage({
            language: originalLanguage || "original",
          }),
        );
        return;
      }
      dispatch(
        restoreActiveCaptionLanguage({
          language: originalLanguage || "original",
        }),
      );
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
