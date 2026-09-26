/**
 * renderVideo + cancelRender: one running export per project, and the user can
 * always get out of it.
 *
 * Run: npx tsx src/tests/exportSlot.test.ts
 */
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { computeSegmentRenderFingerprint } from "../utils/segmentRenderFingerprint";
import {
  DEFAULT_CAPTION_SETTINGS,
  mergeCaptionSettings,
} from "../utils/caption-settings";

let checks = 0;
let failures = 0;

function assert(condition: boolean, message: string): void {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}

process.env.RENDER_JOBS_TABLE = "render-jobs";
process.env.PROJECTS_TABLE = "projects";
process.env.ASSETS_TABLE = "assets";
process.env.STITCH_FUNCTION_NAME = "stitch";
process.env.AGENT_THREADS_TABLE = "agent-threads";

type Item = Record<string, any>;
type Command = { constructor: { name: string }; input: Record<string, any> };

interface World {
  project: Item;
  jobs: Record<string, Item>;
  /** Runs just before a projects-table update is evaluated (to stage races). */
  beforeProjectUpdate?: () => void;
}

let world: World;
let calls: Command[] = [];

function conditionalFailure(): Error {
  const error = new Error("The conditional request failed");
  error.name = "ConditionalCheckFailedException";
  return error;
}

/** Evaluates the small condition grammar these handlers use. */
function conditionHolds(
  expression: string | undefined,
  item: Item,
  values: Record<string, unknown>,
  names: Record<string, string> = {},
): boolean {
  if (!expression) return true;
  return expression.split(/\s+OR\s+/).some((clause) => {
    const notExists = clause.match(/^attribute_not_exists\((\S+)\)$/);
    if (notExists) return item[names[notExists[1]] ?? notExists[1]] === undefined;
    const equals = clause.match(/^(\S+) = (:\w+)$/);
    if (equals) return item[names[equals[1]] ?? equals[1]] === values[equals[2]];
    throw new Error(`Unsupported condition: ${clause}`);
  });
}

(DynamoDBDocumentClient.prototype as unknown as { send: unknown }).send =
  async (command: Command) => {
    calls.push(command);
    const { input } = command;
    const values = input.ExpressionAttributeValues ?? {};
    const names = input.ExpressionAttributeNames ?? {};
    switch (command.constructor.name) {
      case "GetCommand":
        if (input.TableName === "projects") return { Item: { ...world.project } };
        if (input.TableName === "assets") {
          return {
            Item: {
              assetId: "a1",
              s3VideoUrl: "s3://media/a1.mp4",
              transcriptionVersion: "t1",
            },
          };
        }
        return { Item: world.jobs[input.Key.jobId] && { ...world.jobs[input.Key.jobId] } };
      case "PutCommand":
        world.jobs[input.Item.jobId] = { ...input.Item };
        return {};
      case "UpdateCommand": {
        if (input.TableName === "projects") {
          world.beforeProjectUpdate?.();
          world.beforeProjectUpdate = undefined;
          if (!conditionHolds(input.ConditionExpression, world.project, values, names)) {
            throw conditionalFailure();
          }
          if (input.UpdateExpression.startsWith("REMOVE activeRenderJobId")) {
            delete world.project.activeRenderJobId;
          } else {
            world.project.activeRenderJobId = values[":jobId"];
          }
          return {};
        }
        const job = world.jobs[input.Key.jobId];
        if (!conditionHolds(input.ConditionExpression, job, values, names)) {
          throw conditionalFailure();
        }
        job.status = values[":failed"];
        job.error = values[":error"];
        return {};
      }
      default:
        throw new Error(`Unexpected command ${command.constructor.name}`);
    }
  };

let invoked: unknown[] = [];
(LambdaClient.prototype as unknown as { send: unknown }).send = async (
  command: Command,
) => {
  invoked.push(JSON.parse(command.input.Payload));
  return {};
};
(S3Client.prototype as unknown as { send: unknown }).send = async () => ({});

const segments = [
  { id: "s1", startTime: 0, endTime: 10, title: "One" },
  { id: "s2", startTime: 10, endTime: 20, title: "Two" },
];

function reset(project: Item, jobs: Record<string, Item> = {}) {
  world = {
    project: { projectId: "p1", assetId: "a1", segments, ...project },
    jobs,
  };
  calls = [];
  invoked = [];
}

