import { useState, useRef } from "react";
import { useSelector, useDispatch } from "react-redux";
import type { RootState } from "@/store/store";
import {
  setCaptionsEnabled,
  setCaptionLanguageMeta,
  updateCaptionStyle,
  updateCaptionPosition,
} from "@/store/editorSlice";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { SNAP_POSITIONS } from "@/remotion/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Upload, Palette, X, Loader2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  SANCHEZ_FONT_FAMILY,
  STARDOS_STENCIL_FONT_FAMILY,
} from "@/remotion/loadCaptionFonts";
import { getAsset, retryAssetTranscription } from "@/services/api";
import { CaptionLanguageToggle } from "@/components/editor/CaptionLanguageToggle";

const FONTS = [
  { value: "Arial, sans-serif", label: "Arial", weight: "700" },
  { value: "'Bebas Neue', sans-serif", label: "Bebas Neue", weight: "400" },
  { value: "'Comic Sans MS', cursive", label: "Comic Sans", weight: "400" },
  {
    value: "'Courier Prime', 'Courier New', monospace",
    label: "Courier Prime",
    weight: "400",
  },
  { value: "'DM Sans', sans-serif", label: "DM Sans", weight: "700" },
  { value: "Georgia, serif", label: "Georgia", weight: "700" },
  { value: "Inter, system-ui, sans-serif", label: "Inter", weight: "600" },
  { value: "'Montserrat', sans-serif", label: "Montserrat", weight: "800" },
  { value: "'Oswald', sans-serif", label: "Oswald", weight: "700" },
  {
    value: "'Playfair Display', serif",
    label: "Playfair Display",
    weight: "700",
  },
  { value: "'Poppins', sans-serif", label: "Poppins", weight: "700" },
  {
    value: "'Roboto Condensed', sans-serif",
    label: "Roboto Condensed",
    weight: "700",
  },
  { value: "'Roboto Mono', monospace", label: "Roboto Mono", weight: "400" },
  { value: SANCHEZ_FONT_FAMILY, label: "Sanchez", weight: "400" },
  {
    value: "'Source Code Pro', monospace",
    label: "Source Code",
    weight: "600",
  },
  {
    value: "'Space Grotesk', sans-serif",
    label: "Space Grotesk",
    weight: "700",
  },
  {
    value: STARDOS_STENCIL_FONT_FAMILY,
    label: "Stardos Stencil",
    weight: "400",
  },
  {
    value: "'Times New Roman', Times, serif",
    label: "Times New Roman",
    weight: "400",
  },
];

const SIZES = [
  { value: "1", label: "XS" },
  { value: "2", label: "S" },
  { value: "3", label: "M" },
  { value: "4", label: "L" },
];

