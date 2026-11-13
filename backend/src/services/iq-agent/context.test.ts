/**
 * Compaction trigger: images count at what Claude bills for them, not at the
 * size of their base64, and frames already due to be dropped are stripped
 * before the decision is made.
 *
 * Run: npx tsx src/services/iq-agent/context.test.ts
 */
process.env.AGENT_THREADS_TABLE ??= "test-threads";
process.env.AGENT_EVENTS_TABLE ??= "test-events";
process.env.PROJECTS_TABLE ??= "test-projects";
process.env.ASSETS_TABLE ??= "test-assets";
process.env.AWS_REGION ??= "us-west-2";
process.env.SPORELABS_SECRET_ARN = "arn:aws:secretsmanager:us-west-2:1:secret:sl";

import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
  CONTEXT_SOFT_TOKEN_CAP,
  FRAMES_PER_CALL,
  IMAGE_TOKEN_ESTIMATE,
  TURN_WINDOW,
} from "./config";
import { compactHistory, estimateTokens } from "./context";
import { stripOldImages } from "./loop";
import type { StoredTurn } from "./types";

let checks = 0;
let failures = 0;

function assert(condition: boolean, message: string): void {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}

(SecretsManagerClient.prototype as unknown as { send: unknown }).send =
  async () => ({ SecretString: "sk-test" });

// Every compaction is a summarizer call; counting fetches counts compactions.
let modelCalls = 0;
globalThis.fetch = (async () => {
  modelCalls++;
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "Earlier: the producer asked for a recap." } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200 },
  );
}) as typeof fetch;

/** About the size of one 768px JPEG frame as base64. */
const FRAME_B64 = "A".repeat(150_000);

function frameBlock() {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: FRAME_B64 },
  };
}

function viewFramesCall(id: string): StoredTurn {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "Let me look at the frames around that line." },
      { type: "tool_use", id, name: "view_frames", input: { start: 120, end: 160 } },
    ],
  };
}

function viewFramesResult(id: string): StoredTurn {
  const content: unknown[] = [{ type: "text", text: `${FRAMES_PER_CALL} frames from 2:00–2:40.` }];
  for (let i = 0; i < FRAMES_PER_CALL; i++) {
    content.push({ type: "text", text: `Frame at 2:${String(i * 5).padStart(2, "0")}:` });
    content.push(frameBlock());
  }
  return { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] };
}

function textTurn(role: StoredTurn["role"], chars: number): StoredTurn {
  return { role, content: [{ type: "text", text: "x".repeat(chars) }] };
}

function countImages(turns: StoredTurn[]): number {
  return JSON.stringify(turns).split('"type":"image"').length - 1;
}

/** The estimate before this change, kept to show the fixture would have tripped it. */
function serializedEstimate(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 3.5);
}

