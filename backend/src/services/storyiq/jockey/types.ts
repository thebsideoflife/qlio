import { z } from "zod";

export const NarrativeRoleSchema = z.enum([
  "setup",
  "escalation",
  "pivot",
  "payoff",
  "main_story",
  "secondary_story",
]);

export type NarrativeRole = z.infer<typeof NarrativeRoleSchema>;

export const StoryBeatSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(80),
  approximateStartSec: z.number().nonnegative(),
  approximateEndSec: z.number().nonnegative(),
  narrativeRole: NarrativeRoleSchema,
  characters: z.array(z.string()),
  dialogForward: z.boolean(),
  producerTheme: z.string().nullish(),
});

export type StoryBeat = z.infer<typeof StoryBeatSchema>;

export const NarrativeArcSchema = z.object({
  name: z.string().min(1),
  beats: z.array(StoryBeatSchema),
});

export const NarrativeBriefSchema = z
  .object({
    logline: z.string().min(1),
    arcs: z.array(NarrativeArcSchema).min(1),
    recapBeats: z.array(StoryBeatSchema).optional(),
    producerNotes: z.string(),
    targetRuntimeSec: z.number().positive(),
  })
  .refine(
    (data) =>
      data.arcs.some((a) => a.beats.length > 0) ||
      (data.recapBeats?.length ?? 0) >= 4,
    "Brief must include arc beats and/or at least 4 recapBeats",
  );

export type NarrativeBrief = z.infer<typeof NarrativeBriefSchema>;

export interface AnalysisWindow {
  videoId: string;
  localStartSec: number;
  localEndSec: number;
  physicalOffsetSec: number;
  chunkIndex: number;
  arcNames: string[];
}

export interface JockeyPipelineOptions {
  assetId: string;
  durationSec: number;
  title: string;
  purpose: "compact_video" | "episode_recap";
  targetDurationSec: number;
  userInstructions?: string;
  geminiApiKey?: string;
  maxPollWaitMs?: number;
  minSegmentDuration?: number;
  maxSegmentDuration?: number;
}
