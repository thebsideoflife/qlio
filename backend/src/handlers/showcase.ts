import type { APIGatewayProxyHandler, APIGatewayProxyResult } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { checkShowcaseAuth } from "../utils/showcaseAuth";
import { presignRenderDownload } from "../utils/renderDownloads";
import { presignS3Uri } from "../utils/s3";
import {
  buildCatalogue,
  type RenderLocation,
  type ShowcaseAssetRow,
  type ShowcaseProjectRow,
} from "../utils/showcaseCatalogue";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const BUCKET_NAME = process.env.BUCKET_NAME;
/** CORS renders bucket (zeevee-renders-dev); preferred over Remotion keys. */
const RENDERS_BUCKET = process.env.RENDERS_BUCKET;
/** 12h — signed URLs stay valid across demo sessions and refetches. */
const PRESIGN_TTL_SEC = 43_200;

// ==========================================================================
// THE DEMO. This list is the whole showcase: every segment of these projects
// that has a rendered object becomes an episode. Changing the demo = edit
// these ids and redeploy (no DB flag, no playlist table).
// ==========================================================================
const SHOWCASE_SERIES = [
  // Nashville — "Lionsgate Cut 081926" (26 rendered parts)
  { projectId: "dc1a5723-6142-40ea-89b6-4cf257c56501", featured: true },
  // Bourdain — "Why the French don't suck" (6 parts on zeevee-renders-dev)
  { projectId: "36e52c4c-220f-4223-9831-e0387604eb85", featured: false },
];

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

type RequestItems = Record<string, { Keys: Array<Record<string, string>> }>;
type ItemRows = Array<Record<string, unknown>>;

/** The document client's send() overload set is self-referential; pin the shape. */
type BatchGetResult = {
  Responses?: Record<string, ItemRows>;
  UnprocessedKeys?: RequestItems;
};

/** BatchGetItem with the usual UnprocessedKeys retry. */
async function batchGetAll(
  requestItems: RequestItems,
): Promise<Record<string, ItemRows>> {
  const collected: Record<string, ItemRows> = {};
  let pending: RequestItems | undefined = requestItems;

  for (let attempt = 0; attempt < 3 && pending; attempt++) {
    const result = (await docClient.send(
      new BatchGetCommand({ RequestItems: pending }),
    )) as BatchGetResult;

    for (const [table, items] of Object.entries(result.Responses ?? {})) {
      collected[table] = [...(collected[table] ?? []), ...items];
    }

    const unprocessed: RequestItems = result.UnprocessedKeys ?? {};
    pending = Object.keys(unprocessed).length > 0 ? unprocessed : undefined;
    if (pending) {
      console.warn(
        `[showcase] BatchGet throttled, retrying (attempt ${attempt + 1})`,
      );
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }

  return collected;
}

async function presignVideo(location: RenderLocation): Promise<string | null> {
  try {
    // Plain S3 presign: the media CloudFront distribution does not front the
    // renders bucket, so presignS3Uri would sign the wrong host here.
    return await presignRenderDownload(
      location.bucket,
      location.key,
      PRESIGN_TTL_SEC,
    );
  } catch (error) {
    console.error(`[showcase] failed to presign ${location.bucket}/${location.key}:`, error);
    return null;
  }
}

async function presignThumbnail(key: string): Promise<string | null> {
  if (!BUCKET_NAME) return null;
  return presignS3Uri(`s3://${BUCKET_NAME}/${key}`, PRESIGN_TTL_SEC);
}

export const handler: APIGatewayProxyHandler = async (event) => {
  // Dedicated showcase read key (Authorization: Bearer), not x-api-password.
  const authResult = await checkShowcaseAuth(event);
  if (authResult) return authResult;

  try {
    const projectRows = await batchGetAll({
      [PROJECTS_TABLE]: {
        Keys: SHOWCASE_SERIES.map(({ projectId }) => ({ projectId })),
      },
    });
    const projects = (projectRows[PROJECTS_TABLE] ??
      []) as unknown as ShowcaseProjectRow[];

    const assetIds = [
      ...new Set(
        projects
          .map((project) => project.assetId)
          .filter((assetId): assetId is string => typeof assetId === "string" && !!assetId),
      ),
    ];
    const assetRows = assetIds.length
      ? await batchGetAll({
          [ASSETS_TABLE]: { Keys: assetIds.map((assetId) => ({ assetId })) },
        })
      : {};
    const assets = (assetRows[ASSETS_TABLE] ??
      []) as unknown as ShowcaseAssetRow[];

    const catalogue = await buildCatalogue({
      selections: SHOWCASE_SERIES,
      projects,
      assets,
      preferredRenderBucket: RENDERS_BUCKET,
      presignVideo,
      presignThumbnail,
    });

    console.log(
      `[showcase] served ${catalogue.series.length} series, ` +
        `${catalogue.series.reduce((total, s) => total + s.episodes.length, 0)} episodes, ` +
        `${catalogue.assets.length} assets`,
    );

    return json(200, catalogue);
  } catch (error) {
    console.error("Error building showcase catalogue:", error);
    return json(500, { error: "Failed to load showcase catalogue" });
  }
};
