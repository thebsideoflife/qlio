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

/**
 * Content-aboutness categories the IQ agent may assign. Mirrors
 * IAB_CONTENT_TOPICS on the backend.
 */
export const IAB_TOPIC_IDS = new Set([
  // Tier 1
  "150", "1", "42", "52", "123", "380", "381", "132", "JLBCU7", "8VZQHL",
  "186", "201", "210", "223", "239", "1KXCLD", "274", "383", "286", "163",
  "391", "422", "386", "432", "441", "453", "464", "v9i3On", "473", "483",
  "552", "596", "653", "680", "389",
  // Attractions
  "179", "181", "153", "155", "158", "159", "160", "177", "178", "151",
  // Food & Drink
  "211", "215", "216", "217", "218", "220", "221", "222", "212", "213", "214",
  // Travel
  "655", "663", "664",
  // Entertainment / Fine Art / Pop Culture
  "324", "338", "640", "203", "204", "206", "207", "208", "209", "440", "438",
  "437", "162", "185",
  // Family / life events / health
  "187", "188", "189", "191", "192", "165", "170", "171", "172", "225", "229",
  "232", "287",
  // Work / money / society
  "53", "80", "90", "125", "127", "387", "388", "8YPBBL",
  // Craft / home / outdoors
  "240", "248", "261", "264", "273", "243", "244", "275", "280", "283", "276",
  // Belief / science / nature
  "455", "456", "458", "459", "460", "461", "462", "465", "467", "469", "470",
  "472", "390",
  // Style / tech / animals
  "553", "574", "577", "578", "595", "597", "599", "632", "638", "424", "425",
  "427", "430",
  // Sport
  "484", "518", "545", "547", "485", "492", "498", "511", "512", "514", "515",
  "520", "521", "525", "530", "531", "533", "537", "539", "540",
  // Sensitive
  "XtODT3", "I4GWl6", "Z7rJBM", "pg0WhF", "j9PaO9",
]);

export interface IabFieldOptions {
  formFactor?: boolean;
  genres?: boolean;
  topics?: boolean;
}

export function iabHasGenre(cat: string[] | undefined): boolean {
  return !!cat?.some((id) => IAB_GENRE_IDS.has(id));
}

export function iabHasFormFactor(cat: string[] | undefined): boolean {
  return !!cat?.some((id) => IAB_FORM_FACTOR_IDS.has(id));
}

export function iabHasTopic(cat: string[] | undefined): boolean {
  return !!cat?.some((id) => IAB_TOPIC_IDS.has(id));
}

/** Filter cached IAB tags down to currently-enabled field types for preview/export. */
export function filterIabTagsForFields<
  T extends { cat: string[]; labels?: string[]; cattax: 7 },
>(iab: T | undefined, fields?: IabFieldOptions): T | undefined {
  if (!iab?.cat?.length) return undefined;
  const includeGenres = fields?.genres !== false;
  const includeFormFactor = fields?.formFactor !== false;
  const includeTopics = fields?.topics !== false;
  const cat: string[] = [];
  const labels: string[] = [];
  for (let i = 0; i < iab.cat.length; i++) {
    const id = iab.cat[i];
    const isGenre = IAB_GENRE_IDS.has(id);
    const isForm = IAB_FORM_FACTOR_IDS.has(id);
    const isTopic = IAB_TOPIC_IDS.has(id);
    if (isGenre && !includeGenres) continue;
    if (isForm && !includeFormFactor) continue;
    if (isTopic && !includeTopics) continue;
    if (!isGenre && !isForm && !isTopic) continue;
    cat.push(id);
    labels.push(iab.labels?.[i] ?? id);
  }
  if (cat.length === 0) return undefined;
  return {
    ...iab,
    cat,
    ...(labels.length ? { labels } : { labels: undefined }),
  };
}
