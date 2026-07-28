/**
 * Name grounding for segment titles.
 *
 * A model that knows the show can supply a name the footage never contains. In
 * the Paris run it titled the opening segment "meets Philippe at absinthe bar";
 * "Philippe" is spoken nowhere in the episode and the absinthe bar is eight
 * minutes later. Rule 2 grounds timestamps but says nothing about nouns.
 *
 * This warns, and deliberately never blocks. ASR mangles proper nouns badly —
 * the same transcript renders "Rungis" as "rangis" and "Les Halles" as "falls" —
 * so matching is fuzzy, and a name absent from a noisy transcript is a question
 * worth raising rather than a fact worth acting on.
 */

/** Edit distance, bailing out early once the strings cannot be close enough. */
function editDistance(a: string, b: string, ceiling: number): number {
  if (Math.abs(a.length - b.length) > ceiling) return ceiling + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > ceiling) return ceiling + 1;
    prev = cur;
  }
  return prev[b.length];
}

function normalize(word: string): string {
  return word.toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * A third of the name's length, which is what it takes to accept "rangis" for
 * "Rungis" without also accepting an unrelated word of the same shape.
 */
function toleranceFor(name: string): number {
  return Math.max(1, Math.floor(name.length / 3));
}

export interface GroundingVocabulary {
  tokens: Set<string>;
}

/** Build the set of words a title may draw names from without comment. */
export function buildVocabulary(sources: {
  transcriptWords?: Array<{ value: string }> | null;
  title?: string;
  userPrompt?: string;
}): GroundingVocabulary {
  const tokens = new Set<string>();
  const add = (text: string) => {
    for (const raw of text.split(/\s+/)) {
      const token = normalize(raw);
      if (token.length > 2) tokens.add(token);
    }
  };

  for (const word of sources.transcriptWords ?? []) add(word.value);
  // The asset title and the producer's own instructions are legitimate sources
  // for a name — "Bourdain" is never spoken in an episode about Bourdain.
  if (sources.title) add(sources.title);
  if (sources.userPrompt) add(sources.userPrompt);

  return { tokens };
}

/** Shortest shared stem worth treating as the same word. */
const MIN_STEM = 4;

function isGrounded(vocab: GroundingVocabulary, name: string): boolean {
  const needle = normalize(name);
  if (needle.length < 3) return true;
  if (vocab.tokens.has(needle)) return true;

  const ceiling = toleranceFor(needle);
  for (const token of vocab.tokens) {
    // Shared stem, which covers the inflections a title reaches for that the
    // dialogue never uses in that exact form: "Parisian" off "parisian",
    // "French" off "Frenchman", "Parisians" off "Parisian".
    if (token.length >= MIN_STEM && (needle.startsWith(token) || token.startsWith(needle))) {
      return true;
    }
    // Otherwise allow for speech-to-text mangling the spelling outright.
    if (editDistance(needle, token, ceiling) <= ceiling) return true;
  }
  return false;
}

/** Capitalized words that are not sentence-initial and not common vocabulary. */
const IGNORED_CAPITALS = new Set([
  "a", "an", "and", "at", "but", "by", "for", "from", "in", "of", "on", "or",
  "the", "to", "with", "his", "her", "their", "he", "she", "they", "it",
]);

export function findUngroundedNames(
  vocab: GroundingVocabulary,
  text: string,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const flagged: string[] = [];

  for (let i = 0; i < words.length; i++) {
    const bare = words[i].replace(/[^A-Za-z'-]/g, "");
    if (bare.length < 3) continue;
    // Only proper nouns, and never the first word — a title always starts
    // capitalized, which says nothing about whether it names anyone.
    if (i === 0) continue;
    if (bare[0] !== bare[0].toUpperCase()) continue;
    if (bare === bare.toUpperCase() && bare.length <= 4) continue;
    if (IGNORED_CAPITALS.has(bare.toLowerCase())) continue;
    if (isGrounded(vocab, bare)) continue;
    if (!flagged.includes(bare)) flagged.push(bare);
  }

  return flagged;
}
