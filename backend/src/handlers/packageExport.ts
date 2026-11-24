import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Handler,
} from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { PassThrough, type Readable } from "stream";
import archiver from "archiver";
import { checkAuth } from "../utils/auth";
import {
  buildExportPackageLayout,
  exportPackageObjectKey,
  localizeExportMetadataDocument,
  sceneVideoFilename,
} from "../utils/exportPackageLayout";
import { computeExportPackageFingerprint } from "../utils/exportPackageFingerprint";
import {
  aeoReadme,
  buildSceneJsonLd,
  buildVideoSitemap,
  formatSrt,
  formatTranscript,
  formatVtt,
  sceneCaptionCues,
  type AeoExportScene,
} from "../utils/aeo-export-files";
import {
  captionsFromParsedTranscript,
  parseTranscriptJson,
  type CaptionLine,
} from "../utils/transcript-format";
import { captionGroupingOptions } from "../utils/caption-grouping";
import {
  DEFAULT_CAPTION_SETTINGS,
  mergeCaptionSettings,
} from "../utils/caption-settings";
import { resolveRenderTranscriptCandidates } from "../utils/transcript-source";
import { presignS3Uri } from "../utils/s3";
import {
  buildContactSheetHtml,
  buildSelectionLog,
  compactThumbnail,
  thumbnailNotes,
  type ThumbnailSceneInput,
} from "../utils/thumbnail-export-files";
import { showSlug } from "../services/thumbnails/frameMath";
import type { StoredThumbnailSet } from "../services/thumbnails/setPass";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});
const lambdaClient = new LambdaClient({});

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE;
const MEDIA_BUCKET = process.env.BUCKET_NAME!;
const RENDERS_BUCKET = process.env.RENDERS_BUCKET!;
const SELF_FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME!;
const PRESIGN_TTL_SEC = 43_200;
const IN_FLIGHT_JOB_MAX_MS = 15 * 60 * 1000;

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

type PackageStatus = "pending" | "packaging" | "completed" | "failed";

interface ExportPackageJob {
  status: PackageStatus;
  jobId: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
  warnings?: string[];
  bucket?: string;
  key?: string;
  filename?: string;
  fingerprint?: string;
}

interface RequestBody {
  segmentIds?: string[];
  includeThumbnails?: boolean;
  includePoster?: boolean;
  projectTitle?: string;
  /** The producer's IANA time zone, for the date-time in the zip name. */
  timeZone?: string;
  metadataDocument?: {
    projectThumbnailUrl?: string | null;
    scenes: Array<{ segmentId: string; thumbnailUrl?: string | null }>;
    /** Producer show info, when Series & Episode is switched on. */
    show?: unknown;
    [key: string]: unknown;
  } | null;
  /** Search, targeting & AEO files to add to the zip. */
  aeoFiles?: AeoFileOptions;
}

interface AeoFileOptions {
  transcript?: boolean;
  captions?: boolean;
  schemaOrg?: boolean;
  videoSitemap?: boolean;
}

function wantsAeoFiles(options: AeoFileOptions | undefined): boolean {
  return Boolean(
    options &&
      (options.transcript || options.captions || options.schemaOrg || options.videoSitemap),
  );
}

function wantsCaptionText(options: AeoFileOptions | undefined): boolean {
  return Boolean(options?.transcript || options?.captions || options?.schemaOrg);
}

async function readAsset(assetId: unknown): Promise<Record<string, unknown> | null> {
  if (!ASSETS_TABLE || typeof assetId !== "string" || !assetId) return null;
  const result = await dynamo.send(
    new GetCommand({ TableName: ASSETS_TABLE, Key: { assetId } }),
  );
  return (result.Item as Record<string, unknown> | undefined) ?? null;
}

/** Which frame each scene's thumbnail is, so a new pick or swap rebuilds the zip. */
function thumbnailRevision(project: Record<string, unknown>): string {
  const meta = (project.segmentMetadata || []) as StoredSegmentMetadata[];
  return JSON.stringify(
    meta.map((m) => [
      m.segmentId,
      m.thumbnailVersion ?? 1,
      m.thumbnailPick?.exported?.time ?? null,
      m.thumbnailPick?.runnerUp ?? null,
    ]),
  );
}

/** Show name for runbook thumbnail filenames: the series, else the project title. */
function showNameFor(asset: Record<string, unknown> | null, projectTitle: string): string {
  const series = (asset?.showInfo as { series?: unknown } | undefined)?.series;
  return typeof series === "string" && series.trim() ? series.trim() : projectTitle;
}