const recent = () => new Date().toISOString();
const runningJob = (jobId: string, extra: Item = {}): Item => ({
  jobId,
  projectId: "p1",
  status: "rendering",
  createdAt: recent(),
  segmentRenders: [{}, {}, {}],
  ...extra,
});

type Handler = (event: unknown) => Promise<{ statusCode: number; body: string }>;

async function main() {
  const renderVideo = (await import("../handlers/renderVideo")).handler as unknown as Handler;
  const cancelRender = (await import("../handlers/cancelRender")).handler as unknown as Handler;

  const start = async (force = true) => {
    const result = await renderVideo({
      pathParameters: { projectId: "p1" },
      body: JSON.stringify({ segmentIds: ["s1", "s2"], segments, force }),
    });
    return { statusCode: result.statusCode, body: JSON.parse(result.body) };
  };
  const cancel = async (jobId: string) => {
    const result = await cancelRender({ pathParameters: { jobId } });
    return { statusCode: result.statusCode, body: JSON.parse(result.body) };
  };
  const puts = () => calls.filter((c) => c.constructor.name === "PutCommand");

  console.log("running export blocks a second start");
  reset({ activeRenderJobId: "j-running" }, { "j-running": runningJob("j-running") });
  let res = await start();
  assert(res.statusCode === 409, `expected 409, got ${res.statusCode}`);
  assert(res.body.code === "EXPORT_IN_PROGRESS", "409 carries EXPORT_IN_PROGRESS");
  assert(res.body.jobId === "j-running", "409 names the running job");
  assert(res.body.segmentCount === 3, "409 reports the running job's size");
  assert(puts().length === 0, "no new job is created");
  assert(invoked.length === 0, "nothing is launched");

  console.log("finished export does not block");
  reset({ activeRenderJobId: "j-done" }, {
    "j-done": { jobId: "j-done", status: "completed", createdAt: recent() },
  });
  res = await start();
  assert(res.statusCode === 202, `expected 202, got ${res.statusCode}`);
  assert(world.project.activeRenderJobId === res.body.jobId, "new job holds the slot");
  assert(invoked.length === 1, "renders are launched once");

  console.log("empty slot is claimed");
  reset({});
  res = await start();
  assert(res.statusCode === 202, `expected 202, got ${res.statusCode}`);
  assert(world.project.activeRenderJobId === res.body.jobId, "new job holds the slot");

  console.log("slot released between read and claim is still claimable");
  reset({ activeRenderJobId: "j-done" }, {
    "j-done": { jobId: "j-done", status: "completed", createdAt: recent() },
  });
  world.beforeProjectUpdate = () => {
    delete world.project.activeRenderJobId;
  };
  res = await start();
  assert(res.statusCode === 202, `expected 202, got ${res.statusCode}`);
  assert(world.project.activeRenderJobId === res.body.jobId, "new job holds the slot");

  console.log("export past the job limit does not block");
  reset({ activeRenderJobId: "j-old" }, {
    "j-old": runningJob("j-old", {
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    }),
  });
  res = await start();
  assert(res.statusCode === 202, `expected 202, got ${res.statusCode}`);

  console.log("export with no readable start time does not block");
  reset({ activeRenderJobId: "j-bad" }, {
    "j-bad": runningJob("j-bad", { createdAt: undefined }),
  });
  res = await start();
  assert(res.statusCode === 202, `expected 202, got ${res.statusCode}`);

  console.log("losing a concurrent start attaches to the winner");
  reset({}, { "j-winner": runningJob("j-winner", { segmentRenders: [{}, {}] }) });
  world.beforeProjectUpdate = () => {
    world.project.activeRenderJobId = "j-winner";
  };
  res = await start();
  assert(res.statusCode === 409, `expected 409, got ${res.statusCode}`);
  assert(res.body.jobId === "j-winner", "409 names the winning job");
  const loser = Object.values(world.jobs).find((j) => j.jobId !== "j-winner");
  assert(loser?.status === "failed", "the losing job is closed out");
  assert(invoked.length === 0, "the losing job never launches renders");
  assert(world.project.activeRenderJobId === "j-winner", "winner keeps the slot");

  console.log("losing to a job that already finished asks to retry");
  reset({}, {
    "j-quick": { jobId: "j-quick", status: "completed", createdAt: recent() },
  });
  world.beforeProjectUpdate = () => {
    world.project.activeRenderJobId = "j-quick";
  };
  res = await start();
  assert(res.statusCode === 409, `expected 409, got ${res.statusCode}`);
  assert(!res.body.code, "no running job to attach to");
  assert(invoked.length === 0, "nothing is launched");

  console.log("request whose scenes are all rendered is never blocked");
  const captionSettings = mergeCaptionSettings(DEFAULT_CAPTION_SETTINGS, undefined);
  const framing = { aspectRatio: "9:16" as const, enabled: true, squareTop: false };
  reset({
    activeRenderJobId: "j-running",
    segmentRenders: segments.map((s) => ({
      segmentId: s.id,
      bucket: "renders",
      key: `${s.id}.mp4`,
      contentHash: computeSegmentRenderFingerprint(s, captionSettings, framing, "t1"),
    })),
  }, { "j-running": runningJob("j-running") });
  res = await start(false);
  assert(res.statusCode === 202, `expected 202, got ${res.statusCode}`);
  assert(res.body.status === "completed", "returns the stored renders at once");
  assert(world.project.activeRenderJobId === "j-running", "running export keeps its slot");
  assert(invoked.length === 0, "nothing is launched");

  console.log("cancel ends a running export and frees the project");
  reset({ activeRenderJobId: "j-running" }, { "j-running": runningJob("j-running") });
  let cancelled = await cancel("j-running");
  assert(cancelled.statusCode === 200, `expected 200, got ${cancelled.statusCode}`);
  assert(cancelled.body.cancelled === true, "reports the cancel");
  assert(world.jobs["j-running"].status === "failed", "job is ended");
  assert(world.project.activeRenderJobId === undefined, "slot is freed");
  res = await start();
  assert(res.statusCode === 202, "a new export can start right after cancel");

  console.log("cancel of a finished job still frees a slot it holds");
  reset({ activeRenderJobId: "j-done" }, {
    "j-done": { jobId: "j-done", projectId: "p1", status: "completed", createdAt: recent() },
  });
  cancelled = await cancel("j-done");
  assert(cancelled.statusCode === 200, `expected 200, got ${cancelled.statusCode}`);
  assert(cancelled.body.cancelled === false, "nothing was running");
  assert(world.jobs["j-done"].status === "completed", "finished job is untouched");
  assert(world.project.activeRenderJobId === undefined, "slot is freed");

  console.log("cancel never frees a slot held by a different job");
  reset({ activeRenderJobId: "j-new" }, {
    "j-old": runningJob("j-old"),
    "j-new": runningJob("j-new"),
  });
  await cancel("j-old");
  assert(world.jobs["j-old"].status === "failed", "old job is ended");
  assert(world.project.activeRenderJobId === "j-new", "newer export keeps its slot");

  console.log("cancel of an unknown job is a 404");
  reset({});
  cancelled = await cancel("nope");
  assert(cancelled.statusCode === 404, `expected 404, got ${cancelled.statusCode}`);

  const jobStatus = (await import("../handlers/getProjectJobStatus"))
    .handler as unknown as Handler;
  const resumeTarget = async () => {
    const result = await jobStatus({ pathParameters: { projectId: "p1" } });
    return JSON.parse(result.body).activeRenderJobId as string | null;
  };

  console.log("panel resumes a running export");
  reset({ activeRenderJobId: "j-running" }, { "j-running": runningJob("j-running") });
  assert((await resumeTarget()) === "j-running", "running export is resumed");
  assert(world.project.activeRenderJobId === "j-running", "slot kept");

  console.log("panel never resumes a job that no longer exists");
  reset({ activeRenderJobId: "j-gone" });
  assert((await resumeTarget()) === null, "nothing to resume");
  assert(world.project.activeRenderJobId === undefined, "dangling slot released");

  console.log("panel never resumes a finished job");
  reset({ activeRenderJobId: "j-done" }, {
    "j-done": { jobId: "j-done", status: "failed", createdAt: recent() },
  });
  assert((await resumeTarget()) === null, "nothing to resume");
  assert(world.project.activeRenderJobId === undefined, "slot released");

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
