import { APIGatewayProxyHandler } from "aws-lambda";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { checkAuth } from "../utils/auth";

const lambdaClient = new LambdaClient({});
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME = process.env.TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;
const TRANSCRIBE_FUNCTION_NAME = process.env.TRANSCRIBE_FUNCTION_NAME!;

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

function parseS3Uri(uri: string): { bucket: string; key: string } {
  const match = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`Invalid S3 URI: ${uri}`);
  return { bucket: match[1], key: match[2] };
}

export const handler: APIGatewayProxyHandler = async (event) => {
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  const assetId = event.pathParameters?.assetId;
  if (!assetId) return json(400, { error: "Missing assetId" });
  if (!TRANSCRIBE_FUNCTION_NAME) {
    return json(500, { error: "Transcription function is not configured" });
  }

  try {
    const assetRes = await docClient.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { assetId } }),
    );
    const asset = assetRes.Item;
    if (!asset) return json(404, { error: "Asset not found" });

    let bucket = BUCKET_NAME;
    let key = `raw/${assetId}.mp4`;
    if (typeof asset.s3VideoUrl === "string" && asset.s3VideoUrl.startsWith("s3://")) {
      const parsed = parseS3Uri(asset.s3VideoUrl);
      bucket = parsed.bucket;
      key = parsed.key;
    }

    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { assetId },
        UpdateExpression: "SET transcriptionStatus = :ts, updatedAt = :ua",
        ExpressionAttributeValues: {
          ":ts": "pending",
          ":ua": new Date().toISOString(),
        },
      }),
    );

    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: TRANSCRIBE_FUNCTION_NAME,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ assetId, bucket, key })),
      }),
    );

    return json(202, { assetId, transcriptionStatus: "pending" });
  } catch (err) {
    console.error("[retryTranscription]", err);
    await docClient
      .send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { assetId },
          UpdateExpression: "SET transcriptionStatus = :ts, updatedAt = :ua",
          ExpressionAttributeValues: {
            ":ts": "failed",
            ":ua": new Date().toISOString(),
          },
        }),
      )
      .catch((statusErr) =>
        console.error("[retryTranscription] failed to mark status:", statusErr),
      );
    return json(500, { error: "Failed to start transcription" });
  }
};
