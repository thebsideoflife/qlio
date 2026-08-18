import { useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { Loader2 } from "lucide-react";
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
import { cn } from "@/lib/utils";

const MAX_TRANSLATION_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function resolveTranslation(params: {
  projectId: string;
  assetId: string;
  target: TranslateTarget;
  translations: Record<string, string>;
  transcriptionVersion: string | null;
}) {
  let url = params.translations[params.target];
  let loadedVersion = params.transcriptionVersion;

  if (typeof url === "string" && url.startsWith("http")) {
    try {
      const lines = await loadTranslation(url);
      return { lines, url, loadedVersion };
    } catch {
      const refreshed = await getAsset(params.assetId);
      const refreshedUrl = refreshed.translations?.[params.target];
      if (typeof refreshedUrl !== "string") {
        throw new Error("Stored translation is no longer available");
      }
      url = refreshedUrl;
      loadedVersion = refreshed.transcriptionVersion || loadedVersion;
      const lines = await loadTranslation(url);
      return { lines, url, loadedVersion };
    }
  }

  const result = await translateProjectCaptions(params.projectId, params.target);
  loadedVersion = result.transcriptionVersion || loadedVersion;
  url =
    result.translationUrl ||
    (await waitForCaptionTranslation(params.assetId, params.target));
  const lines = await loadTranslation(url);
  return { lines, url, loadedVersion };
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
  const disabled =
    translatingTo !== null || transcriptionStatus === "pending";

  const switchToOriginal = () => {
    if (showingOriginal || translatingTo) return;
    dispatch(setActiveCaptionLanguage({ language: "original" }));
  };

  const switchLanguage = async (target: TranslateTarget) => {
    if (target === selected || translatingTo) return;

    if (target === sourceLanguage) {
      dispatch(setActiveCaptionLanguage({ language: target }));
      return;
    }
    if (!projectId || !assetId || transcriptionStatus !== "ready") return;

    setTranslatingTo(target);
    try {
      let lastError: unknown;
      for (let attempt = 1; attempt <= MAX_TRANSLATION_ATTEMPTS; attempt++) {
        try {
          const { lines, url, loadedVersion } = await resolveTranslation({
            projectId,
            assetId,
            target,
            translations,
            transcriptionVersion,
          });
          dispatch(
            applyTranslatedCaptionLanguage({
              language: target,
              lines,
              translationUrl: url,
              transcriptionVersion: loadedVersion,
            }),
          );
          return;
        } catch (err) {
          lastError = err;
          if (attempt < MAX_TRANSLATION_ATTEMPTS) {
            await sleep(400 * attempt);
          }
        }
      }
      throw lastError;
    } catch (err) {
      console.warn("[captions] translation failed after retries:", err);
      dispatch(setActiveCaptionLanguage({ language: "original" }));
    } finally {
      setTranslatingTo(null);
    }
  };

  return (
    <div className="space-y-2">
      <div
        className={cn(
          "inline-flex w-full rounded-lg bg-muted p-1",
          translationTargets.length === 2 ? "grid grid-cols-3" : "grid grid-cols-2",
        )}
        aria-label="Caption language"
      >
        <button
          type="button"
          aria-pressed={showingOriginal}
          disabled={disabled}
          onClick={switchToOriginal}
          className={cn(
            "h-8 rounded-md text-xs font-semibold transition-colors",
            showingOriginal
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
            disabled && "cursor-not-allowed opacity-60",
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
              disabled={disabled}
              onClick={() => void switchLanguage(language)}
              className={cn(
                "flex h-8 items-center justify-center gap-1 rounded-md text-xs font-semibold transition-colors",
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
                disabled && "cursor-not-allowed opacity-60",
              )}
            >
              {loading && <Loader2 className="h-3 w-3 animate-spin" />}
              {language === "en" ? "English" : "Español"}
            </button>
          );
        })}
      </div>

      {translatingTo && (
        <p className="text-[11px] text-muted-foreground">
          Translating captions…
        </p>
      )}
    </div>
  );
}
