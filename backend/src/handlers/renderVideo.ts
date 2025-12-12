import type { APIGatewayProxyHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { checkAuth } from "../utils/auth";
import { v4 as uuidv4 } from "uuid";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const RENDER_JOBS_TABLE = process.env.RENDER_JOBS_TABLE!;
const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const RENDERS_BUCKET = process.env.RENDERS_BUCKET!;
const REMOTION_SERVE_URL = process.env.REMOTION_SERVE_URL;
const REMOTION_FUNCTION_NAME = process.env.REMOTION_FUNCTION_NAME;

interface RenderRequest {
  segments: Array<{
    id: string;
    startTime: number;
    endTime: number;
    title: string;
  }>;
  captions: Array<{
    id: string;
    startTime: number;
    endTime: number;
    text: string;
    words: Array<{ start: number; end: number; value: string }>;
  }>;
  captionSettings: {
    enabled: boolean;
    style: {
      fontSize: number;
      fontFamily: string;
      color: string;
      backgroundColor: string;
      position: { x: number; y: number };
      maxWidth: number;
    };
  };
  outputFormat?: "mp4" | "webm";
  quality?: "draft" | "standard" | "high";
}

export const handler: APIGatewayProxyHandler = async (event) => {
  // Auth check
  const authResult = await checkAuth(event);
  if (authResult) return authResult;

  const projectId = event.pathParameters?.projectId;
  if (!projectId) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing projectId" }),
    };
  }

  let body: RenderRequest;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  // Get project to find video URL
  const projectResult = await docClient.send(
    new GetCommand({
      TableName: PROJECTS_TABLE,
      Key: { projectId },
    })
  );

  if (!projectResult.Item) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Project not found" }),
    };
  }

  const project = projectResult.Item;

  // Create render job
  const jobId = uuidv4();
  const now = new Date().toISOString();
  const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60; // 7 days TTL

  const renderJob = {
    jobId,
    projectId,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    expiresAt,
    progress: 0,
    inputProps: {
      videoUrl: project.asset?.videoUrl || "",
      segments: body.segments || [],
      captions: body.captions || [],
      captionSettings: body.captionSettings || {
        enabled: false,
        style: {
          fontSize: 5,
          fontFamily: "Inter, sans-serif",
          color: "#ffffff",
          backgroundColor: "rgba(0, 0, 0, 0.75)",
          position: { x: 50, y: 85 },
          maxWidth: 80,
        },
      },
    },
    outputFormat: body.outputFormat || "mp4",
    quality: body.quality || "standard",
    outputKey: `renders/${projectId}/${jobId}.${body.outputFormat || "mp4"}`,
  };

  // Store render job
  await docClient.send(
    new PutCommand({
      TableName: RENDER_JOBS_TABLE,
      Item: renderJob,
    })
  );

  // Check if Remotion is configured
  if (!REMOTION_SERVE_URL || !REMOTION_FUNCTION_NAME) {
    // For now, just mark as pending - Remotion Lambda needs to be deployed first
    // In production, this would trigger the Remotion Lambda render
    console.log("Remotion not configured. Job created but not started:", jobId);

    return {
      statusCode: 202,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId,
        status: "pending",
        message:
          "Render job created. Remotion Lambda needs to be deployed to process renders.",
      }),
    };
  }

  // TODO: In production, trigger Remotion Lambda here
  // const { renderMediaOnLambda } = await import("@remotion/lambda/client");
  // await renderMediaOnLambda({
  //   region: process.env.AWS_REGION_NAME as AwsRegion,
  //   functionName: REMOTION_FUNCTION_NAME,
  //   serveUrl: REMOTION_SERVE_URL,
  //   composition: "CaptionedVideo",
  //   inputProps: renderJob.inputProps,
  //   codec: body.outputFormat === "webm" ? "vp8" : "h264",
  //   outName: renderJob.outputKey,
  // });

  return {
    statusCode: 202,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jobId,
      status: "pending",
      message: "Render job created",
    }),
  };
};
