import { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  DeleteCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { TwelveLabs } from "twelvelabs-js";
import { checkAuth } from "../utils/auth";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});
const secretsClient = new SecretsManagerClient({});

const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const SECRET_ARN = process.env.SECRET_ARN!; // 12Labs API Key Secret

export const handler: APIGatewayProxyHandler = async (event) => {
  // 1. Auth Check
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  const assetId = event.pathParameters?.assetId;

  if (!assetId) {
    return {
      statusCode: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Missing assetId" }),
    };
  }

  try {
    // 2. Fetch the Asset
    const assetResult = await docClient.send(
      new GetCommand({
        TableName: ASSETS_TABLE,
        Key: { assetId },
      })
    );

    const asset = assetResult.Item;

    if (!asset) {
      return {
        statusCode: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ error: "Asset not found" }),
      };
    }

    // 3. Find Associated Projects
    const projectsResult = await docClient.send(
      new QueryCommand({
        TableName: PROJECTS_TABLE,
        IndexName: "AssetIdIndex",
        KeyConditionExpression: "assetId = :aid",
        ExpressionAttributeValues: {
          ":aid": assetId,
        },
      })
    );

    const projects = projectsResult.Items || [];

    // 4. Delete Associated Data

    // a. Delete Projects
    if (projects.length > 0) {
      console.log(
        `Deleting ${projects.length} projects associated with asset ${assetId}`
      );
      await Promise.all(
        projects.map((project) =>
          docClient.send(
            new DeleteCommand({
              TableName: PROJECTS_TABLE,
              Key: { projectId: project.projectId },
            })
          )
        )
      );
    }

    // b. Delete from 12Labs (including chunked videos)
    const indexId = asset.twelveLabsIndexId;

    if (indexId) {
      try {
        const secretVal = await secretsClient.send(
          new GetSecretValueCommand({ SecretId: SECRET_ARN })
        );
        const apiKey = secretVal.SecretString;

        if (apiKey) {
          const client = new TwelveLabs({ apiKey });

          // Collect all videoIds to delete (main video + chunks)
          const videoIdsToDelete: string[] = [];

          if (asset.twelveLabsVideoId) {
            videoIdsToDelete.push(asset.twelveLabsVideoId);
          }

          // Add chunk videoIds if this is a chunked video
          if (asset.chunks && Array.isArray(asset.chunks)) {
            for (const chunk of asset.chunks) {
              if (chunk.videoId) {
                videoIdsToDelete.push(chunk.videoId);
              }
            }
          }

          // Delete all videos from 12Labs
          for (const videoId of videoIdsToDelete) {
            try {
              console.log(
                `Deleting video ${videoId} from 12Labs index ${indexId}`
              );
              await client.indexes.videos.delete(indexId, videoId);
            } catch (err) {
              console.error(
                `Error deleting video ${videoId} from 12Labs:`,
                err
              );
            }
          }
          console.log(
            `Deleted ${videoIdsToDelete.length} video(s) from 12Labs`
          );
        } else {
          console.warn(
            "Could not retrieve 12Labs API key, skipping 12Labs deletion"
          );
        }
      } catch (err) {
        console.error("Error deleting from 12Labs:", err);
      }
    }

    // c. Delete from S3 (video, transcription, and chunks)
    const s3Url = asset.s3VideoUrl;
    if (s3Url && s3Url.startsWith("s3://")) {
      const parts = s3Url.replace("s3://", "").split("/");
      const bucket = parts[0];
      const videoKey = parts.slice(1).join("/");

      // Delete main video file
      try {
        console.log(`Deleting video from S3: ${videoKey}`);
        await s3Client.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: videoKey })
        );
      } catch (err) {
        console.error("Error deleting video from S3:", err);
      }

      // Delete transcriptions: legacy file and language-prefixed folder
      try {
        const transPrefix = `transcriptions/${assetId}`;
        console.log(`Deleting transcriptions from S3: ${transPrefix}`);
        const keys = new Set<string>([`${transPrefix}.json`]);
        const listed = await s3Client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: `${transPrefix}/`,
          }),
        );
        for (const obj of listed.Contents || []) {
          if (obj.Key) keys.add(obj.Key);
        }
        if (
          asset.transcriptionUrl &&
          typeof asset.transcriptionUrl === "string" &&
          asset.transcriptionUrl.startsWith("s3://")
        ) {
          const transKey = asset.transcriptionUrl
            .replace("s3://", "")
            .split("/")
            .slice(1)
            .join("/");
          if (transKey) keys.add(transKey);
        }
        const toDelete = [...keys];
        if (toDelete.length > 0) {
          await s3Client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: toDelete.map((Key) => ({ Key })) },
            }),
          );
        }
      } catch (err) {
        console.error("Error deleting transcriptions from S3:", err);
      }

      // Delete video chunks folder if this is a chunked video
      if (asset.isChunked) {
        try {
          const chunkPrefix = `chunks/${assetId}/`;
          console.log(`Deleting chunks from S3: ${chunkPrefix}`);

          const listResult = await s3Client.send(
            new ListObjectsV2Command({ Bucket: bucket, Prefix: chunkPrefix })
          );

          if (listResult.Contents && listResult.Contents.length > 0) {
            await s3Client.send(
              new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: {
                  Objects: listResult.Contents.map((obj) => ({ Key: obj.Key })),
                },
              })
            );
            console.log(`Deleted ${listResult.Contents.length} chunk files`);
          }
        } catch (err) {
          console.error("Error deleting chunks from S3:", err);
        }
      }

      // Delete StoryIQ cache folder
      try {
        const cachePrefix = `storyiq-cache/${assetId}/`;
        const cacheResult = await s3Client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: cachePrefix })
        );

        if (cacheResult.Contents && cacheResult.Contents.length > 0) {
          await s3Client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: {
                Objects: cacheResult.Contents.map((obj) => ({ Key: obj.Key })),
              },
            })
          );
          console.log(`Deleted ${cacheResult.Contents.length} cache files`);
        }
      } catch (err) {
        console.error("Error deleting StoryIQ cache from S3:", err);
      }
    }

    // 5. Delete Asset
    console.log(`Deleting asset ${assetId} from DynamoDB`);
    await docClient.send(
      new DeleteCommand({
        TableName: ASSETS_TABLE,
        Key: { assetId },
      })
    );

    return {
      statusCode: 204, // No Content
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
      body: "",
    };
  } catch (error) {
    console.error("Error deleting asset:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Failed to delete asset" }),
    };
  }
};
