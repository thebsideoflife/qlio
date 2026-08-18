import { useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { Loader2, RotateCcw } from "lucide-react";
import type { RootState } from "@/store/store";
import {
  applyTranslatedCaptionLanguage,
  setActiveCaptionLanguage,
} from "@/store/editorSlice";
import {
  getAsset,
  translateProjectCaptions,
  waitForCaptionTranslation,
} from "@/services/api";
import {
  TRANSLATE_TARGETS,
  detectedOriginalLanguage,
  isOriginalCaptionLanguage,
  parseTranscriptPayload,
  type TranslateTarget,
} from "@/lib/transcript";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function friendlyTranslateError(raw: string): string {
  if (/length mismatch/i.test(raw)) {
    return "Translation couldn’t keep every caption line. Try again.";
  }
  if (/target language is the original/i.test(raw)) {
    return "Captions are already in that language.";
  }
  if (/original transcript is not ready|transcription.*pending/i.test(raw)) {
    return "The original transcript is still being prepared.";
  }
  return raw;
}

async function loadTranslation(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load translated captions (${response.status})`);
  }
  const lines = parseTranscriptPayload(await response.json()).lines;
  if (lines.length === 0) {
    throw new Error("Translated captions are empty");
  }
  return lines;
}

export function CaptionLanguageToggle() {
  const dispatch = useDispatch();
  const projectId = useSelector((state: RootState) => state.editor.projectId);
  const assetId = useSelector((state: RootState) => state.editor.assetId);
  const activeLanguage = useSelector(
    (state: RootState) => state.editor.captionSettings.activeLanguage,
  );
  const originalLanguage = useSelector(
    (state: RootState) => state.editor.originalLanguage,
  );
  const transcriptionStatus = useSelector(
    (state: RootState) => state.editor.transcriptionStatus,
  );
  const transcriptionVersion = useSelector(
    (state: RootState) => state.editor.transcriptionVersion,
  );
  const translations = useSelector(
    (state: RootState) => state.editor.translations,
  );
  const [translatingTo, setTranslatingTo] =
    useState<TranslateTarget | null>(null);
  const [failedTarget, setFailedTarget] = useState<TranslateTarget | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sourceLanguage = detectedOriginalLanguage(originalLanguage);
  const showingOriginal = isOriginalCaptionLanguage(
    activeLanguage,
    originalLanguage,
  );
  const selected =
    !showingOriginal && (activeLanguage === "en" || activeLanguage === "es")
      ? activeLanguage
      : null;
  const translationTargets = TRANSLATE_TARGETS.filter(
    (language) => language !== sourceLanguage,
  );

  const switchToOriginal = () => {
    if (showingOriginal || translatingTo) return;
    setError(null);
    setFailedTarget(null);
    dispatch(setActiveCaptionLanguage({ language: "original" }));
  };

  const switchLanguage = async (target: TranslateTarget) => {
    if (target === selected || translatingTo) return;
    setError(null);
    setFailedTarget(null);

    if (target === sourceLanguage) {
      dispatch(setActiveCaptionLanguage({ language: target }));
      return;
    }
    if (!projectId || !assetId) {
      setError("The project is still loading.");
      setFailedTarget(target);
      return;
    }
    if (transcriptionStatus !== "ready") {
      setError("The original transcript is still being prepared.");
      setFailedTarget(target);
      return;
    }

    setTranslatingTo(target);
    try {
      let url = translations[target];
      let lines;
      let loadedVersion = transcriptionVersion;

      if (typeof url === "string" && url.startsWith("http")) {
        try {
          lines = await loadTranslation(url);
        } catch {
          const refreshed = await getAsset(assetId);
          const refreshedUrl = refreshed.translations?.[target];
          if (typeof refreshedUrl !== "string") {
            throw new Error("Stored translation is no longer available");
          }
          url = refreshedUrl;
          loadedVersion =
            refreshed.transcriptionVersion || loadedVersion;
          lines = await loadTranslation(url);
        }
      } else {
        const result = await translateProjectCaptions(projectId, target);
        loadedVersion = result.transcriptionVersion || loadedVersion;
        url =
          result.translationUrl ||
          (await waitForCaptionTranslation(assetId, target));
        lines = await loadTranslation(url);
      }

      dispatch(
        applyTranslatedCaptionLanguage({
          language: target,
          lines,
          translationUrl: url,
          transcriptionVersion: loadedVersion,
        }),
      );
    } catch (err) {
      const axiosError = err as { response?: { data?: { error?: string } } };
      setError(
        friendlyTranslateError(
          axiosError.response?.data?.error ||
            (err instanceof Error ? err.message : "Translation failed"),
        ),
      );
      setFailedTarget(target);
    } finally {
      setTranslatingTo(null);
    }
  };

  return (
    <div className="space-y-2.5">
      <div
        className={cn(
          "grid rounded-lg border-2 border-border bg-background p-1",
          translationTargets.length === 2 ? "grid-cols-3" : "grid-cols-2",
        )}
        aria-label="Caption language"
      >
        <button
          type="button"
          aria-pressed={showingOriginal}
          disabled={translatingTo !== null || transcriptionStatus === "pending"}
          onClick={switchToOriginal}
          className={cn(
            "flex h-9 items-center justify-center rounded-md text-sm font-bold transition-colors",
            showingOriginal
              ? "bg-blue-600 text-white shadow-sm"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          Original
        </button>
        {translationTargets.map((language) => {
          const active = selected === language;
          const loading = translatingTo === language;
          return (
            <button
              key={language}
              type="button"
              aria-pressed={active}
              disabled={translatingTo !== null || transcriptionStatus === "pending"}
              onClick={() => void switchLanguage(language)}
              className={cn(
                "flex h-9 items-center justify-center gap-1.5 rounded-md text-sm font-bold transition-colors",
                active
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
                "disabled:cursor-not-allowed disabled:opacity-60",
              )}
            >
              {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {language === "en" ? "English" : "Español"}
            </button>
          );
        })}
      </div>

      {translatingTo && (
        <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Translating the full video…
        </p>
      )}
      {error && (
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-medium text-red-500">{error}</p>
          {failedTarget && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 gap-1 px-2 text-xs"
              onClick={() => void switchLanguage(failedTarget)}
            >
              <RotateCcw className="h-3 w-3" />
              Retry
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
