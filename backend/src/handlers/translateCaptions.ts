import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Handler,
} from "aws-lambda";
import {
  DeleteObjectCommand,
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { checkAuth } from "../utils/auth";
import { translateCaptionLines, TRANSLATE_MODEL } from "../services/sporelabs";
import { presignS3Uri } from "../utils/s3";
import {
  groupWordsIntoCaptions,
  inferOriginalTranscriptLanguage,
  LEGACY_TRANSCRIPTION_VERSION,
  normalizeLanguageCode,
  parseTranscriptJson,
  transcriptVersionMatches,
  translationTranscriptKey,
  type CaptionLine,
} from "../utils/transcript-format";

const s3Client = new S3Client({});
const lambdaClient = new LambdaClient({});
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const BUCKET_NAME = process.env.BUCKET_NAME!;
const TRANSLATE_FUNCTION_NAME = process.env.TRANSLATE_FUNCTION_NAME!;

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

const TRANSLATE_TARGETS = new Set(["en", "es"]);

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

type TranslateWorkerEvent = {
  kind: "translate-captions-worker";
  projectId: string;
  targetLanguage: string;
  transcriptionVersion: string;
};

type TranslationStatus = "pending" | "ready" | "failed";

function isWorkerEvent(
  event: APIGatewayProxyEvent | TranslateWorkerEvent,
): event is TranslateWorkerEvent {
  return "kind" in event && event.kind === "translate-captions-worker";
}

function isConditionalFailure(err: unknown): boolean {
  return (err as { name?: string })?.name === "ConditionalCheckFailedException";
}

async function ensureTranscriptionVersion(
  asset: Record<string, unknown>,
): Promise<string> {
  if (typeof asset.transcriptionVersion === "string") {
    return asset.transcriptionVersion;
  }
  if (typeof asset.transcriptionUrl !== "string" || !asset.transcriptionUrl) {
    throw new Error("Original transcript is not ready yet");
  }
  const assetId = String(asset.assetId);
  const version = LEGACY_TRANSCRIPTION_VERSION;
  const inferredLanguage = inferOriginalTranscriptLanguage({
    assetId,
    originalLanguage: asset.originalLanguage,
    transcriptionUrl: asset.transcriptionUrl,
  });
  await docClient.send(
    new UpdateCommand({
      TableName: ASSETS_TABLE,
      Key: { assetId },
      UpdateExpression:
        "SET transcriptionVersion = if_not_exists(transcriptionVersion, :version), " +
        "#status = if_not_exists(#status, :ready), " +
        "originalLanguage = if_not_exists(originalLanguage, :language), updatedAt = :updatedAt",
      ConditionExpression:
        "attribute_exists(assetId) AND transcriptionUrl = :transcriptionUrl AND (attribute_not_exists(#status) OR #status <> :pending)",
      ExpressionAttributeNames: { "#status": "transcriptionStatus" },
      ExpressionAttributeValues: {
        ":version": version,
        ":ready": "ready",
        ":pending": "pending",
        ":language": inferredLanguage || "und",
        ":transcriptionUrl": asset.transcriptionUrl,
        ":updatedAt": new Date().toISOString(),
      },
    }),
  );
  asset.transcriptionVersion = version;
  asset.transcriptionStatus = asset.transcriptionStatus || "ready";
  if (!asset.originalLanguage && inferredLanguage) {
    asset.originalLanguage = inferredLanguage;
  }
  return version;
}

async function ensureTranslationMaps(
  assetId: string,
  transcriptionVersion: string,
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: ASSETS_TABLE,
      Key: { assetId },
      UpdateExpression:
        "SET translations = if_not_exists(translations, :empty), " +
        "translationStatuses = if_not_exists(translationStatuses, :empty), " +
        "translationErrors = if_not_exists(translationErrors, :empty), " +
        "translationStartedAt = if_not_exists(translationStartedAt, :empty)",
      ConditionExpression:
        "attribute_exists(assetId) AND transcriptionVersion = :version AND #status = :ready",
      ExpressionAttributeNames: { "#status": "transcriptionStatus" },
      ExpressionAttributeValues: {
        ":empty": {},
        ":version": transcriptionVersion,
        ":ready": "ready",
      },
    }),
  );
}

