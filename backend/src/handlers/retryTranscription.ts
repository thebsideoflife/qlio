import { APIGatewayProxyHandler } from "aws-lambda";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { checkAuth } from "../utils/auth";
import { randomUUID } from "crypto";

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

function isConditionalFailure(err: unknown): boolean {
  return (err as { name?: string })?.name === "ConditionalCheckFailedException";
}

export const handler: APIGatewayProxyHandler = async (event) => {
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  const assetId = event.pathParameters?.assetId;
  if (!assetId) return json(400, { error: "Missing assetId" });
  if (!TRANSCRIBE_FUNCTION_NAME) {
    return json(500, { error: "Transcription function is not configured" });
  }

  let transcriptionVersion: string | null = null;
  try {
    const assetRes = await docClient.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { assetId } }),
    );
    const asset = assetRes.Item;
    if (!asset) return json(404, { error: "Asset not found" });

    let bucket = BUCKET_NAME;
    let key =
      typeof asset.key === "string" && asset.key
        ? asset.key
        : `raw/${assetId}.mp4`;
    if (typeof asset.s3VideoUrl === "string" && asset.s3VideoUrl.startsWith("s3://")) {
      const parsed = parseS3Uri(asset.s3VideoUrl);
      bucket = parsed.bucket;
      key = parsed.key;
    }

    transcriptionVersion = randomUUID();
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { assetId },
          UpdateExpression:
            "SET transcriptionStatus = :pending, pendingTranscriptionVersion = :version, updatedAt = :updatedAt",
          ConditionExpression:
            "attribute_exists(assetId) AND (attribute_not_exists(transcriptionStatus) OR transcriptionStatus <> :pending)",
          ExpressionAttributeValues: {
            ":pending": "pending",
            ":version": transcriptionVersion,
            ":updatedAt": new Date().toISOString(),
          },
        }),
      );
    } catch (err) {
      if (isConditionalFailure(err)) {
        return json(409, { error: "Transcription is already running" });
      }
      throw err;
    }

    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: TRANSCRIBE_FUNCTION_NAME,
        InvocationType: "Event",
        Payload: Buffer.from(
          JSON.stringify({
            assetId,
            bucket,
            key,
            transcriptionVersion,
          }),
        ),
      }),
    );

    return json(202, {
      assetId,
      transcriptionStatus: "pending",
      transcriptionVersion,
    });
  } catch (err) {
    console.error("[retryTranscription]", err);
    await docClient
      .send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { assetId },
          UpdateExpression:
            "SET transcriptionStatus = :failed, updatedAt = :updatedAt",
          ConditionExpression: "pendingTranscriptionVersion = :version",
          ExpressionAttributeValues: {
            ":failed": "failed",
            ":version": transcriptionVersion,
            ":updatedAt": new Date().toISOString(),
          },
        }),
      )
      .catch((statusErr) =>
        console.error("[retryTranscription] failed to mark status:", statusErr),
      );
    return json(500, { error: "Failed to start transcription" });
  }
};
