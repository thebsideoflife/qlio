/**
 * Reading the project/asset pair and committing the agent's cut back to it.
 *
 * `project.segments` stays the canonical thing the editor renders and the
 * renderer consumes. The agent's working set is committed to it on every
 * mutation — there is no new segment schema.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { TwelveLabs } from "twelvelabs-js";
import type { ChunkInfo } from "../twelvelabs";
import {
  deriveProjectTitleFromSegments,
  isDefaultProjectTitle,
} from "../../utils/projectTitle";
import { buildChunkFacts } from "./chunks";
import type { StoredSegmentMetadata } from "../../types/segment-metadata";
import type { AgentSegment, Brief, VideoFacts } from "./types";

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const secretsClient = new SecretsManagerClient({});

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const BUCKET_NAME = process.env.BUCKET_NAME;

let cachedTwelveLabsKey: string | null | undefined;

export interface ProjectContext {
  projectId: string;
  assetId: string;
  projectTitle: string;
  facts: VideoFacts;
  segments: AgentSegment[];
  savedBrief: Partial<Brief>;
  assetReady: boolean;
  assetIssue?: string;
}

export class ProjectContextError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectContextError";
  }
}

export async function loadProjectContext(
  projectId: string,
): Promise<ProjectContext> {
  const projectRes = await docClient.send(
    new GetCommand({ TableName: PROJECTS_TABLE, Key: { projectId } }),
  );
  if (!projectRes.Item) {
    throw new ProjectContextError("project_not_found", `Project ${projectId} does not exist.`);
  }
  const project = projectRes.Item;
  const assetId = String(project.assetId ?? "");
  if (!assetId) {
    throw new ProjectContextError(
      "project_has_no_asset",
      "This project is not linked to a video asset.",
    );
  }

  const assetRes = await docClient.send(
    new GetCommand({ TableName: ASSETS_TABLE, Key: { assetId } }),
  );
  if (!assetRes.Item) {
    throw new ProjectContextError(
      "asset_not_found",
      `The source asset ${assetId} no longer exists.`,
    );
  }
  const asset = assetRes.Item;

  const isChunked = asset.isChunked === true;
  const chunks = (asset.chunks as ChunkInfo[] | undefined) ?? [];
  const twelveLabsVideoId =
    typeof asset.twelveLabsVideoId === "string" &&
    asset.twelveLabsVideoId !== "unknown"
      ? asset.twelveLabsVideoId
      : undefined;

  let assetIssue: string | undefined;
  if (!isChunked && !twelveLabsVideoId) {
    assetIssue =
      "This video has not finished indexing with TwelveLabs, so semantic search and clip watching are unavailable.";
  } else if (isChunked && chunks.some((c) => !c.videoId)) {
    assetIssue =
      "Some chunks of this video are still indexing, so parts of it cannot be searched or watched yet.";
  }

  const duration = Number(asset.duration ?? 0);
  const chunkFacts = buildChunkFacts({
    isChunked,
    chunks,
    twelveLabsVideoId,
    duration,
  });

  const title =
    firstNonEmpty(asset.title, asset.originalName, project.title) ?? "Untitled video";

  const { bucket, key } = resolveSourceLocation(asset);

  const facts: VideoFacts = {
    assetId,
    title,
    duration,
    indexId:
      firstNonEmpty(asset.twelveLabsIndexId) ??
      process.env.TWELVE_LABS_INDEX_ID ??
      "",
    isChunked,
    chunks: chunkFacts,
    transcriptS3Uri:
      typeof asset.transcriptionUrl === "string" && asset.transcriptionUrl
        ? asset.transcriptionUrl
        : undefined,
    sourceBucket: bucket,
    sourceKey: key,
  };

  const metadata = (project.metadata ?? {}) as Record<string, unknown>;

  return {
    projectId,
    assetId,
    projectTitle: typeof project.title === "string" ? project.title : "Untitled",
    facts,
    segments: normalizeSegments(project.segments),
    savedBrief: metadataToBrief(metadata),
    assetReady: assetIssue === undefined,
    assetIssue,
  };
}

/** Panel inputs live only on `project.metadata` — not on the agent thread. */
export type GenerationInputs = {
  userPrompt?: string | null;
  purpose?: string | null;
  format?: string | null;
  assetType?: string | null;
  platform?: string | null;
  minSegmentDuration?: number | null;
  maxSegmentDuration?: number | null;
  targetPercent?: number | null;
  autoFrame?: boolean | null;
  targetAspectRatio?: string | null;
};

