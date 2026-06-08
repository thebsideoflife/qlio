interface SegmentLike {
  title?: string;
}

const FALLBACK_SEGMENT_TITLES = new Set([
  "Opening Scene",
  "Key Moment",
  "Conclusion",
]);

/** Placeholder shown before segments are generated or the user names the project. */
export function defaultProjectTitle(): string {
  return "Untitled";
}

/** True when the title is still an auto placeholder (safe to overwrite on generate). */
export function isDefaultProjectTitle(title: string | undefined | null): boolean {
  const trimmed = title?.trim();
  if (!trimmed) return true;
  if (trimmed === "Untitled" || trimmed === "Untitled Microseries") return true;
  // Legacy defaults from older builds
  if (/^Microseries\s/i.test(trimmed)) return true;
  if (/^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM)$/.test(trimmed)) {
    return true;
  }
  return false;
}

/** Derive a project title from generated segment titles. */
export function deriveProjectTitleFromSegments(
  segments: SegmentLike[],
): string | null {
  const titles = segments
    .map((segment) => segment.title?.trim())
    .filter((title): title is string => Boolean(title));

  if (titles.length === 0) return null;

  const editorial = titles.filter(
    (title) => !FALLBACK_SEGMENT_TITLES.has(title),
  );
  const candidate = editorial[0] ?? titles[0];
  return candidate.length <= 60 ? candidate : `${candidate.slice(0, 57)}…`;
}