/** Inputs that change exported caption text, so the package fingerprint sees edits. */
function captionRevision(
  project: Record<string, unknown>,
  asset: Record<string, unknown> | null,
): string {
  const settings = mergeCaptionSettings(
    DEFAULT_CAPTION_SETTINGS,
    project.captionSettings as Parameters<typeof mergeCaptionSettings>[1],
  );
  const framing = project.globalFraming as { aspectRatio?: string } | undefined;
  return JSON.stringify({
    wordEdits: settings.wordEdits ?? null,
    language: settings.activeLanguage ?? null,
    style: settings.style ?? null,
    aspect: framing?.aspectRatio ?? null,
    transcriptionVersion: asset?.transcriptionVersion ?? null,
    transcriptionUrl: asset?.transcriptionUrl ?? null,
    translations: asset?.translations ?? null,
  });
}

/**
 * Caption lines for the whole source, built exactly as the renderer builds
 * the burned-in captions: same transcript choice, word edits and grouping.
 */
async function loadCaptionLines(
  project: Record<string, unknown>,
  asset: Record<string, unknown> | null,
): Promise<CaptionLine[] | null> {
  if (!asset) return null;
  const settings = mergeCaptionSettings(
    DEFAULT_CAPTION_SETTINGS,
    project.captionSettings as Parameters<typeof mergeCaptionSettings>[1],
  );
  const framing = project.globalFraming as { aspectRatio?: string } | undefined;
  const uris = resolveRenderTranscriptCandidates({
    assetId: typeof asset.assetId === "string" ? asset.assetId : String(project.assetId ?? ""),
    activeLanguage: settings.activeLanguage,
    originalLanguage: typeof asset.originalLanguage === "string" ? asset.originalLanguage : undefined,
    transcriptionVersion:
      typeof asset.transcriptionVersion === "string" ? asset.transcriptionVersion : undefined,
    translations:
      asset.translations && typeof asset.translations === "object"
        ? (asset.translations as Record<string, string>)
        : {},
    transcriptionUrl: typeof asset.transcriptionUrl === "string" ? asset.transcriptionUrl : null,
  });
  for (const uri of uris) {
    try {
      const url = await presignS3Uri(uri);
      if (!url) continue;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = parseTranscriptJson(await response.json());
      return captionsFromParsedTranscript(
        parsed,
        parsed.kind === "original" ? settings.wordEdits : undefined,
        captionGroupingOptions(settings.style, framing?.aspectRatio ?? "9:16"),
      );
    } catch (err) {
      console.warn(`[packageExport] transcript ${uri} unusable:`, err);
    }
  }
  return null;
}

interface AsyncJobPayload {
  kind: "package-export-worker";
  projectId: string;
  jobId: string;
  body: RequestBody;
  fingerprint: string;
  renderSnapshot: StoredSegmentRender[];
}

interface StoredSegmentRender {
  segmentId: string;
  title?: string;
  bucket: string;
  key: string;
  renderedAt?: string;
  contentHash?: string;
  sourceBucket?: string;
  sourceKey?: string;
}

type StoredSegmentMetadata = Pick<
  import("../types/segment-metadata").StoredSegmentMetadata,
  "segmentId" | "thumbnailKey" | "thumbnailVersion" | "thumbnailPick"
>;

function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}

async function presignPackage(
  bucket: string,
  key: string,
  filename: string,
): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, "")}"`,
    }),
    { expiresIn: PRESIGN_TTL_SEC },
  );
}

