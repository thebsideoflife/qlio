import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Handler,
} from "aws-lambda";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { checkAuth } from "../utils/auth";
import { getOpenRouterApiKey, translateCaptionLines, TRANSLATE_MODEL } from "../services/openrouter";
import { presignS3Uri } from "../utils/s3";
import {
  groupWordsIntoCaptions,
  normalizeLanguageCode,
  parseTranscriptJson,
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

async function ensureMap(assetId: string, attribute: string): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: ASSETS_TABLE,
      Key: { assetId },
      UpdateExpression: "SET #map = if_not_exists(#map, :empty)",
      ConditionExpression: "attribute_exists(#pk)",
      ExpressionAttributeNames: { "#map": attribute, "#pk": "assetId" },
      ExpressionAttributeValues: { ":empty": {} },
    }),
  );
}

async function setTranslationStatus(
  assetId: string,
  language: string,
  status: TranslationStatus,
  error?: string,
): Promise<void> {
  await ensureMap(assetId, "translationStatuses");
  await docClient.send(
    new UpdateCommand({
      TableName: ASSETS_TABLE,
      Key: { assetId },
      UpdateExpression:
        "SET #statuses.#language = :status, updatedAt = :updatedAt",
      ConditionExpression: "attribute_exists(#pk)",
      ExpressionAttributeNames: {
        "#statuses": "translationStatuses",
        "#language": language,
        "#pk": "assetId",
      },
      ExpressionAttributeValues: {
        ":status": status,
        ":updatedAt": new Date().toISOString(),
      },
    }),
  );

  if (error) {
    await ensureMap(assetId, "translationErrors");
    await docClient.send(
      new UpdateCommand({
        TableName: ASSETS_TABLE,
        Key: { assetId },
        UpdateExpression: "SET #errors.#language = :error",
        ConditionExpression: "attribute_exists(#pk)",
        ExpressionAttributeNames: {
          "#errors": "translationErrors",
          "#language": language,
          "#pk": "assetId",
        },
        ExpressionAttributeValues: { ":error": error },
      }),
    );
  }
}

async function claimTranslation(
  assetId: string,
  language: string,
): Promise<boolean> {
  await ensureMap(assetId, "translationStatuses");
  await ensureMap(assetId, "translationStartedAt");
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
          "attribute_exists(#pk) AND (attribute_not_exists(#statuses.#language) OR #statuses.#language = :failed OR #statuses.#language = :ready OR #started.#language < :staleBefore)",
        ExpressionAttributeNames: {
          "#statuses": "translationStatuses",
          "#started": "translationStartedAt",
          "#language": language,
          "#pk": "assetId",
        },
        ExpressionAttributeValues: {
          ":pending": "pending",
          ":failed": "failed",
          ":ready": "ready",
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
  const { projectId, targetLanguage } = event;
  let assetId: string | undefined;
  try {
    if (!TRANSLATE_TARGETS.has(targetLanguage)) {
      throw new Error(`Unsupported target language: ${targetLanguage}`);
    }
    const { project, asset } = await getProjectAndAsset(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    if (!asset) throw new Error(`Asset ${project.assetId} not found`);
    assetId = String(asset.assetId);
    await setTranslationStatus(assetId, targetLanguage, "pending");

    const existing =
      asset.translations && typeof asset.translations === "object"
        ? (asset.translations as Record<string, string>)
        : {};
    if (existing[targetLanguage]) {
      await setTranslationStatus(assetId, targetLanguage, "ready");
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
    const originalLanguage = normalizeLanguageCode(
      String(asset.originalLanguage || parsedLanguage || "und"),
    );
    if (targetLanguage === originalLanguage) {
      throw new Error("Target language is the original language");
    }
    if (sourceLines.length === 0) {
      throw new Error("Original transcript has no caption lines");
    }

    const apiKey = await getOpenRouterApiKey();
    const translated = await translateCaptionLines({
      apiKey,
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

    const s3Key = `transcriptions/${asset.assetId}/${targetLanguage}.json`;
    const translationUri = `s3://${BUCKET_NAME}/${s3Key}`;
    await s3Client.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: s3Key,
        Body: JSON.stringify({
          language: targetLanguage,
          sourceLanguage: originalLanguage,
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

    await ensureMap(assetId, "translations");
    await docClient.send(
      new UpdateCommand({
        TableName: ASSETS_TABLE,
        Key: { assetId },
        UpdateExpression:
          "SET #translations.#language = :uri, originalLanguage = if_not_exists(originalLanguage, :original), updatedAt = :updatedAt",
        ConditionExpression: "attribute_exists(#pk)",
        ExpressionAttributeNames: {
          "#translations": "translations",
          "#language": targetLanguage,
          "#pk": "assetId",
        },
        ExpressionAttributeValues: {
          ":uri": translationUri,
          ":original": originalLanguage,
          ":updatedAt": new Date().toISOString(),
        },
      }),
    );
    await setTranslationStatus(assetId, targetLanguage, "ready");
  } catch (err) {
    console.error("[translateCaptions worker]", err);
    if (assetId) {
      const message =
        err instanceof Error ? err.message : "Unknown translation error";
      await setTranslationStatus(
        assetId,
        targetLanguage,
        "failed",
        message.slice(0, 500),
      ).catch((statusErr) =>
        console.error("[translateCaptions worker status]", statusErr),
      );
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

    const existing =
      asset.translations && typeof asset.translations === "object"
        ? (asset.translations as Record<string, string>)
        : {};

    if (existing[targetLanguage]) {
      await setTranslationStatus(asset.assetId, targetLanguage, "ready");
      return json(200, {
        language: targetLanguage,
        sourceLanguage: normalizeLanguageCode(
          String(asset.originalLanguage || "und"),
        ),
        status: "ready",
        cached: true,
        translationUrl: await presignS3Uri(existing[targetLanguage]),
      });
    }
    if (!asset.transcriptionUrl) {
      return json(409, { error: "Original transcript is not ready yet" });
    }

    const originalLanguage = normalizeLanguageCode(
      String(asset.originalLanguage || "und"),
    );
    if (targetLanguage === originalLanguage) {
      return json(400, { error: "Target language is the original language" });
    }

    const claimed = await claimTranslation(asset.assetId, targetLanguage);
    if (claimed) {
      if (!TRANSLATE_FUNCTION_NAME) {
        await setTranslationStatus(
          asset.assetId,
          targetLanguage,
          "failed",
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
              } satisfies TranslateWorkerEvent),
            ),
          }),
        );
      } catch (err) {
        await setTranslationStatus(
          asset.assetId,
          targetLanguage,
          "failed",
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
