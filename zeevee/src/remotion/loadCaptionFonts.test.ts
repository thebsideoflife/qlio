import {
  CAPTION_FONT_OPTIONS,
  captionFontFamily,
  loadCaptionFont,
} from "./loadCaptionFonts";

const families = new Set<string>();
for (const option of CAPTION_FONT_OPTIONS) {
  const resolved = captionFontFamily(option.value);
  const loaded = loadCaptionFont(option.value);
  if (loaded.fontFamily !== resolved) {
    throw new Error(`${option.label} resolves to ${resolved} but loads ${loaded.fontFamily}`);
  }
  if (loaded.fontFamily === "Inter" && option.label !== "Inter") {
    throw new Error(`${option.label} silently falls back to Inter`);
  }
  families.add(loaded.fontFamily);
}

if (!families.has("Playfair Display") || families.size !== 17) {
  throw new Error("Caption picker and render font registry are out of sync");
}

console.log("caption font registry: all picker options have a renderable face");
