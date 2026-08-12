/**
 * Caption fonts that must be available in both the editor preview and
 * Remotion Lambda renders. Prefer `@remotion/google-fonts` so renders
 * block until the font is ready (no fallback flash / missing glyphs).
 */
import { loadFont as loadStardosStencil } from "@remotion/google-fonts/StardosStencil";

const stardos = loadStardosStencil("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

/** CSS font-family string returned by Remotion's loader. */
export const STARDOS_STENCIL_FONT_FAMILY = stardos.fontFamily;
