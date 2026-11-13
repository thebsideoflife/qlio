/**
 * Local Jockey pipeline eval — Gemini preprocess + windowed Pegasus.
 *
 * Env:
 *   TWELVE_LABS_API_KEY or TWELVE_LABS_SECRET_ID
 *   GEMINI_API_KEY or GEMINI_SECRET_ID
 *   TABLE_NAME / ASSETS_TABLE (for --from-asset)
 *   JOCKEY_COMPACT_RECAP_ENABLED=true (optional; script forces Jockey path)
 *
 * Examples:
 *   npm run jockey:eval -- compact --from-asset <uuid>
 *   npm run jockey:eval -- recap --from-asset <uuid> --user-instructions "Focus on Murdoch arc"
 */

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { TwelveLabs } from "twelvelabs-js";
import { createTwelveLabsWrapper } from "../services/twelvelabs";
import { generateSegmentsWithJockey } from "../services/storyiq/jockey-pipeline";
import { Purpose } from "../services/storyiq/types";
import { fetchTranscriptFromS3 } from "../utils/transcript";
import { assertAcceptanceCriteria } from "../services/storyiq/jockey/coverage";

function printHelp(): void {
  console.log(`
Jockey pipeline local eval

  npm run jockey:eval -- compact --from-asset <qlio-asset-uuid>
  npm run jockey:eval -- recap --from-asset <uuid> [--user-instructions "..."] [--target-seconds 75]

Flags:
  --from-asset           Qlio asset UUID (loads Dynamo + transcript S3)
  --user-instructions    Producer prompt
  --target-seconds       Target runtime (compact % ignored here)
  --video-duration       Override duration when asset record lacks it
`);
}

function parseArgs(argv: string[]): {
  flags: Record<string, string | undefined>;
  positionals: string[];
} {
  const positionals: string[] = [];
  const flags: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      flags.help = "1";
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
      continue;
    }
    positionals.push(a);
  }
  return { flags, positionals };
}

function assetsTableName(): string {
  const t = process.env.ASSETS_TABLE?.trim() || process.env.TABLE_NAME?.trim();
  if (!t) {
    throw new Error("Set TABLE_NAME or ASSETS_TABLE for --from-asset");
  }
  return t;
}

async function resolveSecret(envKey: string, secretIdEnv: string): Promise<string> {
  const direct = process.env[envKey]?.trim();
  if (direct) return direct;

  const secretId = process.env[secretIdEnv]?.trim();
  if (!secretId) {
    throw new Error(`Set ${envKey} or ${secretIdEnv}`);
  }

  const client = new SecretsManagerClient({});
  const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!res.SecretString) {
    throw new Error(`Empty secret: ${secretId}`);
  }
  return res.SecretString;
}

async function loadAsset(assetId: string): Promise<{
  assetId: string;
  title: string;
  duration: number;
  transcriptS3Uri?: string;
}> {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const res = await doc.send(
    new GetCommand({ TableName: assetsTableName(), Key: { assetId } }),
  );
  if (!res.Item) {
    throw new Error(`Asset not found: ${assetId}`);
  }

  const item = res.Item;
  const title =
    (typeof item.title === "string" && item.title.trim()) ||
    (typeof item.originalName === "string" && item.originalName.trim()) ||
    "Untitled Video";
  const duration = typeof item.duration === "number" ? item.duration : 0;
  const transcriptS3Uri =
    typeof item.transcriptionUrl === "string" ? item.transcriptionUrl : undefined;

  return { assetId, title, duration, transcriptS3Uri };
}

async function main(): Promise<void> {
  const { flags, positionals } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    return;
  }

  const mode = positionals[0];
  if (mode !== "compact" && mode !== "recap") {
    printHelp();
    throw new Error("First positional must be 'compact' or 'recap'");
  }

  const assetId = flags["from-asset"];
  if (!assetId) {
    throw new Error("--from-asset is required");
  }

  process.env.JOCKEY_COMPACT_RECAP_ENABLED = "true";

  const twelveLabsKey = await resolveSecret("TWELVE_LABS_API_KEY", "TWELVE_LABS_SECRET_ID");
  const geminiKey = await resolveSecret("GEMINI_API_KEY", "GEMINI_SECRET_ID");

  const asset = await loadAsset(assetId);
  const duration =
    Number(flags["video-duration"]) > 0
      ? Number(flags["video-duration"])
      : asset.duration;

  if (duration <= 0) {
    throw new Error("Video duration unknown — pass --video-duration");
  }

  if (!asset.transcriptS3Uri) {
    throw new Error("Asset has no transcriptionUrl in Dynamo");
  }

  const transcript = await fetchTranscriptFromS3(asset.transcriptS3Uri);
  const purpose = mode === "recap" ? Purpose.EPISODE_RECAP : Purpose.COMPACT_VIDEO;
  const targetDuration = flags["target-seconds"]
    ? Number(flags["target-seconds"])
    : undefined;

  const twelvelabs = createTwelveLabsWrapper(
    twelveLabsKey,
    assetsTableName(),
    process.env.TWELVE_LABS_INDEX_ID,
  );

  console.log(
    `[jockey:eval] ${mode} on ${assetId} (${Math.round(duration)}s, ${transcript.length} transcript segments)`,
  );

  const result = await generateSegmentsWithJockey(twelvelabs, {
    metadata: {
      assetId,
      duration,
      title: asset.title,
    },
    transcript,
    purpose,
    targetDuration,
    userInstructions: flags["user-instructions"],
    geminiApiKey: geminiKey,
    maxPollWaitMs: 3_600_000,
  });

  const segments = result.segments;
  const totalSec = segments.reduce((s, seg) => s + (seg.endTime - seg.startTime), 0);

  console.log("\n--- Segments ---");
  for (const seg of segments) {
    const mid = (seg.startTime + seg.endTime) / 2;
    console.log(
      `  [${seg.startTime.toFixed(1)}–${seg.endTime.toFixed(1)}s] mid=${mid.toFixed(0)}s | ${seg.title}`,
    );
    if (seg.reasoning) console.log(`    ${seg.reasoning}`);
  }

  console.log(
    `\nTotal: ${segments.length} segments, ~${Math.round(totalSec)}s, attempts=${result.attempts}`,
  );
  console.log("Notes:", result.notes.join(" | "));

  const acceptance = assertAcceptanceCriteria(
    segments,
    duration,
    purpose === Purpose.EPISODE_RECAP
      ? Purpose.EPISODE_RECAP
      : Purpose.COMPACT_VIDEO,
  );

  if (acceptance.passed) {
    console.log("\n✓ Acceptance criteria passed");
  } else {
    console.error("\n✗ Acceptance criteria failed:");
    for (const issue of acceptance.issues) {
      console.error(`  - ${issue}`);
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
