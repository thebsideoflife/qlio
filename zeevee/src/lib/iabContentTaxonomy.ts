/**
 * Frontend mirror of curated IAB Content Taxonomy 3.0 IDs.
 * Keep in sync with backend/src/services/iab-content-taxonomy.ts.
 */

export const IAB_GENRE_IDS = new Set([
  "325",
  "641",
  "44",
  "646",
  "332",
  "647",
  "648",
  "645",
  "335",
  "EZWB7V",
  "649",
  "336",
  "TIFQA5",
  "650",
  "156",
  "331",
  "VKIV56",
  "651",
  "326",
  "652",
  "642",
  "643",
  "A0AH3G",
  "KHPC5A",
  "KHPC6A",
  "51",
]);

export const IAB_FORM_FACTOR_IDS = new Set([
  "1028",
  "C2UKBG",
  "3927X6",
  "Y2MK22",
  "O3EQZQ",
  "20L2OV",
]);

export interface IabFieldOptions {
  formFactor?: boolean;
  genres?: boolean;
}

export function iabHasGenre(cat: string[] | undefined): boolean {
  return !!cat?.some((id) => IAB_GENRE_IDS.has(id));
}

export function iabHasFormFactor(cat: string[] | undefined): boolean {
  return !!cat?.some((id) => IAB_FORM_FACTOR_IDS.has(id));
}

/** Filter cached IAB tags down to currently-enabled field types for preview/export. */
export function filterIabTagsForFields<
  T extends { cat: string[]; labels?: string[]; cattax: 7 },
>(iab: T | undefined, fields?: IabFieldOptions): T | undefined {
  if (!iab?.cat?.length) return undefined;
  const includeGenres = fields?.genres !== false;
  const includeFormFactor = fields?.formFactor !== false;
  const cat: string[] = [];
  const labels: string[] = [];
  for (let i = 0; i < iab.cat.length; i++) {
    const id = iab.cat[i];
    const isGenre = IAB_GENRE_IDS.has(id);
    const isForm = IAB_FORM_FACTOR_IDS.has(id);
    if (isGenre && !includeGenres) continue;
    if (isForm && !includeFormFactor) continue;
    if (!isGenre && !isForm) continue;
    cat.push(id);
    if (iab.labels?.[i]) labels.push(iab.labels[i]);
  }
  if (cat.length === 0) return undefined;
  return {
    ...iab,
    cat,
    ...(labels.length ? { labels } : { labels: undefined }),
  };
}