async function main() {
  // estimateTokens: an image is a flat rate, whatever its base64 weighs.
  const one = estimateTokens([frameBlock()]);
  assert(
    one >= IMAGE_TOKEN_ESTIMATE && one < IMAGE_TOKEN_ESTIMATE + 50,
    `one frame ≈ ${IMAGE_TOKEN_ESTIMATE} tokens (got ${one})`,
  );
  const openAiPart = estimateTokens([
    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${FRAME_B64}` } },
  ]);
  assert(
    openAiPart >= IMAGE_TOKEN_ESTIMATE && openAiPart < IMAGE_TOKEN_ESTIMATE + 50,
    `image_url part ≈ ${IMAGE_TOKEN_ESTIMATE} tokens (got ${openAiPart})`,
  );
  assert(estimateTokens("x".repeat(3500)) === 1000, "plain text still counted by length");
  assert(
    estimateTokens([textTurn("user", 35_000)]) === serializedEstimate([textTurn("user", 35_000)]),
    "text-only turns estimate exactly as before",
  );
  const placeholder = [{ type: "text", text: "[frame image dropped from history]" }];
  assert(estimateTokens(placeholder) < 50, "a stripped frame costs only its placeholder");

  // A view_frames result inside the turn window does not compact. Longer than
  // TURN_WINDOW, so a token-cap trip would have something to fold away — the
  // shape of the production runs that compacted every iteration.
  const chatter = (): StoredTurn[] => {
    const turns: StoredTurn[] = [];
    for (let i = 0; i < TURN_WINDOW; i++) {
      turns.push(textTurn(i % 2 === 0 ? "user" : "assistant", 2_000));
    }
    return turns;
  };
  const withFrames: StoredTurn[] = [
    ...chatter(),
    viewFramesCall("vf1"),
    viewFramesResult("vf1"),
    textTurn("assistant", 1_500),
  ];
  assert(
    withFrames.length > TURN_WINDOW && withFrames.length <= TURN_WINDOW * 2,
    "fixture is past TURN_WINDOW but inside the window cap",
  );
  assert(
    serializedEstimate(withFrames) > CONTEXT_SOFT_TOKEN_CAP,
    `fixture would have tripped the old estimate (${serializedEstimate(withFrames)} tokens)`,
  );
  const framesEstimate = estimateTokens(withFrames);
  assert(
    framesEstimate < CONTEXT_SOFT_TOKEN_CAP,
    `8 frames now estimate under the cap (${framesEstimate} tokens)`,
  );
  modelCalls = 0;
  const framesResult = await compactHistory({ turns: withFrames });
  assert(!framesResult.compacted, "view_frames history does not compact");
  assert(framesResult.turns === withFrames, "turns returned untouched");
  assert(modelCalls === 0, "no summarizer call");

  // Two view_frames results that each still hold their frames are not enough either.
  const twoResults: StoredTurn[] = [
    ...chatter(),
    viewFramesCall("vf1"),
    viewFramesResult("vf1"),
    viewFramesCall("vf2"),
    viewFramesResult("vf2"),
  ];
  modelCalls = 0;
  assert(!(await compactHistory({ turns: twoResults })).compacted, "two frame results do not compact");
  assert(modelCalls === 0, "still no summarizer call");

  // A genuinely large text history still compacts on tokens, within the window.
  const bigText: StoredTurn[] = [
    textTurn("user", 200_000),
    textTurn("assistant", 200_000),
    textTurn("user", 200_000),
    textTurn("assistant", 200_000),
    textTurn("user", 200_000),
    textTurn("assistant", 200_000),
    textTurn("user", 200_000),
    textTurn("assistant", 200_000),
    textTurn("user", 200_000),
    textTurn("assistant", 1_000),
  ];
  assert(bigText.length <= TURN_WINDOW * 2, "large-text fixture is inside the turn window");
  assert(estimateTokens(bigText) > CONTEXT_SOFT_TOKEN_CAP, "large text estimates over the cap");
  modelCalls = 0;
  const textResult = await compactHistory({ turns: bigText });
  assert(textResult.compacted, "large text history compacts");
  assert(modelCalls === 1, "one summarizer call");
  assert(textResult.turns.length <= TURN_WINDOW, "kept at most the turn window verbatim");
  assert(!!textResult.summary?.includes("recap"), "summary carried forward");

  // Too many turns still compacts on the window alone.
  const manyTurns: StoredTurn[] = [];
  for (let i = 0; i < TURN_WINDOW * 2 + 2; i++) {
    manyTurns.push(textTurn(i % 2 === 0 ? "user" : "assistant", 200));
  }
  modelCalls = 0;
  assert((await compactHistory({ turns: manyTurns })).compacted, "turn-window overflow compacts");

  // Strip-then-compact leaves the model seeing the same frames as
  // compact-then-strip: only the last two turns ever keep images, and
  // compaction keeps a suffix of the history.
  const build = (): StoredTurn[] => {
    const turns: StoredTurn[] = [textTurn("user", 500)];
    for (let i = 0; i < TURN_WINDOW; i++) {
      turns.push(viewFramesCall(`vf${i}`), viewFramesResult(`vf${i}`));
    }
    return turns;
  };

  let before = build();
  const compactedFirst = await compactHistory({ turns: before });
  before = compactedFirst.turns;
  stripOldImages(before, 2);

  const after = build();
  stripOldImages(after, 2);
  const strippedFirst = await compactHistory({ turns: after });

  assert(compactedFirst.compacted && strippedFirst.compacted, "both orders compact this history");
  assert(
    JSON.stringify(strippedFirst.turns.map((t) => countImages([t]))) ===
      JSON.stringify(before.map((t) => countImages([t]))),
    "the same images reach the model in either order",
  );
  // The one wording difference: the head turn, flattened by repairHistoryHead,
  // now names a frame that was already dropped with the strip placeholder.
  const normalize = (turns: StoredTurn[]) =>
    JSON.stringify(turns).split("[frame image dropped from history]").join("[image]");
  assert(normalize(strippedFirst.turns) === normalize(before), "same turns in either order");
  assert(countImages(strippedFirst.turns) === FRAMES_PER_CALL, "current view_frames frames survive");
  const last = strippedFirst.turns[strippedFirst.turns.length - 1];
  assert(countImages([last]) === FRAMES_PER_CALL, "they sit on the latest turn");

  // And with the old frames stripped first, a run that is inside the window
  // with only its current frames left does not compact.
  const recent: StoredTurn[] = [textTurn("user", 500)];
  for (let i = 0; i < 6; i++) recent.push(viewFramesCall(`r${i}`), viewFramesResult(`r${i}`));
  assert(recent.length > TURN_WINDOW && recent.length <= TURN_WINDOW * 2, "recent fixture shape");
  stripOldImages(recent, 2);
  modelCalls = 0;
  assert(!(await compactHistory({ turns: recent })).compacted, "stripped history inside the window does not compact");
  assert(modelCalls === 0, "no summarizer call after stripping");

  if (failures > 0) {
    console.error(`iq-agent context: ${failures}/${checks} checks failed`);
    process.exit(1);
  }
  console.log(`iq-agent context: ${checks} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
