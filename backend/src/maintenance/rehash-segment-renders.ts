/**
 * Recompute stored render fingerprints with the key-order-independent hash.
 * Each render is re-hashed from the render job that produced it (job id is in
 * its Remotion source key), so the hash describes what was actually rendered.
 *
 * Usage: PROJECTS_TABLE=zeevee-projects RENDER_JOBS_TABLE=zeevee-render-jobs \
 *   npx tsx src/maintenance/rehash-segment-renders.ts [--apply]
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { computeSegmentRenderFingerprint } from "../utils/segmentRenderFingerprint";

const PROJECTS_TABLE = process.env.PROJECTS_TABLE || "zeevee-projects";
const RENDER_JOBS_TABLE = process.env.RENDER_JOBS_TABLE || "zeevee-render-jobs";
const apply = process.argv.includes("--apply");
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const JOB_ID_IN_KEY =
  /renders\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//;

const jobCache = new Map<string, Record<string, any> | null>();
async function getJob(jobId: string) {
  if (!jobCache.has(jobId)) {
    const { Item } = await docClient.send(
      new GetCommand({ TableName: RENDER_JOBS_TABLE, Key: { jobId } }),
    );
    jobCache.set(jobId, Item ?? null);
  }
  return jobCache.get(jobId)!;
}

async function main() {
  let startKey: Record<string, unknown> | undefined;
  let changedProjects = 0;
  let changedRenders = 0;
  let unknown = 0;
  do {
    const page = await docClient.send(
      new ScanCommand({
        TableName: PROJECTS_TABLE,
        ProjectionExpression: "projectId, segmentRenders, updatedAt",
        FilterExpression: "attribute_exists(segmentRenders)",
        ExclusiveStartKey: startKey,
      }),
    );
    startKey = page.LastEvaluatedKey;

    for (const project of page.Items || []) {
      const renders = (project.segmentRenders || []) as Array<Record<string, any>>;
      let changed = 0;
      const next = [];
      for (const render of renders) {
        const jobId = String(render.sourceKey || render.key || "").match(JOB_ID_IN_KEY)?.[1];
        const job = jobId ? await getJob(jobId) : null;
        const segment = job?.segments?.find((s: { id: string }) => s.id === render.segmentId);
        if (!job || !segment) {
          unknown++;
          next.push(render);
          continue;
        }
        const contentHash = computeSegmentRenderFingerprint(
          segment,
          job.captionSettings || { enabled: true, style: {} },
          job.globalFraming || { aspectRatio: "9:16" },
          job.transcriptionVersion,
          job.renderPipelineVersion ?? 7,
        );
        if (contentHash !== render.contentHash) changed++;
        next.push({ ...render, contentHash });
      }
      if (changed === 0) continue;
      changedProjects++;
      changedRenders += changed;
      console.log(`${project.projectId}: ${changed} of ${renders.length} renders re-hashed`);
      if (apply) {
        await docClient.send(
          new UpdateCommand({
            TableName: PROJECTS_TABLE,
            Key: { projectId: project.projectId },
            UpdateExpression: "SET segmentRenders = :renders",
            // Skip if the project changed while we were reading it.
            ConditionExpression: "updatedAt = :updatedAt",
            ExpressionAttributeValues: {
              ":renders": next,
              ":updatedAt": project.updatedAt,
            },
          }),
        );
      }
    }
  } while (startKey);

  console.log(
    `${apply ? "Updated" : "Would update"} ${changedRenders} renders in ${changedProjects} projects; ${unknown} renders had no source job (left as-is).`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