export function metadataToBrief(
  metadata: Record<string, unknown>,
): Partial<Brief> {
  return {
    format: asStringOrUndefined(metadata.format ?? metadata.purpose),
    // Legacy create-project blobs used `type` instead of `assetType`.
    assetType: asStringOrUndefined(metadata.assetType ?? metadata.type),
    platform: asStringOrUndefined(metadata.platform),
    targetPercent: asNumberOrNull(metadata.targetPercent),
    minSegmentDuration: asNumberOrUndefined(metadata.minSegmentDuration),
    maxSegmentDuration: asNumberOrUndefined(metadata.maxSegmentDuration),
    userPrompt: asStringOrUndefined(metadata.userPrompt),
    autoFrame:
      typeof metadata.autoFrame === "boolean" ? metadata.autoFrame : undefined,
    targetAspectRatio: asStringOrUndefined(metadata.targetAspectRatio),
  };
}

export function briefToGenerationInputs(brief: Partial<Brief>): GenerationInputs {
  const inputs: GenerationInputs = {
    userPrompt: brief.userPrompt ?? null,
    purpose: brief.format ?? null,
    format: brief.format ?? null,
    assetType: brief.assetType ?? null,
    platform: brief.platform ?? null,
    minSegmentDuration: brief.minSegmentDuration ?? null,
    maxSegmentDuration: brief.maxSegmentDuration ?? null,
    targetPercent: brief.targetPercent ?? null,
  };
  if (brief.autoFrame !== undefined) {
    inputs.autoFrame = brief.autoFrame !== false;
  }
  if (brief.targetAspectRatio !== undefined) {
    inputs.targetAspectRatio = brief.targetAspectRatio ?? null;
  }
  return inputs;
}

/**
 * True when metadata has a real panel brief (format), not just create-project
 * stubs like `platform` / legacy `type`.
 */
export function hasGenerationInputs(brief: Partial<Brief>): boolean {
  return Boolean(brief.format);
}

/** Read panel inputs from the project row (source of truth). */
export async function readGenerationInputs(
  projectId: string,
): Promise<Partial<Brief>> {
  const result = await docClient.send(
    new GetCommand({
      TableName: PROJECTS_TABLE,
      Key: { projectId },
      ProjectionExpression: "#meta",
      ExpressionAttributeNames: { "#meta": "metadata" },
    }),
  );
  return metadataToBrief((result.Item?.metadata ?? {}) as Record<string, unknown>);
}

/**
 * Merge panel inputs into `project.metadata`. Preserves unrelated keys on the
 * metadata map (legacy create-project fields, etc.).
 */
export async function saveGenerationInputs(
  projectId: string,
  brief: Partial<Brief>,
): Promise<Partial<Brief>> {
  const result = await docClient.send(
    new GetCommand({ TableName: PROJECTS_TABLE, Key: { projectId } }),
  );
  if (!result.Item) {
    throw new ProjectContextError("project_not_found", `Project ${projectId} does not exist.`);
  }
  const current = (result.Item.metadata ?? {}) as Record<string, unknown>;
  const patch = briefToGenerationInputs(brief);
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) next[key] = value;
  }
  // Prefer canonical assetType over legacy `type` once we have it.
  if (typeof next.assetType === "string" && next.assetType) {
    delete next.type;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: PROJECTS_TABLE,
      Key: { projectId },
      UpdateExpression: "SET #meta = :meta, updatedAt = :now",
      ConditionExpression: "attribute_exists(projectId)",
      ExpressionAttributeNames: { "#meta": "metadata" },
      ExpressionAttributeValues: {
        ":meta": next,
        ":now": new Date().toISOString(),
      },
    }),
  );

  return metadataToBrief(next);
}