export function CaptionEditor() {
  const dispatch = useDispatch();
  const [brandColors, setBrandColors] = useState<string[]>([]);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { enabled, style } = useSelector(
    (state: RootState) => state.editor.captionSettings,
  );
  const captionCount = useSelector(
    (state: RootState) => state.editor.captions.length,
  );
  const assetId = useSelector((state: RootState) => state.editor.assetId);
  const originalLanguage = useSelector(
    (state: RootState) => state.editor.originalLanguage,
  );
  const transcriptionStatus = useSelector(
    (state: RootState) => state.editor.transcriptionStatus,
  );
  const translations = useSelector(
    (state: RootState) => state.editor.translations,
  );

  const textColor = style.color || "#ffffff";
  const highlightColor = style.highlightColor || "#fbbf24";
  const backgroundColor = style.backgroundColor || "rgba(0,0,0,0.5)";

  // Extract dominant colors from an uploaded image using canvas
  const handleBrandImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const size = 64; // downscale for speed
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.drawImage(img, 0, 0, size, size);
      const imageData = ctx.getImageData(0, 0, size, size).data;

      // Simple color quantization: bucket pixels into 16-step bins
      const buckets = new Map<string, number>();
      for (let i = 0; i < imageData.length; i += 4) {
        const r = Math.round(imageData[i] / 32) * 32;
        const g = Math.round(imageData[i + 1] / 32) * 32;
        const b = Math.round(imageData[i + 2] / 32) * 32;
        const a = imageData[i + 3];
        if (a < 128) continue; // skip transparent
        // Skip near-white and near-black
        const brightness = (r + g + b) / 3;
        if (brightness > 240 || brightness < 15) continue;
        const key = `${r},${g},${b}`;
        buckets.set(key, (buckets.get(key) || 0) + 1);
      }

      // Sort by frequency, take top 5
      const sorted = [...buckets.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([key]) => {
          const [r, g, b] = key.split(",").map(Number);
          return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
        });

      setBrandColors(sorted);
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);

    // Reset input so same file can be re-uploaded
    e.target.value = "";
  };

  const handleRetryTranscription = async () => {
    if (!assetId) return;
    setTranslateError(null);
    try {
      await retryAssetTranscription(assetId);
      dispatch(
        setCaptionLanguageMeta({
          originalLanguage,
          transcriptionStatus: "pending",
          translations,
        }),
      );
    } catch (err) {
      const responseStatus = (
        err as { response?: { status?: number } }
      ).response?.status;
      let authoritativeStatus =
        responseStatus === 409 ? "pending" : transcriptionStatus;
      let authoritativeLanguage = originalLanguage;
      let authoritativeTranslations = translations;
      try {
        const asset = await getAsset(assetId);
        authoritativeStatus =
          asset.transcriptionStatus || authoritativeStatus;
        authoritativeLanguage =
          asset.originalLanguage || authoritativeLanguage;
        authoritativeTranslations =
          asset.translations || authoritativeTranslations;
      } catch {
        // Keep the last known state when the status refresh also fails.
      }
      dispatch(
        setCaptionLanguageMeta({
          originalLanguage: authoritativeLanguage,
          transcriptionStatus: authoritativeStatus,
          translations: authoritativeTranslations,
        }),
      );
      if (authoritativeStatus !== "pending") {
        setTranslateError(
          err instanceof Error ? err.message : "Could not restart transcription",
        );
      }
    }
  };

  return (
    <div className="p-5 space-y-5">
      {/* Toggle */}
      <div className="flex items-center justify-between p-4 bg-muted/40 rounded-xl border-2 border-border">
        <div className="space-y-1">
          <Label htmlFor="captions-toggle" className="font-bold">
            Show Captions
          </Label>
          {transcriptionStatus === "pending" ? (
            <Skeleton className="h-3 w-32 mt-1" />
          ) : captionCount > 0 ? (
            <p className="text-xs text-muted-foreground font-medium">
              {captionCount} lines from transcript
            </p>
          ) : null}
        </div>
        <Switch
          id="captions-toggle"
          checked={enabled}
          onCheckedChange={(v) => dispatch(setCaptionsEnabled(v))}
        />
      </div>

      <div className="space-y-3">
        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Language
        </Label>
        {transcriptionStatus === "pending" && (
          <p className="text-xs text-muted-foreground font-medium flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Transcribing original audio…
          </p>
        )}
        {transcriptionStatus === "failed" && (
          <div className="space-y-2">
            <p className="text-xs text-red-500 font-medium">
              Transcription failed.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="text-xs h-8"
              disabled={!assetId}
              onClick={() => void handleRetryTranscription()}
            >
              Retry transcription
            </Button>
          </div>
        )}
        {transcriptionStatus !== "failed" && <CaptionLanguageToggle />}
        {import.meta.env.DEV && transcriptionStatus === "ready" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-xs h-8"
            disabled={!assetId}
            onClick={() => void handleRetryTranscription()}
          >
            Re-transcribe
          </Button>
        )}
        {translateError && (
          <p className="text-xs text-red-500 font-medium">{translateError}</p>
        )}
      </div>

      {enabled && (
        <>
          {/* Position */}
          <div className="space-y-3">
            <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Position
            </Label>
            <div className="grid grid-cols-3 gap-2">
              {SNAP_POSITIONS.map((pos) => {
                const active =
                  Math.abs(style.position.x - pos.x) < 3 &&
                  Math.abs(style.position.y - pos.y) < 3;
                return (
                  <Button
                    key={pos.label}
                    variant={active ? "default" : "outline"}
                    size="sm"
                    className="text-xs h-9 font-semibold"
                    onClick={() =>
                      dispatch(updateCaptionPosition({ x: pos.x, y: pos.y }))
                    }
                  >
                    {pos.label}
                  </Button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground font-medium">
              Drag captions on video to reposition
            </p>
          </div>

          {/* Font & Size */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Font
              </Label>
              <Select
                value={style.fontFamily}
                onValueChange={(v) => {
                  const font = FONTS.find((f) => f.value === v);
                  dispatch(
                    updateCaptionStyle({
                      fontFamily: v,
                      fontWeight: font?.weight || "600",
                    }),
                  );
                }}
              >
                <SelectTrigger className="h-10 text-sm font-semibold border-2 border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FONTS.map((f) => (
                    <SelectItem
                      key={f.value}
                      value={f.value}
                      className="text-sm font-medium"
                    >
                      <span style={{ fontFamily: f.value }}>{f.label}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Size
              </Label>
              <Select
                value={String(Math.round(style.fontSize))}
                onValueChange={(v) =>
                  dispatch(updateCaptionStyle({ fontSize: Number(v) }))
                }
              >
                <SelectTrigger className="h-10 text-sm font-semibold border-2 border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SIZES.map((s) => (
                    <SelectItem
                      key={s.value}
                      value={s.value}
                      className="text-sm font-medium"
                    >
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Text Color */}
          <div className="space-y-3">
            <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Text Color
            </Label>
            <div className="flex items-center gap-3">
              <label className="relative cursor-pointer">
                <div
                  className="w-10 h-10 rounded-lg border-2 border-border shadow-sm"
                  style={{ backgroundColor: textColor }}
                />
                <input
                  type="color"
                  value={textColor}
                  onChange={(e) =>
                    dispatch(updateCaptionStyle({ color: e.target.value }))
                  }
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
              </label>
              <span className="text-xs font-mono text-muted-foreground">
                {textColor}
              </span>
            </div>
          </div>

          {/* Highlight Color */}
          <div className="space-y-3">
            <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Word Highlight
            </Label>
            <div className="flex items-center gap-3">
              <label className="relative cursor-pointer">
                <div
                  className={cn(
                    "w-10 h-10 rounded-lg border-2 border-border shadow-sm",
                    highlightColor === "none" &&
                      "bg-muted flex items-center justify-center",
                  )}
                  style={
                    highlightColor !== "none"
                      ? { backgroundColor: highlightColor }
                      : {}
                  }
                >
                  {highlightColor === "none" && (
                    <X className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
                {highlightColor !== "none" && (
                  <input
                    type="color"
                    value={highlightColor}
                    onChange={(e) =>
                      dispatch(
                        updateCaptionStyle({ highlightColor: e.target.value }),
                      )
                    }
                    className="absolute inset-0 opacity-0 cursor-pointer"
                  />
                )}
              </label>
              {highlightColor !== "none" ? (
                <span className="text-xs font-mono text-muted-foreground">
                  {highlightColor}
                </span>
              ) : (
                <span className="text-xs font-medium text-muted-foreground">
                  Off
                </span>
              )}
              <div className="flex gap-1.5">
                <Button
                  variant={highlightColor === "none" ? "default" : "outline"}
                  size="sm"
                  className="text-xs h-8 px-2"
                  onClick={() =>
                    dispatch(
                      updateCaptionStyle({
                        highlightColor:
                          highlightColor === "none" ? "#fbbf24" : "none",
                      }),
                    )
                  }
                >
                  {highlightColor === "none" ? "On" : "None"}
                </Button>
              </div>
            </div>
          </div>

          {/* Background */}
          <div className="space-y-3">
            <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Background
            </Label>
            <div className="flex items-center gap-3">
              <label className="relative cursor-pointer">
                <div
                  className="w-10 h-10 rounded-lg border-2 border-border shadow-sm"
                  style={{ backgroundColor }}
                />
                <input
                  type="color"
                  value={
                    backgroundColor === "transparent"
                      ? "#000000"
                      : backgroundColor.startsWith("rgba")
                        ? "#000000"
                        : backgroundColor
                  }
                  onChange={(e) =>
                    dispatch(
                      updateCaptionStyle({ backgroundColor: e.target.value }),
                    )
                  }
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
              </label>
              <div className="flex gap-1.5">
                {[
                  { value: "rgba(0,0,0,0.8)", label: "Dark" },
                  { value: "rgba(0,0,0,0.5)", label: "Semi" },
                  { value: "transparent", label: "None" },
                ].map((bg) => (
                  <Button
                    key={bg.value}
                    variant={
                      backgroundColor === bg.value ? "default" : "outline"
                    }
                    size="sm"
                    className="text-xs h-8 px-2"
                    onClick={() =>
                      dispatch(
                        updateCaptionStyle({ backgroundColor: bg.value }),
                      )
                    }
                  >
                    {bg.label}
                  </Button>
                ))}
              </div>
            </div>
          </div>

          {/* Brand Color Extraction */}
          <div className="space-y-3">
            <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              <Palette className="h-3.5 w-3.5 inline mr-1.5" />
              Brand Colors
            </Label>

            {brandColors.length > 0 ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  {brandColors.map((color, i) => (
                    <button
                      key={i}
                      className="w-9 h-9 rounded-lg border-2 border-border shadow-sm hover:scale-110 transition-transform"
                      style={{ backgroundColor: color }}
                      title={`Apply ${color} as text color`}
                      onClick={() => dispatch(updateCaptionStyle({ color }))}
                    />
                  ))}
                  <button
                    className="w-9 h-9 rounded-lg border-2 border-dashed border-border flex items-center justify-center text-muted-foreground hover:border-blue-400 transition-colors"
                    onClick={() => setBrandColors([])}
                    title="Clear brand colors"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Click a swatch to apply as text color
                </p>
              </div>
            ) : (
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleBrandImageUpload}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs h-9 gap-2"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="h-3.5 w-3.5" />
                  Upload image to extract colors
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
