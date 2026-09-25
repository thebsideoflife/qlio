/** Fonts used by both the editor and the Lambda composition.
 * Load only the selected face, but block Remotion until it is available.
 * System fonts differ between a producer's computer and Lambda, so legacy
 * Arial/Georgia/Times/Comic Sans selections use Google equivalents.
 */
import { loadFont as loadArimo } from "@remotion/google-fonts/Arimo";
import { loadFont as loadBebasNeue } from "@remotion/google-fonts/BebasNeue";
import { loadFont as loadComicNeue } from "@remotion/google-fonts/ComicNeue";
import { loadFont as loadCourierPrime } from "@remotion/google-fonts/CourierPrime";
import { loadFont as loadDMSans } from "@remotion/google-fonts/DMSans";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadMontserrat } from "@remotion/google-fonts/Montserrat";
import { loadFont as loadOswald } from "@remotion/google-fonts/Oswald";
import { loadFont as loadPlayfairDisplay } from "@remotion/google-fonts/PlayfairDisplay";
import { loadFont as loadPoppins } from "@remotion/google-fonts/Poppins";
import { loadFont as loadRobotoCondensed } from "@remotion/google-fonts/RobotoCondensed";
import { loadFont as loadRobotoMono } from "@remotion/google-fonts/RobotoMono";
import { loadFont as loadSanchez } from "@remotion/google-fonts/Sanchez";
import { loadFont as loadSourceCodePro } from "@remotion/google-fonts/SourceCodePro";
import { loadFont as loadSpaceGrotesk } from "@remotion/google-fonts/SpaceGrotesk";
import { loadFont as loadStardosStencil } from "@remotion/google-fonts/StardosStencil";
import { loadFont as loadTinos } from "@remotion/google-fonts/Tinos";

export const SANCHEZ_FONT_FAMILY = "Sanchez";
export const STARDOS_STENCIL_FONT_FAMILY = "Stardos Stencil";

/** The picker and renderer use one registry so no selectable font can be omitted. */
export const CAPTION_FONT_OPTIONS = [
  { value: "Arial, sans-serif", label: "Arial style (Arimo)", weight: "700" },
  { value: "'Bebas Neue', sans-serif", label: "Bebas Neue", weight: "400" },
  { value: "'Comic Sans MS', cursive", label: "Comic Sans style (Comic Neue)", weight: "400" },
  { value: "'Courier Prime', 'Courier New', monospace", label: "Courier Prime", weight: "400" },
  { value: "'DM Sans', sans-serif", label: "DM Sans", weight: "700" },
  { value: "Georgia, serif", label: "Georgia style (Tinos)", weight: "700" },
  { value: "Inter, system-ui, sans-serif", label: "Inter", weight: "600" },
  { value: "'Montserrat', sans-serif", label: "Montserrat", weight: "800" },
  { value: "'Oswald', sans-serif", label: "Oswald", weight: "700" },
  { value: "'Playfair Display', serif", label: "Playfair Display", weight: "700" },
  { value: "'Poppins', sans-serif", label: "Poppins", weight: "700" },
  { value: "'Roboto Condensed', sans-serif", label: "Roboto Condensed", weight: "700" },
  { value: "'Roboto Mono', monospace", label: "Roboto Mono", weight: "400" },
  { value: SANCHEZ_FONT_FAMILY, label: "Sanchez", weight: "400" },
  { value: "'Source Code Pro', monospace", label: "Source Code", weight: "600" },
  { value: "'Space Grotesk', sans-serif", label: "Space Grotesk", weight: "700" },
  { value: STARDOS_STENCIL_FONT_FAMILY, label: "Stardos Stencil", weight: "400" },
  { value: "'Times New Roman', Times, serif", label: "Times style (Tinos)", weight: "400" },
] as const;

type LoadedFont = { fontFamily: string; waitUntilDone: () => Promise<void> };
const loaded = new Map<string, LoadedFont>();
const ready = new Set<string>();

export function isCaptionFontReady(family: string): boolean {
  return ready.has(family);
}

/** Resolve persisted CSS values, including older projects, to one web font. */
export function captionFontFamily(value: string): string {
  const name = value.split(",")[0].trim().replace(/^['"]|['"]$/g, "");
  switch (name) {
    case "Arial": return "Arimo";
    case "Georgia":
    case "Times New Roman": return "Tinos";
    case "Comic Sans MS": return "Comic Neue";
    case "Bebas Neue":
    case "Courier Prime":
    case "DM Sans":
    case "Inter":
    case "Montserrat":
    case "Oswald":
    case "Playfair Display":
    case "Poppins":
    case "Roboto Condensed":
    case "Roboto Mono":
    case "Sanchez":
    case "Source Code Pro":
    case "Space Grotesk":
    case "Stardos Stencil":
    case "Arimo":
    case "Tinos":
    case "Comic Neue": return name;
    default: return "Inter";
  }
}

export function loadCaptionFont(value: string): LoadedFont {
  const family = captionFontFamily(value);
  const existing = loaded.get(family);
  if (existing) return existing;

  // One normal face per picker option. Include every published Unicode subset
  // so translated captions can use the same glyphs in editor and export.
  const font: LoadedFont = (() => {
    switch (family) {
      case "Arimo": return loadArimo("normal", { weights: ["700"] });
      case "Bebas Neue": return loadBebasNeue("normal", { weights: ["400"] });
      case "Comic Neue": return loadComicNeue("normal", { weights: ["400"] });
      case "Courier Prime": return loadCourierPrime("normal", { weights: ["400"] });
      case "DM Sans": return loadDMSans("normal", { weights: ["700"] });
      case "Montserrat": return loadMontserrat("normal", { weights: ["800"] });
      case "Oswald": return loadOswald("normal", { weights: ["700"] });
      case "Playfair Display": return loadPlayfairDisplay("normal", { weights: ["700"] });
      case "Poppins": return loadPoppins("normal", { weights: ["700"] });
      case "Roboto Condensed": return loadRobotoCondensed("normal", { weights: ["700"] });
      case "Roboto Mono": return loadRobotoMono("normal", { weights: ["400"] });
      case "Sanchez": return loadSanchez("normal", { weights: ["400"] });
      case "Source Code Pro": return loadSourceCodePro("normal", { weights: ["600"] });
      case "Space Grotesk": return loadSpaceGrotesk("normal", { weights: ["700"] });
      case "Stardos Stencil": return loadStardosStencil("normal", { weights: ["400"] });
      case "Tinos": return loadTinos("normal", { weights: ["400", "700"] });
      default: return loadInter("normal", { weights: ["600"] });
    }
  })();
  const done = font.waitUntilDone().then(() => {
    ready.add(family);
  });
  // The renderer's delayRender handle will time out on a failed fetch. In the
  // editor, the caption stays hidden instead of showing a different font.
  done.catch((error) => console.error(`Could not load caption font ${family}:`, error));
  const result = { fontFamily: font.fontFamily, waitUntilDone: () => done };
  loaded.set(family, result);
  return result;
}
