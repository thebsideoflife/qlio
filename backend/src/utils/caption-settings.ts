/**
 * Shared caption-settings definitions for the backend.
 *
 * One definition of the CaptionSettings shape and its built-in defaults, plus
 * the pure helpers used to (a) merge partial settings over a base, (b) decide
 * whether an incoming PATCH actually changed the settings, and (c) pick which
 * sibling project a new project should inherit its caption settings from.
 *
 * NOTE: the default values here intentionally match what renderVideo.ts used
 * before this module existed. Aligning them with the frontend defaults is a
 * separate change.
 */

export interface CaptionStyle {
  fontSize: number;
  fontFamily: string;
  fontWeight?: string;
  color: string;
  backgroundColor: string;
  position: { x: number; y: number };
  maxWidth: number;
  highlightColor?: string;
}

export interface CaptionSettings {
  enabled: boolean;
  style: CaptionStyle;
  wordEdits?: Record<string, string>;
  activeLanguage?: string;
}

/** A partial override: every field optional, including inside `style`. */
export type CaptionSettingsPatch = Partial<
  Omit<CaptionSettings, "style"> & { style: Partial<CaptionStyle> }
>;

export const DEFAULT_CAPTION_SETTINGS: CaptionSettings = {
  enabled: true,
  style: {
    fontSize: 2,
    fontFamily: "Inter, system-ui, sans-serif",
    fontWeight: "600",
    color: "#ffffff",
    backgroundColor: "rgba(0, 0, 0, 0.8)",
    position: { x: 50, y: 85 },
    maxWidth: 95,
    highlightColor: "#fbbf24",
  },
};

/**
 * Layer `override` on top of `base`. Top-level fields (enabled, activeLanguage,
 * wordEdits) and `style` fields are merged one level deep: any field present in
 * the override wins, anything absent falls through to the base. `position` and
 * `wordEdits` are treated as leaf values (replaced wholesale when present),
 * which matches how renderVideo has always combined project + request settings.
 */
export function mergeCaptionSettings(
  base: CaptionSettings,
  override?: CaptionSettingsPatch | null,
): CaptionSettings {
  if (!override || typeof override !== "object") {
    return { ...base, style: { ...base.style } };
  }
  const { style: overrideStyle, ...rest } = override;
  const merged: CaptionSettings = {
    ...base,
    ...stripUndefined(rest),
    style: {
      ...base.style,
      ...stripUndefined(overrideStyle && typeof overrideStyle === "object" ? overrideStyle : {}),
    },
  };
  return merged;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * Deep structural equality after JSON normalisation: key order is ignored,
 * `undefined` values are dropped (as DynamoDB/JSON would drop them).
 */
export function captionSettingsEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = sortKeysDeep(v);
    }
    return out;
  }
  return value;
}

/** The subset of a stored project record the inheritance picker looks at. */
export interface ProjectCaptionFields {
  projectId?: string;
  captionSettings?: unknown;
  /** Set by updateProject whenever a PATCH actually changed captionSettings. */
  captionSettingsUpdatedAt?: string;
  updatedAt?: string;
  createdAt?: string;
}

export interface CaptionSettingsSource {
  projectId?: string;
  captionSettings: CaptionSettingsPatch;
  /** The timestamp the source was ranked by (see pickCaptionSettingsSource). */
  captionSettingsUpdatedAt: string;
}

/**
 * Choose the sibling project whose caption settings a new project inherits.
 *
 * Rule:
 *  - only projects with a `captionSettings` object are candidates;
 *  - each candidate is ranked by `captionSettingsUpdatedAt`, falling back to
 *    `updatedAt` (then `createdAt`) when it was never stamped;
 *  - the greatest timestamp wins. On an exact tie a candidate with an explicit
 *    `captionSettingsUpdatedAt` beats one that fell back; otherwise the earlier
 *    entry in `projects` is kept.
 *
 * The returned `captionSettingsUpdatedAt` is the ranking timestamp, so a new
 * project that inherits from it keeps pointing at the genuinely last-edited
 * settings even across chains of inheritance.
 */
export function pickCaptionSettingsSource(
  projects: ReadonlyArray<ProjectCaptionFields>,
): CaptionSettingsSource | null {
  let best: { source: CaptionSettingsSource; explicit: boolean; ms: number } | null =
    null;

  for (const project of projects) {
    const settings = project.captionSettings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) continue;

    const explicit = typeof project.captionSettingsUpdatedAt === "string" && project.captionSettingsUpdatedAt !== "";
    const stamp = explicit
      ? project.captionSettingsUpdatedAt!
      : project.updatedAt || project.createdAt;
    if (!stamp) continue;
    const ms = Date.parse(stamp);
    if (Number.isNaN(ms)) continue;

    const better =
      !best ||
      ms > best.ms ||
      (ms === best.ms && explicit && !best.explicit);
    if (better) {
      best = {
        explicit,
        ms,
        source: {
          projectId: project.projectId,
          captionSettings: settings as CaptionSettingsPatch,
          captionSettingsUpdatedAt: stamp,
        },
      };
    }
  }

  return best ? best.source : null;
}
