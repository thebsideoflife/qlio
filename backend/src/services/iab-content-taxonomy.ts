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

/**
 * What the footage is *about*, as opposed to what shape it is (form factor) or
 * what kind of storytelling it is (genre). Tier 1 and the Tier 2 branches that
 * actually describe filmed content, taken verbatim from IAB Content Taxonomy
 * 3.0. The Tier 1 "Genres" node is deliberately absent: its children are the
 * genre vector above.
 */
export const IAB_CONTENT_TOPICS: readonly IabCategoryRef[] = [
  // --- Tier 1 ---------------------------------------------------------------
  { id: "150", name: "Attractions" },
  { id: "1", name: "Automotive" },
  { id: "42", name: "Books and Literature" },
  { id: "52", name: "Business and Finance" },
  { id: "123", name: "Careers" },
  { id: "380", name: "Crime" },
  { id: "381", name: "Disasters" },
  { id: "132", name: "Education" },
  { id: "JLBCU7", name: "Entertainment" },
  { id: "8VZQHL", name: "Events" },
  { id: "186", name: "Family and Relationships" },
  { id: "201", name: "Fine Art" },
  { id: "210", name: "Food & Drink" },
  { id: "223", name: "Healthy Living" },
  { id: "239", name: "Hobbies & Interests" },
  { id: "1KXCLD", name: "Holidays" },
  { id: "274", name: "Home & Garden" },
  { id: "383", name: "Law" },
  { id: "286", name: "Medical Health" },
  { id: "163", name: "Personal Celebrations & Life Events" },
  { id: "391", name: "Personal Finance" },
  { id: "422", name: "Pets" },
  { id: "386", name: "Politics" },
  { id: "432", name: "Pop Culture" },
  { id: "441", name: "Real Estate" },
  { id: "453", name: "Religion & Spirituality" },
  { id: "464", name: "Science" },
  { id: "v9i3On", name: "Sensitive Topics" },
  { id: "473", name: "Shopping" },
  { id: "483", name: "Sports" },
  { id: "552", name: "Style & Fashion" },
  { id: "596", name: "Technology & Computing" },
  { id: "653", name: "Travel" },
  { id: "680", name: "Video Gaming" },
  { id: "389", name: "War and Conflicts" },

  // --- Tier 2: Attractions --------------------------------------------------
  { id: "179", name: "Bars & Restaurants" },
  { id: "181", name: "Casinos & Gambling" },
  { id: "153", name: "Historic Site and Landmark Tours" },
  { id: "155", name: "Museums & Galleries" },
  { id: "158", name: "Nightclubs" },
  { id: "159", name: "Outdoor Activities" },
  { id: "160", name: "Parks & Nature" },
  { id: "177", name: "Theater Venues" },
  { id: "178", name: "Zoos & Aquariums" },
  { id: "151", name: "Amusement and Theme Parks" },

  // --- Tier 2: Food & Drink -------------------------------------------------
  { id: "211", name: "Alcoholic Beverages" },
  { id: "215", name: "Barbecues and Grilling" },
  { id: "216", name: "Cooking" },
  { id: "217", name: "Desserts and Baking" },
  { id: "218", name: "Dining Out" },
  { id: "220", name: "Food Movements" },
  { id: "221", name: "Healthy Cooking and Eating" },
  { id: "222", name: "Non-Alcoholic Beverages" },
  { id: "212", name: "Vegan Diets" },
  { id: "213", name: "Vegetarian Diets" },
  { id: "214", name: "World Cuisines" },

  // --- Tier 2: Travel -------------------------------------------------------
  { id: "655", name: "Travel Locations" },
  { id: "663", name: "Travel Preparation and Advice" },
  { id: "664", name: "Travel Type" },

  // --- Tier 2: Entertainment, Fine Art, Pop Culture -------------------------
  { id: "324", name: "Movies" },
  { id: "338", name: "Music" },
  { id: "640", name: "Television" },
  { id: "203", name: "Dance" },
  { id: "204", name: "Design" },
  { id: "206", name: "Fine Art Photography" },
  { id: "207", name: "Modern Art" },
  { id: "208", name: "Opera" },
  { id: "209", name: "Theater" },
  { id: "440", name: "Humor and Satire" },
  { id: "438", name: "Celebrity Scandal" },
  { id: "437", name: "Celebrity Relationships" },
  { id: "162", name: "Awards Shows" },
  { id: "185", name: "Fan Conventions" },

  // --- Tier 2: Family, Life events, Health ----------------------------------
  { id: "187", name: "Bereavement" },
  { id: "188", name: "Dating" },
  { id: "189", name: "Divorce" },
  { id: "191", name: "Marriage and Civil Unions" },
  { id: "192", name: "Parenting" },
  { id: "165", name: "Wedding" },
  { id: "170", name: "Birthday" },
  { id: "171", name: "Funeral" },
  { id: "172", name: "Graduation" },
  { id: "225", name: "Fitness and Exercise" },
  { id: "229", name: "Nutrition" },
  { id: "232", name: "Wellness" },
  { id: "287", name: "Diseases and Conditions" },

  // --- Tier 2: Work, money, society -----------------------------------------
  { id: "53", name: "Business" },
  { id: "80", name: "Economy" },
  { id: "90", name: "Industries" },
  { id: "125", name: "Career Advice" },
  { id: "127", name: "Job Search" },
  { id: "387", name: "Elections" },
  { id: "388", name: "Political Issues & policy" },
  { id: "8YPBBL", name: "Civic affairs" },

  // --- Tier 2: Craft, home, outdoors ----------------------------------------
  { id: "240", name: "Antiquing and Antiques" },
  { id: "248", name: "Arts and Crafts" },
  { id: "261", name: "Collecting" },
  { id: "264", name: "Content Production" },
  { id: "273", name: "Genealogy and Ancestry" },
  { id: "243", name: "Musical Instruments" },
  { id: "244", name: "Paranormal Phenomena" },
  { id: "275", name: "Gardening" },
  { id: "280", name: "Home Improvement" },
  { id: "283", name: "Interior Decorating" },
  { id: "276", name: "Remodeling & Construction" },

  // --- Tier 2: Belief, science, nature --------------------------------------
  { id: "455", name: "Spirituality" },
  { id: "456", name: "Astrology" },
  { id: "458", name: "Buddhism" },
  { id: "459", name: "Christianity" },
  { id: "460", name: "Hinduism" },
  { id: "461", name: "Islam" },
  { id: "462", name: "Judaism" },
  { id: "465", name: "Biological Sciences" },
  { id: "467", name: "Environment" },
  { id: "469", name: "Geography" },
  { id: "470", name: "Geology" },
  { id: "472", name: "Space and Astronomy" },
  { id: "390", name: "Weather" },

  // --- Tier 2: Style, tech, animals -----------------------------------------
  { id: "553", name: "Beauty" },
  { id: "574", name: "Body Art" },
  { id: "577", name: "Fashion Trends" },
  { id: "578", name: "High Fashion" },
  { id: "595", name: "Street Style" },
  { id: "597", name: "Artificial Intelligence" },
  { id: "599", name: "Computing" },
  { id: "632", name: "Consumer Electronics" },
  { id: "638", name: "Robotics" },
  { id: "424", name: "Cats" },
  { id: "425", name: "Dogs" },
  { id: "427", name: "Large Animals" },
  { id: "430", name: "Veterinary Medicine" },

  // --- Tier 2: Sport --------------------------------------------------------
  { id: "484", name: "American Football" },
  { id: "518", name: "Auto Racing" },
  { id: "545", name: "Baseball" },
  { id: "547", name: "Basketball" },
  { id: "485", name: "Boxing" },
  { id: "492", name: "Cycling" },
  { id: "498", name: "Extreme Sports" },
  { id: "511", name: "Fishing Sports" },
  { id: "512", name: "Golf" },
  { id: "514", name: "Hunting and Shooting" },
  { id: "515", name: "Ice Hockey" },
  { id: "520", name: "Martial Arts" },
  { id: "521", name: "Olympic Sports" },
  { id: "525", name: "Rodeo" },
  { id: "530", name: "Sailing" },
  { id: "531", name: "Skiing" },
  { id: "533", name: "Soccer" },
  { id: "537", name: "Swimming" },
  { id: "539", name: "Tennis" },
  { id: "540", name: "Track and Field" },

  // --- Tier 2: Sensitive ----------------------------------------------------
  { id: "XtODT3", name: "Crime & Harmful Acts" },
  { id: "I4GWl6", name: "Death, Injury, or Military Conflict" },
  { id: "Z7rJBM", name: "Debated Sensitive Social Issues" },
  { id: "pg0WhF", name: "Illegal Drugs, Tobacco, Vaping, Alcohol" },
  { id: "j9PaO9", name: "Obscenity and Profanity" },
] as const;

