/**
 * Curated IAB Content Taxonomy 3.0 IDs for Qlio export metadata.
 * @see https://github.com/InteractiveAdvertisingBureau/Taxonomies
 */

export const IAB_CONTENT_TAXONOMY_VERSION = 7 as const; // OpenRTB cattax for Content Taxonomy 3.0

export interface IabCategoryRef {
  id: string;
  name: string;
}

/** Entertainment genre aboutness categories (Tier 2 under Genres). */
export const IAB_ENTERTAINMENT_GENRES: readonly IabCategoryRef[] = [
  { id: "325", name: "Action/Adventure" },
  { id: "641", name: "Animation & Anime" },
  { id: "44", name: "Biographies" },
  { id: "646", name: "Comedy" },
  { id: "332", name: "Documentary" },
  { id: "647", name: "Drama" },
  { id: "648", name: "Factual" },
  { id: "645", name: "Family/Children" },
  { id: "335", name: "Fantasy" },
  { id: "EZWB7V", name: "History" },
  { id: "649", name: "Holiday" },
  { id: "336", name: "Horror" },
  { id: "TIFQA5", name: "Lifestyle" },
  { id: "650", name: "Music Video" },
  { id: "156", name: "Musicals" },
  { id: "331", name: "Mystery" },
  { id: "VKIV56", name: "Nature" },
  { id: "651", name: "Reality TV" },
  { id: "326", name: "Romance" },
  { id: "652", name: "Science Fiction" },
  { id: "642", name: "Soap Opera" },
  { id: "643", name: "Special Interest (Indie/Art House)" },
  { id: "A0AH3G", name: "Talk Show" },
  { id: "KHPC5A", name: "True Crime" },
  { id: "KHPC6A", name: "Western" },
  { id: "51", name: "Young Adult" },
] as const;

/** Content Form Factor vector values for video. */
export const IAB_VIDEO_FORM_FACTORS: readonly IabCategoryRef[] = [
  { id: "1028", name: "Video" },
  { id: "C2UKBG", name: "Show" },
  { id: "3927X6", name: "Episodic Show" },
  { id: "Y2MK22", name: "Event" },
  { id: "O3EQZQ", name: "Clip" },
  { id: "20L2OV", name: "Movie" },
] as const;

const ALLOWED_BY_ID: ReadonlyMap<string, string> = new Map(
  [...IAB_ENTERTAINMENT_GENRES, ...IAB_VIDEO_FORM_FACTORS].map((c) => [
    c.id,
    c.name,
  ]),
);

export interface IabTaxonomyTags {
  cattax: typeof IAB_CONTENT_TAXONOMY_VERSION;
  cat: string[];
  labels?: string[];
}

export function iabAllowlistPromptBlock(): string {
  const genres = IAB_ENTERTAINMENT_GENRES.map(
    (c) => `${c.id}=${c.name}`,
  ).join("; ");
  const forms = IAB_VIDEO_FORM_FACTORS.map((c) => `${c.id}=${c.name}`).join(
    "; ",
  );
  return `IAB Content Taxonomy 3.0 — pick IDs only from these lists.
Genres (pick 1-3): ${genres}
Form factors (pick exactly 1; prefer Clip for short scenes): ${forms}`;
}

/** Keep only known IDs; rebuild labels from the allowlist. */
export function normalizeIabTags(
  catIds: unknown,
  _labels?: unknown,
): IabTaxonomyTags | undefined {
  if (!Array.isArray(catIds)) return undefined;
  const cat: string[] = [];
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const raw of catIds) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    const name = ALLOWED_BY_ID.get(id);
    if (!name) continue;
    seen.add(id);
    cat.push(id);
    labels.push(name);
  }
  if (cat.length === 0) return undefined;
  return {
    cattax: IAB_CONTENT_TAXONOMY_VERSION,
    cat,
    labels,
  };
}