async function objectExists(bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function readJob(projectId: string): Promise<ExportPackageJob | undefined> {
  const result = await dynamo.send(
    new GetCommand({
      TableName: PROJECTS_TABLE,
      Key: { projectId },
      ProjectionExpression: "exportPackageJob",
    }),
  );
  return result.Item?.exportPackageJob as ExportPackageJob | undefined;
}

async function writeJob(
  projectId: string,
  job: ExportPackageJob,
  expectedJobId?: string,
): Promise<void> {
  await dynamo.send(
    new UpdateCommand({
      TableName: PROJECTS_TABLE,
      Key: { projectId },
      UpdateExpression: "SET exportPackageJob = :job, updatedAt = :now",
      ...(expectedJobId
        ? {
            ConditionExpression: "exportPackageJob.jobId = :expectedJobId",
            ExpressionAttributeValues: {
              ":job": job,
              ":now": new Date().toISOString(),
              ":expectedJobId": expectedJobId,
            },
          }
        : {
            ExpressionAttributeValues: {
              ":job": job,
              ":now": new Date().toISOString(),
            },
          }),
    }),
  );
}

async function jobResponse(job: ExportPackageJob) {
  let downloadUrl: string | undefined;
  if (job.status === "completed" && job.bucket && job.key && job.filename) {
    downloadUrl = await presignPackage(job.bucket, job.key, job.filename);
  }
  return {
    status: job.status,
    jobId: job.jobId,
    filename: job.filename,
    downloadUrl,
    error: job.error,
    warnings: job.warnings,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
}

async function handleGet(
  projectId: string,
): Promise<APIGatewayProxyResult> {
  const job = await readJob(projectId);
  if (!job) return json(404, { error: "No export package job found" });
  return json(200, await jobResponse(job));
}

/**
 * GET ?sceneVideo=<segmentId>&sceneNumber=<n>&title=<t>: a link to one scene's
 * latest render that downloads as scene_NN_Title.mp4.
 */
async function handleSceneVideoDownload(
  projectId: string,
  query: Record<string, string | undefined>,
): Promise<APIGatewayProxyResult> {
  const project = (
    await dynamo.send(
      new GetCommand({ TableName: PROJECTS_TABLE, Key: { projectId } }),
    )
  ).Item;
  const render = ((project?.segmentRenders || []) as StoredSegmentRender[]).find(
    (r) => r.segmentId === query.sceneVideo,
  );
  if (!render) return json(404, { error: "No rendered video for this scene" });
  const filename = sceneVideoFilename(
    Number(query.sceneNumber) || 1,
    query.title || render.title || "scene",
  );
  return json(200, {
    downloadUrl: await presignPackage(render.bucket, render.key, filename),
  });
}

async function handleStart(
  projectId: string,
  body: RequestBody,
): Promise<APIGatewayProxyResult> {
  const project = (
    await dynamo.send(
      new GetCommand({ TableName: PROJECTS_TABLE, Key: { projectId } }),
    )
  ).Item;
  if (!project) return json(404, { error: "Project not found" });

  const effectiveBody: RequestBody = {
    ...body,
    projectTitle:
      body.projectTitle ||
      (typeof project.title === "string" ? project.title : "Untitled"),
  };
  const renderSnapshot = (project.segmentRenders || []) as StoredSegmentRender[];
  const fingerprint = computeExportPackageFingerprint(
    {
      ...effectiveBody,
      ...(body.includeThumbnails !== false
        ? { thumbnailRevision: thumbnailRevision(project) }
        : {}),
      ...(wantsAeoFiles(body.aeoFiles)
        ? {
            aeoFiles: body.aeoFiles,
            captionRevision: wantsCaptionText(body.aeoFiles)
              ? captionRevision(project, await readAsset(project.assetId))
              : undefined,
          }
        : {}),
    },
    renderSnapshot,
  );
  const existing = project.exportPackageJob as ExportPackageJob | undefined;
  if (
    existing?.status === "completed" &&
    existing.fingerprint === fingerprint &&
    existing.bucket &&
    existing.key &&
    (await objectExists(existing.bucket, existing.key))
  ) {
    return json(200, await jobResponse(existing));
  }
  if (
    existing &&
    (existing.status === "pending" || existing.status === "packaging") &&
    existing.fingerprint === fingerprint &&
    existing.startedAt &&
    Date.now() - new Date(existing.startedAt).getTime() < IN_FLIGHT_JOB_MAX_MS
  ) {
    return json(202, await jobResponse(existing));
  }

  const jobId = randomUUID();
  const startedAt = new Date().toISOString();
  const job: ExportPackageJob = {
    status: "pending",
    jobId,
    startedAt,
    fingerprint,
  };
  await writeJob(projectId, job);

  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: SELF_FUNCTION_NAME,
      InvocationType: "Event",
      Payload: JSON.stringify({
        kind: "package-export-worker",
        projectId,
        jobId,
        body: effectiveBody,
        fingerprint,
        renderSnapshot,
      } satisfies AsyncJobPayload),
    }),
  );

  return json(202, await jobResponse(job));
}

async function appendS3Object(
  archive: archiver.Archiver,
  bucket: string,
  key: string,
  zipPath: string,
  store: boolean,
): Promise<void> {
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!obj.Body) throw new Error(`Empty object s3://${bucket}/${key}`);
  const body = obj.Body as Readable;
  await new Promise<void>((resolve, reject) => {
    body.once("error", reject);
    body.once("end", resolve);
    archive.append(body, { name: zipPath, store });
  });
}