export const IAB_GENRE_IDS = new Set(
  IAB_ENTERTAINMENT_GENRES.map((c) => c.id),
);
export const IAB_FORM_FACTOR_IDS = new Set(
  IAB_VIDEO_FORM_FACTORS.map((c) => c.id),
);
export const IAB_TOPIC_IDS = new Set(IAB_CONTENT_TOPICS.map((c) => c.id));

const ALLOWED_BY_ID: ReadonlyMap<string, string> = new Map(
  [
    ...IAB_ENTERTAINMENT_GENRES,
    ...IAB_VIDEO_FORM_FACTORS,
    ...IAB_CONTENT_TOPICS,
  ].map((c) => [c.id, c.name]),
);

export interface IabFieldOptions {
  formFactor?: boolean;
  genres?: boolean;
  /**
   * Content-aboutness categories. Opt-in rather than default-on: turning it on
   * for the existing Pegasus path would mark every already-generated segment
   * incomplete and re-run the whole back catalogue through TwelveLabs.
   */
  topics?: boolean;
}

export interface IabTaxonomyTags {
  cattax: typeof IAB_CONTENT_TAXONOMY_VERSION;
  cat: string[];
  labels?: string[];
}

function resolveFields(fields?: IabFieldOptions) {
  return {
    genres: fields?.genres !== false,
    formFactor: fields?.formFactor !== false,
    topics: fields?.topics === true,
  };
}