async function setTranslationStatus(
  assetId: string,
  language: string,
  status: TranslationStatus,
  transcriptionVersion: string,
  error?: string,
): Promise<void> {
  await ensureTranslationMaps(assetId, transcriptionVersion);
  await docClient.send(
    new UpdateCommand({
      TableName: ASSETS_TABLE,
      Key: { assetId },
      UpdateExpression:
        "SET #statuses.#language = :status, updatedAt = :updatedAt",
      ConditionExpression:
        "attribute_exists(#pk) AND transcriptionVersion = :version AND #transcriptionStatus = :ready",
      ExpressionAttributeNames: {
        "#statuses": "translationStatuses",
        "#language": language,
        "#pk": "assetId",
        "#transcriptionStatus": "transcriptionStatus",
      },
      ExpressionAttributeValues: {
        ":status": status,
        ":version": transcriptionVersion,
        ":ready": "ready",
        ":updatedAt": new Date().toISOString(),
      },
    }),
  );

  if (error) {
    await docClient.send(
      new UpdateCommand({
        TableName: ASSETS_TABLE,
        Key: { assetId },
        UpdateExpression: "SET #errors.#language = :error",
        ConditionExpression:
          "attribute_exists(#pk) AND transcriptionVersion = :version AND #transcriptionStatus = :ready",
        ExpressionAttributeNames: {
          "#errors": "translationErrors",
          "#language": language,
          "#pk": "assetId",
          "#transcriptionStatus": "transcriptionStatus",
        },
        ExpressionAttributeValues: {
          ":error": error,
          ":version": transcriptionVersion,
          ":ready": "ready",
        },
      }),
    );
  }
}

async function claimTranslation(
  assetId: string,
  language: string,
  transcriptionVersion: string,
): Promise<boolean> {
  await ensureTranslationMaps(assetId, transcriptionVersion);
  const now = new Date();
  const staleBefore = new Date(now.getTime() - 15 * 60_000).toISOString();
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: ASSETS_TABLE,
        Key: { assetId },
        UpdateExpression:
          "SET #statuses.#language = :pending, #started.#language = :updatedAt, updatedAt = :updatedAt",
        ConditionExpression:
          "attribute_exists(#pk) AND transcriptionVersion = :version AND #transcriptionStatus = :ready AND " +
          "(attribute_not_exists(#statuses.#language) OR #statuses.#language = :failed OR #statuses.#language = :ready OR #started.#language < :staleBefore)",
        ExpressionAttributeNames: {
          "#statuses": "translationStatuses",
          "#started": "translationStartedAt",
          "#language": language,
          "#pk": "assetId",
          "#transcriptionStatus": "transcriptionStatus",
        },
        ExpressionAttributeValues: {
          ":pending": "pending",
          ":failed": "failed",
          ":ready": "ready",
          ":version": transcriptionVersion,
          ":updatedAt": now.toISOString(),
          ":staleBefore": staleBefore,
        },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalFailure(err)) return false;
    throw err;
  }
}

function parseS3Uri(uri: string): { bucket: string; key: string } {
  const match = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`Invalid S3 URI: ${uri}`);
  return { bucket: match[1], key: match[2] };
}

async function loadJsonFromS3(s3Uri: string): Promise<unknown> {
  const { bucket, key } = parseS3Uri(s3Uri);
  const obj = await s3Client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  const text = await obj.Body?.transformToString();
  if (!text) throw new Error(`Empty object ${s3Uri}`);
  return JSON.parse(text);
}

async function getProjectAndAsset(projectId: string) {
  const projectRes = await docClient.send(
    new GetCommand({ TableName: PROJECTS_TABLE, Key: { projectId } }),
  );
  const project = projectRes.Item;
  if (!project) return { project: null, asset: null };

  const assetRes = await docClient.send(
    new GetCommand({
      TableName: ASSETS_TABLE,
      Key: { assetId: project.assetId },
      ConsistentRead: true,
    }),
  );
  return { project, asset: assetRes.Item || null };
}