/**
 * Adds "<Project> AEO/": per-scene captions, transcript and JSON-LD, a video
 * sitemap and a README. Missing inputs become warnings, never a failed zip:
 * the videos are the deliverable.
 */
async function appendAeoFiles(params: {
  archive: archiver.Archiver;
  project: Record<string, unknown>;
  body: RequestBody;
  layout: ReturnType<typeof buildExportPackageLayout>;
  selected: Array<{ id: string; startTime: number; endTime: number }>;
  includedThumbs: Set<string>;
  warnings: string[];
}): Promise<void> {
  const { archive, project, body, layout, selected, includedThumbs, warnings } = params;
  const options = body.aeoFiles ?? {};
  const folder = `${layout.rootFolder}/${layout.rootFolder} AEO`;
  const show = body.metadataDocument?.show;
  const docScenes = new Map(
    ((body.metadataDocument?.scenes ?? []) as Array<AeoExportScene & { segmentId: string }>).map(
      (scene) => [scene.segmentId, scene],
    ),
  );

  let captions: CaptionLine[] | null = null;
  if (wantsCaptionText(options)) {
    captions = await loadCaptionLines(project, await readAsset(project.assetId));
    if (!captions && (options.captions || options.transcript)) {
      warnings.push("Skipped captions and transcripts: no transcript is available for this video.");
    }
  }

  const sitemapEntries: Parameters<typeof buildVideoSitemap>[0] = [];
  for (const scene of layout.scenes) {
    const segment = selected.find((s) => s.id === scene.segmentId);
    if (!segment) continue;
    const base = scene.videoFilename.replace(/\.mp4$/, "");
    const cues = captions
      ? sceneCaptionCues(captions, segment.startTime, segment.endTime)
      : [];
    if (captions && options.captions) {
      archive.append(formatSrt(cues), { name: `${folder}/${base}.srt` });
      archive.append(formatVtt(cues), { name: `${folder}/${base}.vtt` });
    }
    if (captions && options.transcript) {
      archive.append(formatTranscript(cues), { name: `${folder}/${base}.txt` });
    }

    const docScene = docScenes.get(scene.segmentId);
    if (!docScene) continue;
    const files = {
      video: scene.videoFilename,
      ...(includedThumbs.has(scene.segmentId) ? { thumbnail: scene.thumbnailFilename } : {}),
    };
    if (options.schemaOrg) {
      const jsonLd = buildSceneJsonLd({
        scene: docScene,
        show,
        files,
        transcript: options.transcript && cues.length ? formatTranscript(cues) : undefined,
      });
      archive.append(JSON.stringify(jsonLd, null, 2), { name: `${folder}/${base}.jsonld` });
    }
    sitemapEntries.push({ scene: docScene, files });
  }

  if (options.videoSitemap) {
    if (sitemapEntries.length) {
      archive.append(buildVideoSitemap(sitemapEntries), { name: `${folder}/video-sitemap.xml` });
    } else {
      warnings.push("Skipped the video sitemap: turn on metadata to include scene details.");
    }
  }
  if (options.schemaOrg && docScenes.size === 0) {
    warnings.push("Skipped Schema.org files: turn on metadata to include scene details.");
  }

  archive.append(
    aeoReadme({
      show,
      files: {
        captions: Boolean(options.captions && captions),
        transcript: Boolean(options.transcript && captions),
        schemaOrg: Boolean(options.schemaOrg && docScenes.size),
        videoSitemap: Boolean(options.videoSitemap && sitemapEntries.length),
      },
    }),
    { name: `${folder}/README.txt` },
  );
}