export function iabAllowlistPromptBlock(fields?: IabFieldOptions): string {
  const include = resolveFields(fields);
  const parts: string[] = [
    "IAB Content Taxonomy 3.0 — pick IDs only from these lists.",
  ];
  if (include.topics) {
    parts.push(
      `Topics — what the scene is about (pick 1-3, most specific first): ${IAB_CONTENT_TOPICS.map((c) => `${c.id}=${c.name}`).join("; ")}`,
    );
  }
  if (include.genres) {
    parts.push(
      `Genres (pick 1-3): ${IAB_ENTERTAINMENT_GENRES.map((c) => `${c.id}=${c.name}`).join("; ")}`,
    );
  }
  if (include.formFactor) {
    parts.push(
      `Form factors (pick exactly 1; prefer Clip for short scenes): ${IAB_VIDEO_FORM_FACTORS.map((c) => `${c.id}=${c.name}`).join("; ")}`,
    );
  }
  return parts.join("\n");
}

export function iabPickInstruction(fields?: IabFieldOptions): string {
  const include = resolveFields(fields);
  const clauses: string[] = [];
  if (include.formFactor) {
    clauses.push("exactly one form factor (prefer Clip for short scenes)");
  }
  if (include.topics) clauses.push("1-3 topics");
  if (include.genres) clauses.push("1-3 genres");
  if (clauses.length === 0) return "";
  return `Return iab_cat as ${clauses.join(" plus ")}.`;
}

/** Keep only known IDs (optionally filtered by field flags); rebuild labels from the allowlist. */
export function normalizeIabTags(
  catIds: unknown,
  _labels?: unknown,
  fields?: IabFieldOptions,
): IabTaxonomyTags | undefined {
  if (!Array.isArray(catIds)) return undefined;
  const include = resolveFields(fields);
  const cat: string[] = [];
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const raw of catIds) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    const name = ALLOWED_BY_ID.get(id);
    if (!name) continue;
    if (IAB_GENRE_IDS.has(id) && !include.genres) continue;
    if (IAB_FORM_FACTOR_IDS.has(id) && !include.formFactor) continue;
    if (IAB_TOPIC_IDS.has(id) && !include.topics) continue;
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

export function iabHasGenre(tags: IabTaxonomyTags | undefined): boolean {
  return !!tags?.cat?.some((id) => IAB_GENRE_IDS.has(id));
}

export function iabHasFormFactor(tags: IabTaxonomyTags | undefined): boolean {
  return !!tags?.cat?.some((id) => IAB_FORM_FACTOR_IDS.has(id));
}

export function iabHasTopic(tags: IabTaxonomyTags | undefined): boolean {
  return !!tags?.cat?.some((id) => IAB_TOPIC_IDS.has(id));
}