async function translateWorker(event: TranslateWorkerEvent): Promise<void> {
  const { projectId, targetLanguage, transcriptionVersion } = event;
  let assetId: string | undefined;
  let writtenKey: string | null = null;
  try {
    if (!TRANSLATE_TARGETS.has(targetLanguage)) {
      throw new Error(`Unsupported target language: ${targetLanguage}`);
    }
    const { project, asset } = await getProjectAndAsset(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    if (!asset) throw new Error(`Asset ${project.assetId} not found`);
    assetId = String(asset.assetId);
    const currentVersion = await ensureTranscriptionVersion(asset);
    if (!transcriptVersionMatches(currentVersion, transcriptionVersion)) {
      console.log(
        `[translateCaptions worker] discarded stale run ${transcriptionVersion}; current=${currentVersion}`,
      );
      return;
    }
    if (asset.transcriptionStatus === "pending") {
      throw new Error("Original transcript is still being prepared");
    }
    await setTranslationStatus(
      assetId,
      targetLanguage,
      "pending",
      transcriptionVersion,
    );

    const existing =
      asset.translations && typeof asset.translations === "object"
        ? (asset.translations as Record<string, string>)
        : {};
    if (existing[targetLanguage]) {
      await setTranslationStatus(
        assetId,
        targetLanguage,
        "ready",
        transcriptionVersion,
      );
      return;
    }
    if (!asset.transcriptionUrl) {
      throw new Error("Original transcript is not ready yet");
    }

    const parsed = parseTranscriptJson(
      await loadJsonFromS3(asset.transcriptionUrl),
    );
    const parsedLanguage =
      parsed.kind === "original" ? parsed.language : parsed.sourceLanguage;
    const sourceLines =
      parsed.kind === "original"
        ? groupWordsIntoCaptions(parsed.words)
        : parsed.lines;
    const originalLanguage =
      inferOriginalTranscriptLanguage({
        assetId,
        originalLanguage: asset.originalLanguage,
        transcriptionUrl: asset.transcriptionUrl,
        parsedLanguage,
      }) || "und";
    if (targetLanguage === originalLanguage) {
      throw new Error("Target language is the original language");
    }
    if (sourceLines.length === 0) {
      throw new Error("Original transcript has no caption lines");
    }

    const translated = await translateCaptionLines({
      sourceLanguage: originalLanguage,
      targetLanguage,
      lines: sourceLines.map((line) => line.text),
    });
    if (
      translated.some(
        (line, index) =>
          sourceLines[index].text.trim().length > 0 && line.trim().length === 0,
      )
    ) {
      throw new Error("Translation returned one or more empty caption lines");
    }
    const lines: CaptionLine[] = sourceLines.map((line, index) => ({
      id: `caption-${targetLanguage}-${index}`,
      startTime: line.startTime,
      endTime: line.endTime,
      text: translated[index],
      words: [],
    }));

    const s3Key = translationTranscriptKey(
      assetId,
      transcriptionVersion,
      targetLanguage,
    );
    writtenKey = s3Key;
    const translationUri = `s3://${BUCKET_NAME}/${s3Key}`;
    await s3Client.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: s3Key,
        Body: JSON.stringify({
          language: targetLanguage,
          sourceLanguage: originalLanguage,
          transcriptionVersion,
          model: TRANSLATE_MODEL,
          generatedAt: new Date().toISOString(),
          lines: lines.map(({ id, startTime, endTime, text }) => ({
            id,
            start: startTime,
            end: endTime,
            startTime,
            endTime,
            text,
          })),
        }),
        ContentType: "application/json",
      }),
    );

    try {
      await docClient.send(
        new UpdateCommand({
          TableName: ASSETS_TABLE,
          Key: { assetId },
          UpdateExpression:
            "SET #translations.#language = :uri, originalLanguage = if_not_exists(originalLanguage, :original), " +
            "#statuses.#language = :ready, updatedAt = :updatedAt",
          ConditionExpression:
            "attribute_exists(#pk) AND transcriptionVersion = :version AND #transcriptionStatus = :ready",
          ExpressionAttributeNames: {
            "#translations": "translations",
            "#statuses": "translationStatuses",
            "#language": targetLanguage,
            "#pk": "assetId",
            "#transcriptionStatus": "transcriptionStatus",
          },
          ExpressionAttributeValues: {
            ":uri": translationUri,
            ":original": originalLanguage,
            ":ready": "ready",
            ":version": transcriptionVersion,
            ":updatedAt": new Date().toISOString(),
          },
        }),
      );
    } catch (err) {
      if (!isConditionalFailure(err)) throw err;
      await s3Client.send(
        new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: s3Key }),
      );
      writtenKey = null;
      console.log(
        `[translateCaptions worker] discarded result for superseded source ${transcriptionVersion}`,
      );
      return;
    }
  } catch (err) {
    console.error("[translateCaptions worker]", err);
    if (assetId) {
      const message =
        err instanceof Error ? err.message : "Unknown translation error";
      await setTranslationStatus(
        assetId,
        targetLanguage,
        "failed",
        transcriptionVersion,
        message.slice(0, 500),
      ).catch((statusErr) =>
        console.error("[translateCaptions worker status]", statusErr),
      );
    }
    if (writtenKey && isConditionalFailure(err)) {
      await s3Client
        .send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: writtenKey }))
        .catch(() => undefined);
    }
    throw err;
  }
}

