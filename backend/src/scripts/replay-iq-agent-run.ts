/**
 * Replay a recorded IQ Agent run against the current guardrails.
 *
 * Reads the event log for a project and re-derives, step by step, what the
 * agent examined and what it cut. At every finish_turn it reports whether
 * today's coverage gate would have let that finish through, and it scores the
 * search calls the way the circuit breaker now scores them.
 *
 * This is how a guardrail change gets checked against a real session instead of
 * only against a fixture.
 *
 *   npx tsx src/scripts/replay-iq-agent-run.ts <projectId> [videoDurationSec]
 */

process.env.AWS_REGION ??= "us-west-2";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  FRAME_EXAMINE_PAD_SEC,
  SEARCH_HIT_SAME_WINDOW_SEC,
  SEARCH_NOVELTY_FLOOR,
} from "../services/iq-agent/config";
import {
  blindSpotFloor,
  findBlindSpots,
  mergeIntervals,
  recordExamined,
  totalSeconds,
} from "../services/iq-agent/examined";
import { fmt, fmtTimecode } from "../services/iq-agent/ledger";
import type { AgentSegment, Interval } from "../services/iq-agent/types";

const TABLE = process.env.AGENT_EVENTS_TABLE ?? "zeevee-agent-events";

const docClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION }),
);

interface Row {
  seq: number;
  runId: string;
  eventType: string;
  data: Record<string, unknown>;
}

async function readEvents(projectId: string): Promise<Row[]> {
  const rows: Row[] = [];
  let startKey: Record<string, unknown> | undefined;

  do {
    const page = await docClient.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "projectId = :p",
        ExpressionAttributeValues: { ":p": projectId },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of page.Items ?? []) {
      rows.push({
        seq: Number(item.seq),
        runId: String(item.runId ?? ""),
        eventType: String(item.eventType ?? ""),
        data: JSON.parse(String(item.data ?? "{}")) as Record<string, unknown>,
      });
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  return rows.sort((a, b) => a.seq - b.seq);
}

function main(): Promise<void> {
  const projectId = process.argv[2];
  if (!projectId) {
    console.error("usage: replay-iq-agent-run.ts <projectId> [videoDurationSec]");
    process.exit(1);
  }
  const durationArg = Number(process.argv[3]);

  return readEvents(projectId).then((rows) => {
    if (rows.length === 0) {
      console.error(`No events for project ${projectId}.`);
      process.exit(1);
    }

    let duration = Number.isFinite(durationArg) ? durationArg : 0;
    if (duration <= 0) {
      for (const row of rows) {
        const ledger = (row.data as { ledger?: { videoDuration?: number } }).ledger;
        if (ledger?.videoDuration) duration = ledger.videoDuration;
      }
    }
    if (duration <= 0) {
      console.error("Could not determine the video duration; pass it as argv[3].");
      process.exit(1);
    }

    console.log(`Project ${projectId} · source ${fmt(duration)} · ${rows.length} events\n`);

    let examined: Interval[] = [];
    let segments: AgentSegment[] = [];
    let searchMisses = 0;
    let maxSearchMisses = 0;
    let searchesUnscorable = 0;
    const searchSeen: number[] = [];
    const pending = new Map<string, { name: string; input: Record<string, unknown> }>();
    let currentRun = "";
    let finishes = 0;
    let wouldBlock = 0;

    for (const row of rows) {
      if (row.runId !== currentRun) {
        currentRun = row.runId;
        searchMisses = 0;
        searchSeen.length = 0;
        console.log(`--- run ${currentRun.slice(0, 8)} ---`);
      }

      if (row.eventType === "tool.started") {
        const d = row.data as { callId?: string; name?: string; input?: Record<string, unknown> };
        pending.set(String(d.callId), { name: String(d.name), input: d.input ?? {} });
        continue;
      }

      if (row.eventType === "state.updated") {
        const d = row.data as { segments?: AgentSegment[] };
        if (d.segments) segments = d.segments;
        continue;
      }

      if (row.eventType !== "tool.finished") continue;

      const d = row.data as { callId?: string; ok?: boolean; digest?: unknown };
      const call = pending.get(String(d.callId));
      if (!call || d.ok === false) continue;
      const { name, input } = call;

      if (name === "read_transcript" || name === "watch_clip") {
        const digest = d.digest as { start?: number; end?: number } | undefined;
        const start = Number(digest?.start ?? input.start);
        const end = Number(digest?.end ?? input.end);
        examined = recordExamined(examined, start, end, duration);
      }

      if (name === "view_frames") {
        for (const raw of (input.timestamps as unknown[]) ?? []) {
          const t = Number(raw);
          if (Number.isFinite(t)) {
            examined = recordExamined(
              examined,
              t - FRAME_EXAMINE_PAD_SEC,
              t + FRAME_EXAMINE_PAD_SEC,
              duration,
            );
          }
        }
      }

      if (name === "search_video") {
        const hits =
          (d.digest as { hits?: Array<{ start: number; end: number }> } | undefined)?.hits ?? [];
        if (hits.length === 0) {
          // Runs recorded before hit ranges were added to the digest cannot be
          // scored this way. Say so rather than inventing a number.
          searchesUnscorable += 1;
        } else {
          const fresh = hits.filter(
            (h) => !searchSeen.some((s) => Math.abs(s - h.start) <= SEARCH_HIT_SAME_WINDOW_SEC),
          );
          for (const h of fresh) searchSeen.push(h.start);
          if (fresh.length / hits.length < SEARCH_NOVELTY_FLOOR) {
            searchMisses += 1;
            maxSearchMisses = Math.max(maxSearchMisses, searchMisses);
          } else {
            searchMisses = 0;
          }
        }
      }

      if (name === "finish_turn") {
        finishes += 1;
        const floor = blindSpotFloor(duration, true);
        const spots = findBlindSpots({
          examined,
          segments,
          videoDuration: duration,
          floorSec: floor,
        });
        const seen = totalSeconds(mergeIntervals(examined));
        console.log(
          `finish_turn #${finishes}: ${segments.length} segments · examined ${fmt(seen)} (${(
            (seen / duration) *
            100
          ).toFixed(0)}%) · floor ${fmt(floor)}`,
        );
        if (spots.length === 0) {
          console.log("  ALLOWED — every stretch was either cut from or examined.\n");
        } else {
          wouldBlock += 1;
          console.log(`  BLOCKED — ${spots.length} stretch(es) never opened:`);
          for (const s of spots) {
            console.log(
              `    ${fmtTimecode(s.start)}–${fmtTimecode(s.end)}  (${fmt(s.seconds)})`,
            );
          }
          console.log("");
        }
      }
    }

    console.log(`\n${finishes} finish_turn call(s) · ${wouldBlock} would now be blocked`);
    console.log(
      searchesUnscorable > 0
        ? `Search novelty: not scorable — ${searchesUnscorable} search(es) in this log predate hit ranges in the digest.`
        : `Search novelty: longest run of repeat-only queries was ${maxSearchMisses}.`,
    );
  });
}

void main();