function resolveSourceLocation(asset: Record<string, unknown>): {
  bucket?: string;
  key?: string;
} {
  const s3VideoUrl = typeof asset.s3VideoUrl === "string" ? asset.s3VideoUrl : "";
  if (s3VideoUrl.startsWith("s3://")) {
    const withoutScheme = s3VideoUrl.slice("s3://".length);
    const slash = withoutScheme.indexOf("/");
    if (slash > 0) {
      return {
        bucket: withoutScheme.slice(0, slash),
        key: withoutScheme.slice(slash + 1),
      };
    }
  }
  if (typeof asset.key === "string" && asset.key && BUCKET_NAME) {
    return { bucket: BUCKET_NAME, key: asset.key };
  }
  return {};
}

export function normalizeSegments(raw: unknown): AgentSegment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry, index) => {
      const s = entry as Record<string, unknown>;
      const startTime = Number(s.startTime ?? 0);
      const endTime = Number(s.endTime ?? 0);
      return {
        id: typeof s.id === "string" && s.id ? s.id : `s${index + 1}`,
        startTime: Number.isFinite(startTime) ? startTime : 0,
        endTime: Number.isFinite(endTime) ? endTime : 0,
        title: typeof s.title === "string" ? s.title : "",
        description: typeof s.description === "string" ? s.description : "",
        characters: Array.isArray(s.characters) ? (s.characters as string[]) : [],
        sceneTags: Array.isArray(s.sceneTags) ? (s.sceneTags as string[]) : [],
        keyDialogue: typeof s.keyDialogue === "string" ? s.keyDialogue : "",
        confidence: Number.isFinite(Number(s.confidence)) ? Number(s.confidence) : 0.9,
        ...(s.framing !== undefined ? { framing: s.framing } : {}),
      } satisfies AgentSegment;
    })
    .sort((a, b) => a.startTime - b.startTime);
}

/**
 * Commit the working set to the project. Framing already computed for a segment
 * whose timing did not change is preserved; framing on a moved segment is
 * dropped so the stale keyframes cannot survive the edit.
 */
export async function commitSegments(params: {
  projectId: string;
  segments: AgentSegment[];
  changedIds?: string[];
  brief?: Brief;
  currentTitle: string;
}): Promise<void> {
  const changed = new Set(params.changedIds ?? []);
  const segments = params.segments.map((seg) =>
    changed.has(seg.id) && seg.framing
      ? { ...seg, framing: undefined }
      : seg,
  );

  const autoTitle = deriveProjectTitleFromSegments(
    segments.map((s) => ({ title: s.title, startTime: s.startTime })),
  );
  const shouldRename = autoTitle != null && isDefaultProjectTitle(params.currentTitle);

  const names: Record<string, string> = { "#seg": "segments" };
  const values: Record<string, unknown> = {
    ":segments": segments,
    ":now": new Date().toISOString(),
  };
  const sets = ["#seg = :segments", "updatedAt = :now"];

  if (shouldRename) {
    names["#title"] = "title";
    sets.push("#title = :title");
    values[":title"] = autoTitle;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: PROJECTS_TABLE,
      Key: { projectId: params.projectId },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );

  // Panel inputs are project metadata — merge rather than replacing the map.
  if (params.brief) {
    await saveGenerationInputs(params.projectId, params.brief);
  }
}

export interface ProjectMetadataState {
  segmentMetadata: StoredSegmentMetadata[];
  thumbnailKey?: string;
  thumbnailContentHash?: string;
}