async function handleApi(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  const projectId = event.pathParameters?.projectId;
  if (!projectId) return json(400, { error: "Missing projectId" });

  let targetLanguage = "es";
  try {
    const body = JSON.parse(event.body || "{}") as { targetLanguage?: string };
    if (body.targetLanguage) {
      targetLanguage = normalizeLanguageCode(body.targetLanguage);
    }
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  if (!TRANSLATE_TARGETS.has(targetLanguage)) {
    return json(400, {
      error: "Unsupported target language",
      allowed: [...TRANSLATE_TARGETS],
    });
  }

  try {
    const { project, asset } = await getProjectAndAsset(projectId);
    if (!project) return json(404, { error: "Project not found" });
    if (!asset) return json(404, { error: "Asset not found" });
    if (asset.transcriptionStatus === "pending") {
      return json(409, {
        error: "Original transcript is still being prepared",
      });
    }
    if (!asset.transcriptionUrl) {
      return json(409, { error: "Original transcript is not ready yet" });
    }
    const transcriptionVersion = await ensureTranscriptionVersion(asset);
    const originalLanguage =
      inferOriginalTranscriptLanguage({
        assetId: String(asset.assetId),
        originalLanguage: asset.originalLanguage,
        transcriptionUrl: asset.transcriptionUrl,
      }) || "und";

    const existing =
      asset.translations && typeof asset.translations === "object"
        ? (asset.translations as Record<string, string>)
        : {};

    if (existing[targetLanguage]) {
      await setTranslationStatus(
        asset.assetId,
        targetLanguage,
        "ready",
        transcriptionVersion,
      );
      return json(200, {
        language: targetLanguage,
        sourceLanguage: originalLanguage,
        status: "ready",
        cached: true,
        transcriptionVersion,
        translationUrl: await presignS3Uri(existing[targetLanguage]),
      });
    }
    if (targetLanguage === originalLanguage) {
      return json(400, { error: "Target language is the original language" });
    }

    const claimed = await claimTranslation(
      asset.assetId,
      targetLanguage,
      transcriptionVersion,
    );
    if (claimed) {
      if (!TRANSLATE_FUNCTION_NAME) {
        await setTranslationStatus(
          asset.assetId,
          targetLanguage,
          "failed",
          transcriptionVersion,
          "Translation worker is not configured",
        );
        return json(500, { error: "Translation worker is not configured" });
      }
      try {
        await lambdaClient.send(
          new InvokeCommand({
            FunctionName: TRANSLATE_FUNCTION_NAME,
            InvocationType: "Event",
            Payload: Buffer.from(
              JSON.stringify({
                kind: "translate-captions-worker",
                projectId,
                targetLanguage,
                transcriptionVersion,
              } satisfies TranslateWorkerEvent),
            ),
          }),
        );
      } catch (err) {
        await setTranslationStatus(
          asset.assetId,
          targetLanguage,
          "failed",
          transcriptionVersion,
          "Could not start translation worker",
        );
        throw err;
      }
    }

    return json(202, {
      language: targetLanguage,
      sourceLanguage: originalLanguage,
      status: "pending",
      alreadyPending: !claimed,
      transcriptionVersion,
    });
  } catch (err) {
    console.error("[translateCaptions]", err);
    return json(500, { error: "Translation failed" });
  }
}

export const handler: Handler<
  APIGatewayProxyEvent | TranslateWorkerEvent,
  APIGatewayProxyResult | void
> = async (event) => {
  if (isWorkerEvent(event)) {
    await translateWorker(event);
    return;
  }
  return handleApi(event);
};