async function runWorker(event: AsyncJobPayload): Promise<void> {
  const { projectId, jobId, body, fingerprint, renderSnapshot } = event;
  const warnings: string[] = [];

  const markFailed = async (error: string) => {
    await writeJob(
      projectId,
      {
        status: "failed",
        jobId,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error,
        warnings,
        fingerprint,
      },
      jobId,
    ).catch((err) => console.error("[packageExport] failed to mark failed", err));
  };

  try {
    await writeJob(
      projectId,
      {
        status: "packaging",
        jobId,
        startedAt: new Date().toISOString(),
        fingerprint,
      },
      jobId,
    );

    const project = (
      await dynamo.send(
        new GetCommand({ TableName: PROJECTS_TABLE, Key: { projectId } }),
      )
    ).Item;
    if (!project) {
      await markFailed("Project not found");
      return;
    }

    // Chronological order = project scene numbers (older projects may be
    // stored unsorted).
    const segments = [
      ...((project.segments || []) as Array<{
        id: string;
        title?: string;
        startTime: number;
        endTime: number;
      }>),
    ].sort((a, b) => a.startTime - b.startTime);
    const requested = new Set(
      (body.segmentIds?.length ? body.segmentIds : segments.map((s) => s.id)),
    );
    const selected = segments.filter((s) => requested.has(s.id));
    if (selected.length === 0) {
      await markFailed("No scenes selected");
      return;
    }

    const renders = new Map(
      renderSnapshot.map((render) => [render.segmentId, render]),
    );
    const metadata = new Map(
      ((project.segmentMetadata || []) as StoredSegmentMetadata[]).map((m) => [
        m.segmentId,
        m,
      ]),
    );

    const projectTitle =
      body.projectTitle ||
      (typeof project.title === "string" ? project.title : "Untitled");
    const includeThumbnails = body.includeThumbnails !== false;
    const includePoster = body.includePoster !== false;
    const sceneNumbers = new Map(segments.map((s, i) => [s.id, i + 1]));
    const showName = showNameFor(await readAsset(project.assetId), projectTitle);
    const layout = buildExportPackageLayout({
      projectTitle,
      showName,
      scenes: selected.map((s) => ({
        segmentId: s.id,
        title: s.title || "scene",
        sceneNumber: sceneNumbers.get(s.id),
        startTime: s.startTime,
      })),
      exportedAt: new Date(),
      timeZone: body.timeZone,
    });

    const zipKey = exportPackageObjectKey(projectId, jobId);
    const zipStream = new PassThrough();
    const archive = archiver("zip", { zlib: { level: 0 } });
    archive.on("warning", (err) => {
      if (err.code === "ENOENT") warnings.push(err.message);
      else throw err;
    });
    archive.pipe(zipStream);

    const upload = new Upload({
      client: s3,
      params: {
        Bucket: RENDERS_BUCKET,
        Key: zipKey,
        Body: zipStream,
        ContentType: "application/zip",
        ContentDisposition: `attachment; filename="${layout.zipFilename.replace(/"/g, "")}"`,
      },
    });
    const uploadDone = upload.done();

    let requiredVideos = 0;
    for (const scene of layout.scenes) {
      const render = renders.get(scene.segmentId);
      const renderBucket = render?.sourceBucket || render?.bucket;
      const renderKey = render?.sourceKey || render?.key;
      if (!renderBucket || !renderKey) {
        warnings.push(`No rendered video for ${scene.videoFilename}`);
        continue;
      }
      await appendS3Object(
        archive,
        renderBucket,
        renderKey,
        scene.videoPath,
        true,
      );
      requiredVideos += 1;
    }
    if (requiredVideos === 0) {
      archive.abort();
      zipStream.destroy();
      await upload.abort().catch(() => undefined);
      await markFailed("No rendered scene videos are ready to download.");
      return;
    }

    const includedThumbs = new Set<string>();
    let thumbnailSceneInputs: ThumbnailSceneInput[] = [];
    if (includeThumbnails) {
      for (const scene of layout.scenes) {
        const key = metadata.get(scene.segmentId)?.thumbnailKey;
        if (!key) continue;
        try {
          await appendS3Object(
            archive,
            MEDIA_BUCKET,
            key,
            scene.thumbnailPath,
            false,
          );
          includedThumbs.add(scene.segmentId);
        } catch (err) {
          warnings.push(
            `Skipped ${scene.thumbnailFilename}: ${err instanceof Error ? err.message : "download failed"}`,
          );
        }
      }

      // Thumbnail Runbook review files: runner-up previews, selection log,
      // contact sheet (Steps 7–8)
      const thumbScenes: ThumbnailSceneInput[] = [];
      for (const scene of layout.scenes) {
        const pick = metadata.get(scene.segmentId)?.thumbnailPick;
        const input: ThumbnailSceneInput = {
          sceneNumber: scene.sceneNumber,
          title: selected.find((s) => s.id === scene.segmentId)?.title || `Scene ${scene.sceneNumber}`,
          filename: scene.thumbnailFilename,
          pick,
        };
        const runner = pick && pick.runnerUp >= 0 ? pick.candidates[pick.runnerUp] : undefined;
        if (runner && layout.thumbnailFolder) {
          const file = `review/${scene.thumbnailFilename.replace(/\.jpg$/, "")}_runner_up.jpg`;
          try {
            await appendS3Object(archive, MEDIA_BUCKET, runner.previewKey, `${layout.rootFolder}/${layout.thumbnailFolder}/${file}`, false);
            input.runnerUpFile = file;
          } catch {
            // The contact sheet says "no runner-up" for this scene.
          }
        }
        thumbScenes.push(input);
      }
      if (layout.thumbnailFolder && includedThumbs.size > 0) {
        const slug = showSlug(showName);
        const set = project.thumbnailSet as StoredThumbnailSet | undefined;
        const folder = `${layout.rootFolder}/${layout.thumbnailFolder}`;
        archive.append(JSON.stringify(buildSelectionLog(thumbScenes, set), null, 2), {
          name: `${folder}/${slug}_thumbnail_selection.json`,
        });
        archive.append(buildContactSheetHtml({ showName, scenes: thumbScenes, set }), {
          name: `${folder}/${slug}_thumbnail_contact_sheet.html`,
        });
      }
      thumbnailSceneInputs = thumbScenes;

      const posterKey =
        typeof project.thumbnailKey === "string" ? project.thumbnailKey : null;
      if (includePoster && posterKey) {
        try {
          await appendS3Object(
            archive,
            MEDIA_BUCKET,
            posterKey,
            layout.posterPath,
            false,
          );
        } catch (err) {
          warnings.push(
            `Skipped poster: ${err instanceof Error ? err.message : "download failed"}`,
          );
        }
      }
    }

    if (wantsAeoFiles(body.aeoFiles)) {
      await appendAeoFiles({
        archive,
        project,
        body,
        layout,
        selected,
        includedThumbs,
        warnings,
      });
    }

    if (body.metadataDocument) {
      const localized = localizeExportMetadataDocument(
        body.metadataDocument,
        layout,
        {
          includePoster: includePoster && Boolean(project.thumbnailKey),
          includeThumbnails,
          includedThumbnailSegmentIds: includedThumbs,
        },
      );
      // Thumbnail Runbook fields: compact_thumbnail on every scene, _notes.thumbnails
      const byId = new Map(layout.scenes.map((s) => [s.segmentId, s]));
      const withFields = {
        ...localized,
        scenes: localized.scenes.map((scene) => {
          const entry = byId.get(scene.segmentId);
          return entry ? { ...scene, compact_thumbnail: compactThumbnail(entry.thumbnailFilename) } : scene;
        }),
        _notes: {
          ...((localized as { _notes?: Record<string, unknown> })._notes ?? {}),
          thumbnails: includeThumbnails
            ? thumbnailNotes(thumbnailSceneInputs)
            : "Fields only: no thumbnail images were included in this package. CDN path not assigned: timestamp_link values are placeholders.",
        },
      };
      archive.append(JSON.stringify(withFields, null, 2), {
        name: `${layout.rootFolder}/${layout.metadataFilename}`,
      });
    }

    await archive.finalize();
    await uploadDone;

    await writeJob(
      projectId,
      {
        status: "completed",
        jobId,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        bucket: RENDERS_BUCKET,
        key: zipKey,
        filename: layout.zipFilename,
        fingerprint,
        warnings: warnings.length ? warnings : undefined,
      },
      jobId,
    );
    console.log(
      `[packageExport] wrote s3://${RENDERS_BUCKET}/${zipKey} (${layout.zipFilename})`,
    );
  } catch (err) {
    console.error("[packageExport] worker failed", err);
    await markFailed(err instanceof Error ? err.message : "Packaging failed");
  }
}

async function handleApi(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  const projectId = event.pathParameters?.projectId;
  if (!projectId) return json(400, { error: "Missing projectId" });

  const method =
    (event as unknown as { requestContext?: { http?: { method?: string } } })
      .requestContext?.http?.method || event.httpMethod;
  if (method === "GET") {
    const query = event.queryStringParameters || {};
    if (query.sceneVideo) return handleSceneVideoDownload(projectId, query);
    return handleGet(projectId);
  }

  let body: RequestBody = {};
  try {
    body = JSON.parse(event.body || "{}") as RequestBody;
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  return handleStart(projectId, body);
}

export const handler: Handler<
  APIGatewayProxyEvent | AsyncJobPayload,
  APIGatewayProxyResult | void
> = async (event) => {
  if (event && typeof event === "object" && "kind" in event) {
    if ((event as AsyncJobPayload).kind === "package-export-worker") {
      await runWorker(event as AsyncJobPayload);
      return;
    }
  }
  return handleApi(event as APIGatewayProxyEvent);
};
