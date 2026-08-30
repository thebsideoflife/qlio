/**
 * Caption fonts that must be available in both the editor preview and
 * Remotion Lambda renders. Prefer `@remotion/google-fonts` so renders
 * block until the font is ready (no fallback flash / missing glyphs).
 *
 * Call loadFont() with no weight/style subset so every face Google
 * publishes is registered. Sanchez only ships 400 (regular + italic);
 * Stardos Stencil ships 400 and 700.
 */
import { loadFont as loadSanchez } from "@remotion/google-fonts/Sanchez";
import { loadFont as loadStardosStencil } from "@remotion/google-fonts/StardosStencil";

const sanchez = loadSanchez();
const stardos = loadStardosStencil();

/** CSS font-family strings returned by Remotion's loader. */
export const SANCHEZ_FONT_FAMILY = sanchez.fontFamily;
export const STARDOS_STENCIL_FONT_FAMILY = stardos.fontFamily;
