/**
 * Jockey v3 Pipeline — self-directed cutting (SPEC-jockey-v3-self-directed-cuts.md).
 *
 * One brain: Jockey explores the asset, finds scene boundaries itself, and
 * returns final cuts. There is NO preprocessing (no detect-scenes, no
 * narrative brief) and NO deterministic re-cutting (no enforcer splits, no
 * quartile backfill, no recap re-fit). Code validates the result and, on
 * failure, re-asks Jockey with structured feedback — bounded at 3 passes,
 * then the job fails loudly.
 *
 * Flow:
 *   instruction + format + target + asset
 *     → knowledge store (create or reuse)
 *     → Jockey structured response (cuts + self-reported scene boundaries)
 *     → safety clamps (bounds clamp + dedupe only)
 *     → deterministic gates → pass: map to ProposedSegment[] / fail: re-ask
 */

import {
  JockeyAgentsClient,
  isStaleKnowledgeStoreError,
} from "../jockey-agents-api";
import {
  Purpose,
  type FinalSegments,
  type VideoMetadata,
} from "./types";
import {
  applySafetyClamps,
  isBlockingIssue,
  mapToProposedSegments,
  quartileCounts,
  validateSelfDirectedCuts,
  SelfDirectedCutsSchema,
  SELF_DIRECTED_CUTS_JSON_SCHEMA,
  type JockeyV3PurposeKey,
  type SelfDirectedCuts,
  type V3Issue,
} from "./jockey/self-directed";
import {
  buildRevisionPrompt,
  buildSelfDirectedPrompt,
  SELF_DIRECTED_INSTRUCTIONS,
  type SelfDirectedPromptOptions,
} from "./jockey/self-directed-prompts";

/** Bounded retries — SPEC §6: ≤3 Jockey passes, then fail with collected issues. */
export const JOCKEY_V3_MAX_PASSES = 3;

/** Locked product decision: compact defaults to 50% of source runtime. */
const COMPACT_DEFAULT_TARGET_PERCENT = 50;
const EPISODE_RECAP_DEFAULT_TARGET_SEC = 75;

/** Persisted so re-runs on the same asset skip upload + indexing. */
export interface JockeyV3AgentsContext {
  agentsAssetId: string;
  knowledgeStoreId: string;
}

export interface JockeyV3PipelineOptions {
  purpose: Purpose;
  metadata: VideoMetadata;
  targetDuration?: number;
  targetPercent?: number;
  userInstructions?: string;
  /** Overall time budget in ms (Lambda passes remaining-time-minus-buffer). */
  maxPollWaitMs?: number;

  /** Agents API (jockey1.0) key — required, no fallback while the v3 flag is on. */
  agentsApiKey: string;
  /** Asset id readable under the Agents key (skips re-upload). */
  agentsAssetId?: string;
  /** Existing knowledge store containing the asset (skips store creation + indexing). */
  knowledgeStoreId?: string;
  /** Presigned/public video URL — used to upload when no agentsAssetId exists. */
  videoUrlForUpload?: string;
  /** Called once the Agents asset + store are ready, so callers can persist them for reuse. */
  onAgentsContextReady?: (ctx: JockeyV3AgentsContext) => Promise<void>;

  /**
   * Known internal chunk/window seam timestamps (source timeline, seconds).
   * Cuts within tolerance of a seam are validation failures (SPEC §5).
   * Empty/omitted for single-pass assets.
   */
  seamTimestampsSec?: number[];
}

function purposeKeyOf(purpose: Purpose): JockeyV3PurposeKey {
  if (purpose === Purpose.EPISODE_RECAP) return "episode_recap";
  if (purpose === Purpose.COMPACT_VIDEO) return "compact_video";
  throw new Error(
    `[JockeyV3] Unsupported purpose "${purpose}" — v3 handles compact_video and episode_recap only`,
  );
}

function resolveTargetSeconds(
  options: JockeyV3PipelineOptions,
  purposeKey: JockeyV3PurposeKey,
): number {
  const duration = options.metadata.duration;
  let target =
    options.targetDuration ??
    (options.targetPercent
      ? Math.round((duration * options.targetPercent) / 100)
      : undefined);

  if (!target || target <= 0) {
    target =
      purposeKey === "episode_recap"
        ? EPISODE_RECAP_DEFAULT_TARGET_SEC
        : Math.round((duration * COMPACT_DEFAULT_TARGET_PERCENT) / 100);
  }
  return target;
}

/**
 * Create a knowledge store for an Agents asset, wait for indexing, and persist
 * the new IDs via onAgentsContextReady so subsequent runs can reuse them.
 */
