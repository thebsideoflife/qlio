/**
 * cutSegments never revives an export that was cancelled, timed out or
 * finished: no launch, and no write back to "rendering".
 *
 * Run: npx tsx src/tests/cutSegmentsGuard.test.ts
 */
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";

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

type Command = { constructor: { name: string }; input: Record<string, any> };
let job: Record<string, any>;
let calls: Command[] = [];
/** Runs just before an update is evaluated (to stage a cancel race). */
let beforeUpdate: (() => void) | undefined;

function conditionalFailure(): Error {
  const error = new Error("The conditional request failed");
  error.name = "ConditionalCheckFailedException";
  return error;
}

(DynamoDBDocumentClient.prototype as unknown as { send: unknown }).send =
  async (command: Command) => {
    calls.push(command);
    if (command.constructor.name === "GetCommand") return { Item: { ...job } };
    if (command.constructor.name === "UpdateCommand") {
      beforeUpdate?.();
      beforeUpdate = undefined;
      const values = command.input.ExpressionAttributeValues;
      const revOk =
        job.rev === undefined ? true : job.rev === values[":rev"];
      const statusOk = !String(command.input.ConditionExpression).includes(
        "#status = :status",
      ) || job.status === values[":status"];
      if (!revOk || !statusOk) throw conditionalFailure();
      job.status = values[":status"];
      job.segmentRenders = values[":segmentRenders"];
      job.rev = values[":nextRev"];
      return {};
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  };
let otherAws = 0;
(LambdaClient.prototype as unknown as { send: unknown }).send = async () => {
  otherAws++;
  return {};
};
(S3Client.prototype as unknown as { send: unknown }).send = async () => {
  otherAws++;
  return {};
};

const launched = [
  {
    segmentId: "s1",
    title: "One",
    renderId: "r1",
    bucketName: "b",
    outputKey: "renders/r1/out.mp4",
    status: "rendering" as const,
  },
];
const updates = () => calls.filter((c) => c.constructor.name === "UpdateCommand");

function reset(status: string) {
  job = {
    jobId: "j1",
    status,
    rev: 3,
    segments: [{ id: "s1", startTime: 0, endTime: 5, title: "One" }],
    segmentRenders: [{ segmentId: "s1", status: "rendering", renderId: "" }],
  };
  calls = [];
  otherAws = 0;
}

async function main() {
  const { handler, mergeJobRenders } = await import("../handlers/cutSegments");
  const run = handler as unknown as (event: unknown) => Promise<unknown>;

  for (const status of ["failed", "completed"]) {
    console.log(`handler does nothing for a ${status} job`);
    reset(status);
    const result = await run({ jobId: "j1" });
    assert(result === undefined, "coordinator returns without work");
    assert(updates().length === 0, "no write");
    assert(otherAws === 0, "no download, cut or launch");
    reset(status);
    const workerResult = await run({ jobId: "j1", worker: true, segmentIds: ["s1"] });
    assert(Array.isArray(workerResult) && workerResult.length === 0, "worker launches nothing");
  }

  console.log("recording renders on a cancelled job is dropped");
  reset("failed");
  await mergeJobRenders("j1", launched);
  assert(updates().length === 0, "no write");
  assert(job.status === "failed", "job stays ended");

  console.log("recording renders on a running job requires it to still be running");
  reset("rendering");
  await mergeJobRenders("j1", launched);
  assert(updates().length === 1, "one write");
  assert(
    String(updates()[0].input.ConditionExpression).includes("#status = :status"),
    "write is conditioned on the job still rendering",
  );
  assert(job.segmentRenders[0].renderId === "r1", "render recorded");

  console.log("cancel landing between read and write wins");
  reset("rendering");
  beforeUpdate = () => {
    job.status = "failed";
    job.rev = 4;
  };
  await mergeJobRenders("j1", launched);
  assert(job.status === "failed", "cancelled job is not revived");
  assert(job.segmentRenders[0].renderId === "", "renders not recorded onto it");

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
