import { useSelector, useDispatch } from "react-redux";
import type { RootState } from "@/store/store";
import {
  setCaptionsEnabled,
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

const FONTS = [
  { value: "Inter, system-ui, sans-serif", label: "Inter" },
  { value: "Arial, sans-serif", label: "Arial" },
  { value: "Georgia, serif", label: "Georgia" },
];

const SIZES = [
  { value: "3", label: "Small" },
  { value: "4", label: "Medium" },
  { value: "5", label: "Large" },
  { value: "6", label: "X-Large" },
];

const BACKGROUNDS = [
  { value: "rgba(0,0,0,0.8)", label: "Dark" },
  { value: "rgba(0,0,0,0.5)", label: "Semi" },
  { value: "transparent", label: "None" },
];

const HIGHLIGHT_COLORS = [
  { value: "#fbbf24", label: "Yellow" },
  { value: "#60a5fa", label: "Blue" },
  { value: "none", label: "No Animation" },
];

export function CaptionEditor() {
  const dispatch = useDispatch();

  const { enabled, style } = useSelector(
    (state: RootState) => state.editor.captionSettings
  );
  const captionCount = useSelector(
    (state: RootState) => state.editor.captions.length
  );

  const highlightColor = style.highlightColor || "#fbbf24";

  return (
    <div className="p-4 space-y-4">
      {/* Toggle */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="captions-toggle">Show Captions</Label>
          {captionCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {captionCount} lines from transcript
            </p>
          )}
        </div>
        <Switch
          id="captions-toggle"
          checked={enabled}
          onCheckedChange={(v) => dispatch(setCaptionsEnabled(v))}
        />
      </div>

      {enabled && (
        <>
          {/* Position */}
          <div className="space-y-2">
            <Label className="text-xs font-medium">Position</Label>
            <div className="grid grid-cols-3 gap-1.5">
              {SNAP_POSITIONS.map((pos) => {
                const active =
                  Math.abs(style.position.x - pos.x) < 3 &&
                  Math.abs(style.position.y - pos.y) < 3;
                return (
                  <Button
                    key={pos.label}
                    variant={active ? "secondary" : "outline"}
                    size="sm"
                    className="text-xs h-7"
                    onClick={() =>
                      dispatch(updateCaptionPosition({ x: pos.x, y: pos.y }))
                    }
                  >
                    {pos.label}
                  </Button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Drag captions on video to reposition
            </p>
          </div>

          {/* Font & Size */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Font</Label>
              <Select
                value={style.fontFamily}
                onValueChange={(v) =>
                  dispatch(updateCaptionStyle({ fontFamily: v }))
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FONTS.map((f) => (
                    <SelectItem
                      key={f.value}
                      value={f.value}
                      className="text-xs"
                    >
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Size</Label>
              <Select
                value={String(Math.round(style.fontSize))}
                onValueChange={(v) =>
                  dispatch(updateCaptionStyle({ fontSize: Number(v) }))
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SIZES.map((s) => (
                    <SelectItem
                      key={s.value}
                      value={s.value}
                      className="text-xs"
                    >
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Background */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Background</Label>
            <div className="flex gap-1.5">
              {BACKGROUNDS.map((bg) => (
                <Button
                  key={bg.value}
                  variant={
                    style.backgroundColor === bg.value ? "secondary" : "outline"
                  }
                  size="sm"
                  className="flex-1 h-7 text-xs"
                  onClick={() =>
                    dispatch(updateCaptionStyle({ backgroundColor: bg.value }))
                  }
                >
                  {bg.label}
                </Button>
              ))}
            </div>
          </div>

          {/* Highlight Color */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Word Highlight</Label>
            <div className="flex gap-1.5">
              {HIGHLIGHT_COLORS.map((color) => (
                <Button
                  key={color.value}
                  variant={
                    highlightColor === color.value ? "secondary" : "outline"
                  }
                  size="sm"
                  className="flex-1 h-7 text-xs"
                  onClick={() =>
                    dispatch(
                      updateCaptionStyle({ highlightColor: color.value })
                    )
                  }
                >
                  {color.label}
                </Button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
