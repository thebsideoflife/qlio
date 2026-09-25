/**
 * Unit tests for the IQ agent executor. Focus: edit_segments no_ops handling —
 * stringified ops arrays are tolerated, and the no_ops error says what it got.
 *
 * Run: npm run test:iq-agent
 */

import { executeTool, type ExecContext } from "../services/iq-agent/executor";
import { emptyCostMeter, type ToolErr } from "../services/iq-agent/types";

function makeCtx(): ExecContext {
  return {
    client: null,
    facts: {
      assetId: "asset-1",
      title: "Test",
      duration: 600,
      indexId: "idx-1",
      isChunked: false,
      chunks: [
        {
          chunkIndex: 0,
          videoId: "vid-1",
          sourceStart: 0,
          sourceEnd: 600,
          indexedDuration: 600,
        },
      ],
    },
    segments: [],
    cost: emptyCostMeter(),
    watchHistory: [],
    transcriptWords: null,
    examined: [],
    examinedVisual: [],
    askCount: 0,
    finishRefusals: 0,
    searchMisses: 0,
    searchSeen: [],
    blindSpotRefusals: 0,
    onProgress: async () => {},
  };
}

let failures = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  // 1. Stringified ops array is parsed and applied.
  {
    const ctx = makeCtx();
    const ops = [{ op: "add", start: 10, end: 60, title: "Opening" }];
    const out = await executeTool(
      "edit_segments",
      { ops: JSON.stringify(ops) },
      ctx,
    );
    check(
      "stringified ops array applies",
      out.result.ok === true && ctx.segments.length === 1,
      JSON.stringify(out.result),
    );
  }

  // 2. Missing ops: no_ops error naming what was received.
  {
    const ctx = makeCtx();
    const out = await executeTool("edit_segments", {}, ctx);
    const err = out.result as ToolErr;
    check(
      "missing ops reports no_ops naming the received type",
      err.ok === false &&
        err.code === "no_ops" &&
        err.message.includes("no ops field"),
      JSON.stringify(err),
    );
  }

  // 3. Non-array, non-string ops: no_ops error naming the type.
  {
    const ctx = makeCtx();
    const out = await executeTool("edit_segments", { ops: 42 }, ctx);
    const err = out.result as ToolErr;
    check(
      "numeric ops reports no_ops naming the received type",
      err.ok === false &&
        err.code === "no_ops" &&
        err.message.includes("a number"),
      JSON.stringify(err),
    );
  }

  // 4. Unparseable string ops: no_ops error naming the string problem.
  {
    const ctx = makeCtx();
    const out = await executeTool(
      "edit_segments",
      { ops: "[{op: add" },
      ctx,
    );
    const err = out.result as ToolErr;
    check(
      "unparseable string ops reports no_ops naming the string",
      err.ok === false &&
        err.code === "no_ops" &&
        err.message.includes("a string that is not a JSON array"),
      JSON.stringify(err),
    );
  }

  // 5. Empty array still reports no_ops.
  {
    const ctx = makeCtx();
    const out = await executeTool("edit_segments", { ops: [] }, ctx);
    const err = out.result as ToolErr;
    check(
      "empty ops array reports no_ops",
      err.ok === false &&
        err.code === "no_ops" &&
        err.message.includes("an empty ops array"),
      JSON.stringify(err),
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll iq-agent executor tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