/** Just the delivery-metadata fields, so the agent never pulls a whole project row. */
export async function readProjectMetadataState(
  projectId: string,
): Promise<ProjectMetadataState> {
  const result = await docClient.send(
    new GetCommand({
      TableName: PROJECTS_TABLE,
      Key: { projectId },
      ProjectionExpression:
        "segmentMetadata, thumbnailKey, thumbnailContentHash",
    }),
  );
  const item = result.Item ?? {};
  return {
    segmentMetadata: Array.isArray(item.segmentMetadata)
      ? (item.segmentMetadata as StoredSegmentMetadata[])
      : [],
    thumbnailKey:
      typeof item.thumbnailKey === "string" ? item.thumbnailKey : undefined,
    thumbnailContentHash:
      typeof item.thumbnailContentHash === "string"
        ? item.thumbnailContentHash
        : undefined,
  };
}

export async function writeProjectSegmentMetadata(
  projectId: string,
  metadata: StoredSegmentMetadata[],
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: PROJECTS_TABLE,
      Key: { projectId },
      UpdateExpression: "SET segmentMetadata = :meta, updatedAt = :now",
      // The project must already exist; creating one from here would produce a
      // row with metadata and nothing else.
      ConditionExpression: "attribute_exists(projectId)",
      ExpressionAttributeValues: {
        ":meta": metadata,
        ":now": new Date().toISOString(),
      },
    }),
  );
}

export interface FramingJobSnapshot {
  status: string;
  jobId?: string;
  segmentCount?: number;
  completedCount?: number;
  error?: string;
  startedAt?: string;
  /** Last framing heartbeat; long SporeLabs jobs outlive startedAt + 15 min. */
  heartbeatAt?: string;
}

/** Matches the stale threshold in analyzeFraming — do not start a second job. */
const FRAMING_JOB_STALE_MS = 15 * 60 * 1000;

export function segmentNeedsFraming(segment: AgentSegment): boolean {
  return segment.framing == null;
}

export function isFramingJobActive(
  job: FramingJobSnapshot | null | undefined,
): boolean {
  if (!job) return false;
  if (job.status !== "pending" && job.status !== "analyzing") return false;
  const started = Date.parse(job.heartbeatAt ?? job.startedAt ?? "");
  // A job row with no readable timestamp counts as stale, matching what
  // analyzeFraming does with it. Calling it active instead would let one
  // half-written row disable auto-framing on the project forever; the framing
  // Lambda's own 409 is the guard that actually prevents a duplicate job.
  if (!Number.isFinite(started)) return false;
  return Date.now() - started < FRAMING_JOB_STALE_MS;
}

export function unframedSegmentIds(segments: AgentSegment[]): string[] {
  return segments.filter(segmentNeedsFraming).map((s) => s.id);
}

export async function readProjectSegmentsAndFraming(
  projectId: string,
): Promise<{ segments: AgentSegment[]; framingJob: FramingJobSnapshot | null }> {
  const result = await docClient.send(
    new GetCommand({ TableName: PROJECTS_TABLE, Key: { projectId } }),
  );
  const item = result.Item ?? {};
  const framing = item.framingJob as FramingJobSnapshot | undefined;
  return {
    segments: normalizeSegments(item.segments),
    framingJob: framing ?? null,
  };
}

export async function getTwelveLabsClient(): Promise<TwelveLabs | null> {
  if (cachedTwelveLabsKey === undefined) {
    const secretArn = process.env.SECRET_ARN;
    if (!secretArn) {
      cachedTwelveLabsKey = null;
    } else {
      try {
        const secret = await secretsClient.send(
          new GetSecretValueCommand({ SecretId: secretArn }),
        );
        cachedTwelveLabsKey = secret.SecretString?.trim() || null;
      } catch (err) {
        console.error("[IQAgent] Could not read the TwelveLabs API key:", err);
        cachedTwelveLabsKey = null;
      }
    }
  }
  if (!cachedTwelveLabsKey) return null;
  return new TwelveLabs({ apiKey: cachedTwelveLabsKey });
}

function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function asStringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumberOrUndefined(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function asNumberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