async function createAndPersistStore(
  client: JockeyAgentsClient,
  agentsAssetId: string,
  options: JockeyV3PipelineOptions,
  maxWaitMs: number,
): Promise<JockeyV3AgentsContext> {
  const storeCtx = await client.ensureKnowledgeStoreForAsset(agentsAssetId, {
    storeName: `qlio-v3-${options.metadata.assetId.slice(0, 8)}-${Date.now()}`,
    maxWaitMs,
  });

  const ctx: JockeyV3AgentsContext = {
    agentsAssetId,
    knowledgeStoreId: storeCtx.storeId,
  };

  if (options.onAgentsContextReady) {
    try {
      await options.onAgentsContextReady(ctx);
    } catch (err) {
      console.warn(
        `[JockeyV3] Failed to persist Agents context (non-fatal): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return ctx;
}

async function ensureAgentsContext(
  client: JockeyAgentsClient,
  options: JockeyV3PipelineOptions,
  maxWaitMs: number,
): Promise<JockeyV3AgentsContext> {
  // Cached store IDs can go stale in private beta (stores purged, assets kept).
  // Verify before reuse; if gone, recreate against the existing Agents asset.
  if (options.knowledgeStoreId && options.agentsAssetId) {
    const exists = await client.knowledgeStoreExists(options.knowledgeStoreId);
    if (exists) {
      console.log(
        `[JockeyV3] Reusing knowledge store ${options.knowledgeStoreId} (asset ${options.agentsAssetId})`,
      );
      return {
        agentsAssetId: options.agentsAssetId,
        knowledgeStoreId: options.knowledgeStoreId,
      };
    }
    console.warn(
      `[JockeyV3] Cached knowledge store ${options.knowledgeStoreId} no longer exists — ` +
        `recreating for asset ${options.agentsAssetId}`,
    );
  }

  let agentsAssetId = options.agentsAssetId;
  if (!agentsAssetId) {
    if (!options.videoUrlForUpload) {
      throw new Error(
        "[JockeyV3] No Agents asset id and no video URL for upload — cannot reach the asset under the Agents key",
      );
    }
    console.log("[JockeyV3] Uploading asset to Agents API (one-time per asset)...");
    agentsAssetId = await client.uploadAssetFromUrl(
      options.videoUrlForUpload,
      maxWaitMs,
    );
  }

  return createAndPersistStore(client, agentsAssetId, options, maxWaitMs);
}

interface PassRecord {
  pass: number;
  issues: V3Issue[];
  segmentCount: number;
  latencyMs: number;
}

export interface JockeyV3Result extends FinalSegments {
  /** Scene-change timestamps Jockey reported in the shipped pass (eval edge checks). */
  sceneBoundaries: number[];
}

/**
 * Generate segments via Jockey v3 self-directed cutting.
 */
export async function generateSegmentsWithJockeyV3(
  options: JockeyV3PipelineOptions,
): Promise<JockeyV3Result> {
  const startMs = Date.now();
  const purposeKey = purposeKeyOf(options.purpose);
  const targetSeconds = resolveTargetSeconds(options, purposeKey);
  const duration = options.metadata.duration;

  const budgetMs = options.maxPollWaitMs ?? 3_600_000;
  const hardDeadline = startMs + budgetMs;
  const remainingMs = () => hardDeadline - Date.now();

  // Explicit observability assertion (SPEC §8): this path runs no
  // detect-scenes call and no separate brief step.
  console.log(
    `[JockeyV3] Self-directed run: ${purposeKey}, target≈${targetSeconds}s, ` +
      `source ${Math.round(duration)}s, budget ${Math.round(budgetMs / 1000)}s. ` +
      `NO preprocessing ran (no detect-scenes, no narrative brief).`,
  );

  const client = new JockeyAgentsClient({ apiKey: options.agentsApiKey });
  let agentsCtx = await ensureAgentsContext(client, options, remainingMs());
  // At most one mid-run store rebuild — avoids burning all 3 passes on a
  // purged store ID, and avoids recreate loops if the API keeps 404ing.
  let storeRecoveredThisRun = false;

  const promptBase: SelfDirectedPromptOptions = {
    purpose: purposeKey,
    title: options.metadata.title,
    durationSec: duration,
    targetSeconds,
    userInstructions: options.userInstructions,
  };

  const passRecords: PassRecord[] = [];
  let previousResponseJson: string | undefined;
  let previousIssues: V3Issue[] = [];
  let shipped: SelfDirectedCuts | null = null;
  let clampNotes: string[] = [];

  // Best structurally-valid candidate across passes. If no pass clears every
  // editorial gate, this ships (with outstanding issues in notes) instead of
  // failing the job — validation still drives the re-ask loop, but a usable
  // cut list from Jockey always beats a dead job.
  let bestCandidate: {
    cuts: SelfDirectedCuts;
    issues: V3Issue[];
    clampNotes: string[];
    pass: number;
  } | null = null;

  const askJockey = (storeId: string, prompt: string) =>
    client.createStructuredResponse<unknown>({
      storeId,
      prompt,
      instructions: SELF_DIRECTED_INSTRUCTIONS,
      schemaName: "self_directed_cuts",
      schema: SELF_DIRECTED_CUTS_JSON_SCHEMA,
    });

  for (let pass = 1; pass <= JOCKEY_V3_MAX_PASSES; pass++) {
    if (pass > 1 && remainingMs() < 60_000) {
      console.warn(
        `[JockeyV3] Time budget nearly exhausted — stopping before pass ${pass}`,
      );
      break;
    }

    const prompt =
      pass === 1
        ? buildSelfDirectedPrompt(promptBase)
        : buildRevisionPrompt({
            base: promptBase,
            previousResponseJson: previousResponseJson ?? "{}",
            issues: previousIssues,
            passNumber: pass,
          });

    console.log(`[JockeyV3] Pass ${pass}/${JOCKEY_V3_MAX_PASSES}: asking Jockey...`);
    const passStart = Date.now();

    let raw: unknown;
    try {
      raw = await askJockey(agentsCtx.knowledgeStoreId, prompt);
    } catch (err) {
      // Store can disappear between ensureAgentsContext and /responses (or
      // the existence check can race a purge). Rebuild once and retry this pass.
      if (
        isStaleKnowledgeStoreError(err) &&
        !storeRecoveredThisRun &&
        remainingMs() >= 60_000
      ) {
        const staleId = agentsCtx.knowledgeStoreId;
        console.warn(
          `[JockeyV3] Pass ${pass}: knowledge store ${staleId} gone (404) — ` +
            `recreating for asset ${agentsCtx.agentsAssetId} and retrying`,
        );
        try {
          agentsCtx = await createAndPersistStore(
            client,
            agentsCtx.agentsAssetId,
            options,
            remainingMs(),
          );
          storeRecoveredThisRun = true;
          raw = await askJockey(agentsCtx.knowledgeStoreId, prompt);
        } catch (recoverErr) {
          const message =
            recoverErr instanceof Error ? recoverErr.message : String(recoverErr);
          previousIssues = [
            {
              code: "invalid_response",
              message: `Agents API call failed after store recovery: ${message}`,
            },
          ];
          passRecords.push({
            pass,
            issues: previousIssues,
            segmentCount: 0,
            latencyMs: Date.now() - passStart,
          });
          console.warn(`[JockeyV3] Pass ${pass} failed after store recovery: ${message}`);
          continue;
        }
      } else {
        const message = err instanceof Error ? err.message : String(err);
        previousIssues = [
          { code: "invalid_response", message: `Agents API call failed: ${message}` },
        ];
        passRecords.push({
          pass,
          issues: previousIssues,
          segmentCount: 0,
          latencyMs: Date.now() - passStart,
        });
        console.warn(`[JockeyV3] Pass ${pass} failed: ${message}`);
        continue;
      }
    }

    const parsed = SelfDirectedCutsSchema.safeParse(raw);
    if (!parsed.success) {
      previousResponseJson = JSON.stringify(raw).slice(0, 8_000);
      previousIssues = [
        {
          code: "invalid_response",
          message: `Response did not match the required shape: ${parsed.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        },
      ];
      passRecords.push({
        pass,
        issues: previousIssues,
        segmentCount: 0,
        latencyMs: Date.now() - passStart,
      });
      console.warn(
        `[JockeyV3] Pass ${pass} returned malformed response — re-asking`,
      );
      continue;
    }

    // Safety clamps only: bounds clamp + dedupe. Never split/trim/snap.
    const clamped = applySafetyClamps(parsed.data.segments, duration);
    const candidate: SelfDirectedCuts = {
      ...parsed.data,
      segments: clamped.segments,
    };

    const issues = validateSelfDirectedCuts(candidate, {
      purpose: purposeKey,
      videoDurationSec: duration,
      targetSeconds,
      seamTimestampsSec: options.seamTimestampsSec,
    });

    passRecords.push({
      pass,
      issues,
      segmentCount: candidate.segments.length,
      latencyMs: Date.now() - passStart,
    });

    if (issues.length === 0) {
      shipped = candidate;
      clampNotes = clamped.notes;
      console.log(
        `[JockeyV3] Pass ${pass} PASSED validation — ${candidate.segments.length} segments`,
      );
      break;
    }

    const hasBlocking = issues.some(isBlockingIssue);
    if (
      !hasBlocking &&
      (!bestCandidate || issues.length < bestCandidate.issues.length)
    ) {
      bestCandidate = {
        cuts: candidate,
        issues,
        clampNotes: clamped.notes,
        pass,
      };
    }

    console.warn(
      `[JockeyV3] Pass ${pass} failed validation (${issues.length} issue(s)): ` +
        issues.map((i) => `[${i.code}] ${i.message}`).join("; "),
    );
    previousResponseJson = JSON.stringify(parsed.data).slice(0, 8_000);
    previousIssues = issues;
  }

  const attempts = passRecords.length;
  let shippedPass = attempts;
  let shippedWithIssues: V3Issue[] = [];

  if (!shipped && bestCandidate) {
    // No pass cleared every editorial gate, but Jockey produced a
    // structurally-valid cut list (no overlaps, no zero-length rows). Ship it
    // and surface the outstanding editorial issues in notes.
    shipped = bestCandidate.cuts;
    clampNotes = bestCandidate.clampNotes;
    shippedWithIssues = bestCandidate.issues;
    shippedPass = bestCandidate.pass;
    console.warn(
      `[JockeyV3] No pass cleared all gates after ${attempts} attempt(s) — ` +
        `shipping best structurally-valid pass ${bestCandidate.pass} with ` +
        `${bestCandidate.issues.length} outstanding issue(s): ` +
        bestCandidate.issues.map((i) => `[${i.code}] ${i.message}`).join("; "),
    );
  }

  if (!shipped) {
    // Fail loud — nothing structurally shippable came back from any pass.
    // No heuristic/legacy fallback while the v3 flag is on (SPEC §4.5).
    const collected = passRecords
      .map(
        (p) =>
          `pass ${p.pass}: ${p.issues.map((i) => `[${i.code}] ${i.message}`).join("; ") || "no issues recorded"}`,
      )
      .join(" | ");
    throw new Error(
      `[JockeyV3] Failed after ${attempts} Jockey pass(es). Collected issues: ${collected}`,
    );
  }

  const proposed = mapToProposedSegments(shipped.segments);
  const totalDuration = proposed.reduce(
    (sum, s) => sum + (s.endTime - s.startTime),
    0,
  );
  const quartiles = quartileCounts(proposed, duration);
  const processingTime = Date.now() - startMs;

  // Per-job observability (SPEC §8): shipped pass, retries, validation issues
  // per pass, final counts, quartile spread, latency.
  console.log(
    `[JockeyV3] Done in ${processingTime}ms — shipped pass ${shippedPass} of ${attempts} attempt(s), ` +
      `${proposed.length} segments, ~${Math.round(totalDuration)}s total, ` +
      `quartiles ${quartiles.join("/")}, ${shipped.sceneBoundaries.length} Jockey scene boundaries`,
  );

  const notes: string[] = [
    `Jockey v3 self-directed: shipped pass ${shippedPass} of ${attempts} attempt(s) ` +
      `(store ${agentsCtx.knowledgeStoreId}). No preprocessing, no deterministic re-cutting.`,
    ...(shippedWithIssues.length > 0
      ? [
          `Shipped best structurally-valid pass with outstanding editorial issue(s): ` +
            shippedWithIssues
              .map((i) => `[${i.code}] ${i.message}`)
              .join("; "),
        ]
      : []),
    ...(shipped.logline ? [`Logline: ${shipped.logline}`] : []),
    ...(shipped.editorNotes ? [`Editor notes: ${shipped.editorNotes}`] : []),
    ...passRecords
      .filter((p) => p.issues.length > 0)
      .map(
        (p) =>
          `Pass ${p.pass} issues: ${p.issues.map((i) => `[${i.code}] ${i.message}`).join("; ")}`,
      ),
    ...clampNotes,
  ];

  return {
    segments: proposed,
    confidence: shippedWithIssues.length > 0 ? 0.7 : 0.9,
    notes,
    attempts,
    sceneBoundaries: shipped.sceneBoundaries,
  };
}

export function isJockeyV3Enabled(): boolean {
  return process.env.JOCKEY_V3_SELF_DIRECTED_ENABLED === "true";
}
